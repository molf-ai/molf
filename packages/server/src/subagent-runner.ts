import {
  Agent,
  buildSystemPrompt,
  getDefaultSystemPrompt,
} from "@molf-ai/agent-core";
import type { ResolvedModel, AgentEvent as AgentCoreEvent } from "@molf-ai/agent-core";
import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import { errorMessage } from "@molf-ai/protocol";
import type { SessionMessage, BaseAgentEvent, ModelId } from "@molf-ai/protocol";
import { resolveAgentTypes } from "./subagent-types.js";
import type { ResolvedAgentType, Ruleset } from "./subagent-types.js";
import type { WorkerRegistration } from "./connection-registry.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { SessionManager } from "./session-mgr.js";
import type { EventBus } from "./event-bus.js";
import type { ApprovalGate } from "./approval/approval-gate.js";

export interface SubagentDeps {
  sessionMgr: SessionManager;
  eventBus: EventBus;
  connectionRegistry: ConnectionRegistry;
  approvalGate: ApprovalGate;
  buildRemoteTools: (
    worker: WorkerRegistration,
    workerId: string,
    sessionCtx?: { sessionId: string; loadedInstructions: Set<string> },
  ) => ToolSet;
  resolveModel: (modelId?: ModelId) => ResolvedModel;
  mapAgentEvent: (event: AgentCoreEvent) => BaseAgentEvent | null;
  buildRuntimeContext?: () => string;
}

export function buildSubagentSystemPrompt(
  worker: WorkerRegistration,
  typeConfig: ResolvedAgentType,
): string {
  const workdir = worker.metadata?.workdir;
  const workdirHint = workdir
    ? `Your working directory is: ${workdir}\nAll relative file paths and shell commands will execute relative to this directory.`
    : undefined;

  return buildSystemPrompt(
    getDefaultSystemPrompt(),
    workdirHint,
    typeConfig.systemPromptSuffix,
  );
}

export async function runSubagent(
  params: {
    parentSessionId: string;
    workerId: string;
    agentType: string;
    prompt: string;
    abortSignal?: AbortSignal;
  },
  deps: SubagentDeps,
): Promise<{ sessionId: string; result: string }> {
  const { parentSessionId, workerId, agentType, prompt, abortSignal } = params;

  const worker = deps.connectionRegistry.getWorker(workerId);
  if (!worker) throw new Error(`Worker ${workerId} not connected`);

  const agents = resolveAgentTypes(worker.agents ?? []);
  const typeConfig = agents.find(a => a.name === agentType);
  if (!typeConfig) throw new Error(`Unknown agent type: ${agentType}`);

  const parentSessionFile = deps.sessionMgr.load(parentSessionId);
  const childSession = await deps.sessionMgr.create({
    name: `@${typeConfig.name} subagent`,
    workerId,
    workspaceId: parentSessionFile?.workspaceId ?? "",
    metadata: {
      subagent: { parentSessionId, agentType },
    },
  });

  let unsubChild: (() => void) | undefined;
  try {
    deps.approvalGate.setAgentPermission(childSession.sessionId, typeConfig.permission);

    const childContext = {
      sessionId: childSession.sessionId,
      loadedInstructions: new Set<string>(),
    };
    const remoteTools = deps.buildRemoteTools(worker, workerId, childContext);

    const resolvedModel = deps.resolveModel();
    const systemPrompt = buildSubagentSystemPrompt(worker, typeConfig);

    const agent = new Agent(
      {
        behavior: {
          systemPrompt,
          maxSteps: typeConfig.maxSteps,
        },
      },
      resolvedModel,
    );
    agent.registerTools(remoteTools);
    if (deps.buildRuntimeContext) {
      agent.setRuntimeContext(deps.buildRuntimeContext());
    }

    agent.onEvent((event) => {
      const mapped = deps.mapAgentEvent(event);
      if (!mapped) return;
      deps.eventBus.emit(parentSessionId, {
        type: "subagent_event",
        agentType: typeConfig.name,
        sessionId: childSession.sessionId,
        event: mapped,
      });
    });

    unsubChild = deps.eventBus.subscribe(childSession.sessionId, (event: any) => {
      if (event.type === "tool_approval_required") {
        deps.eventBus.emit(parentSessionId, {
          type: "subagent_event",
          agentType: typeConfig.name,
          sessionId: childSession.sessionId,
          event,
        });
      }
    });

    const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => agent.abort();
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const finalMessage = await Promise.race([
        agent.prompt(prompt),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Subagent timeout")), SUBAGENT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);

      for (const msg of agent.getLastPromptMessages()) {
        const sessionMsg: SessionMessage = {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
          ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
          ...(msg.toolName && { toolName: msg.toolName }),
          ...(msg.usage && { usage: msg.usage }),
        };
        deps.sessionMgr.addMessage(childSession.sessionId, sessionMsg);
      }
      await deps.sessionMgr.save(childSession.sessionId);

      return { sessionId: childSession.sessionId, result: finalMessage.content };
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    }
  } finally {
    unsubChild?.();
    deps.approvalGate.clearSession(childSession.sessionId);
    await deps.sessionMgr.release(childSession.sessionId);
  }
}

export function buildTaskTool(
  sessionId: string,
  workerId: string,
  agents: ResolvedAgentType[],
  runSubagentFn: (params: {
    parentSessionId: string;
    workerId: string;
    agentType: string;
    prompt: string;
    abortSignal?: AbortSignal;
  }) => Promise<{ sessionId: string; result: string }>,
): { name: string; toolDef: ToolSet[string] } | null {
  if (agents.length === 0) return null;

  const agentNames = agents.map(a => a.name);
  const agentDescriptions = agents.map(a => `- "${a.name}": ${a.description}`).join("\n");

  return {
    name: "task",
    toolDef: tool({
      description: [
        "Spawn a subagent to handle a task autonomously.",
        "The subagent runs in its own session with its own context.",
        "",
        "Available agents:",
        agentDescriptions,
        "",
        "Use when a task can be decomposed. You can call task multiple times in one turn for parallel execution.",
      ].join("\n"),
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Short 3-5 word description",
          },
          prompt: {
            type: "string",
            description: "Detailed instructions for the subagent",
          },
          agentType: {
            type: "string",
            enum: agentNames,
            description: "Which agent to use",
          },
        },
        required: ["description", "prompt", "agentType"],
      }),
      execute: async (args: unknown, { abortSignal }: { abortSignal?: AbortSignal }) => {
        const { description, prompt, agentType } = (args ?? {}) as {
          description: string;
          prompt: string;
          agentType: string;
        };
        try {
          const { sessionId: childId, result } = await runSubagentFn({
            parentSessionId: sessionId,
            workerId,
            agentType,
            prompt,
            abortSignal,
          });
          return [
            `<task_result agent="${agentType}" task="${description}" session="${childId}">`,
            result,
            "</task_result>",
          ].join("\n");
        } catch (err) {
          return `<task_error agent="${agentType}" task="${description}">${errorMessage(err)}</task_error>`;
        }
      },
    }),
  };
}
