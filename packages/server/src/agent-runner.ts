import {
  Agent,
  Session,
  buildSystemPrompt,
  getDefaultSystemPrompt,
} from "@molf-ai/agent-core";
import type {
  SerializedSession,
  Tool,
  JSONSchema,
  SessionMessage as AgentCoreSessionMessage,
  LLMConfig,
  BehaviorConfig,
  AgentEvent as AgentCoreEvent,
} from "@molf-ai/agent-core";
import type { AgentEvent, SessionMessage, AgentStatus } from "@molf-ai/protocol";
import type { SessionFile, ToolCall as ProtocolToolCall } from "@molf-ai/protocol";
import type { SessionManager } from "./session-mgr.js";
import type { EventBus } from "./event-bus.js";
import type { ConnectionRegistry, WorkerRegistration } from "./connection-registry.js";
import type { ToolDispatch } from "./tool-dispatch.js";

// --- Typed error classes for structured error handling ---

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

export class AgentBusyError extends Error {
  constructor() {
    super("Agent is already processing a prompt");
    this.name = "AgentBusyError";
  }
}

export class WorkerDisconnectedError extends Error {
  constructor(workerId?: string) {
    super(workerId ? `Worker ${workerId} is disconnected` : "Bound worker is disconnected");
    this.name = "WorkerDisconnectedError";
  }
}

// --- ToolCall format converters ---
// agent-core ToolCall (@tanstack/ai): { id, type: "function", function: { name, arguments: string } }
// protocol ToolCall: { toolCallId, toolName, args: Record<string, unknown> }

interface AgentCoreToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Convert protocol ToolCall to @tanstack/ai ToolCall (for session → LLM) */
function toAgentCoreToolCall(tc: ProtocolToolCall): AgentCoreToolCall {
  return {
    id: tc.toolCallId,
    type: "function",
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.args),
    },
  };
}

/** Convert @tanstack/ai ToolCall to protocol ToolCall (for persistence) */
function toProtocolToolCall(tc: AgentCoreToolCall): ProtocolToolCall {
  return {
    toolCallId: tc.id,
    toolName: tc.function.name,
    args: JSON.parse(tc.function.arguments || "{}"),
  };
}

interface ActiveSession {
  agent: Agent;
  sessionId: string;
  workerId: string;
  abortController: AbortController | null;
  status: AgentStatus;
}

/**
 * Build the final system prompt for an agent session.
 * When skills exist, adds a hint about the skill tool instead of injecting full content.
 */
export function buildAgentSystemPrompt(
  worker: WorkerRegistration,
  sessionConfig?: { behavior?: Record<string, unknown> },
): string {
  const skillHint =
    worker.skills.length > 0
      ? "You have a 'skill' tool available. Use it to load detailed instructions for specialized tasks."
      : undefined;

  const instructions = worker.metadata?.agentsDoc as string | undefined;

  return buildSystemPrompt(getDefaultSystemPrompt(), instructions, skillHint);
}

/**
 * Build a server-local "skill" tool that lets the LLM load skill content on demand.
 * Returns null if the worker has no skills.
 */
export function buildSkillTool(worker: WorkerRegistration): Tool<JSONSchema> | null {
  if (worker.skills.length === 0) return null;

  const skillMap = new Map(worker.skills.map((s) => [s.name, s]));
  const skillNames = worker.skills.map((s) => s.name);

  const descriptionLines = worker.skills.map(
    (s) => `  <skill name="${s.name}">${s.description || s.name}</skill>`,
  );
  const description = `Load detailed instructions for a skill.\n<skills>\n${descriptionLines.join("\n")}\n</skills>`;

  const inputSchema: JSONSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        enum: skillNames,
        description: "The skill to load",
      },
    },
    required: ["name"],
  };

  return {
    name: "skill",
    description,
    inputSchema,
    execute: async (args: unknown) => {
      const { name } = args as { name: string };
      const skill = skillMap.get(name);
      if (!skill) {
        return { error: `Unknown skill "${name}". Available skills: ${skillNames.join(", ")}` };
      }
      return { content: skill.content };
    },
  };
}

export class AgentRunner {
  private activeSessions = new Map<string, ActiveSession>();

  constructor(
    private sessionMgr: SessionManager,
    private eventBus: EventBus,
    private connectionRegistry: ConnectionRegistry,
    private toolDispatch: ToolDispatch,
  ) {}

  getStatus(sessionId: string): AgentStatus {
    return this.activeSessions.get(sessionId)?.status ?? "idle";
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const sessionFile = this.sessionMgr.load(sessionId);
    if (!sessionFile) {
      throw new SessionNotFoundError(sessionId);
    }

    const existing = this.activeSessions.get(sessionId);
    if (existing && (existing.status === "streaming" || existing.status === "executing_tool")) {
      throw new AgentBusyError();
    }

    // Check worker is connected
    const worker = this.connectionRegistry.getWorker(sessionFile.workerId);
    if (!worker) {
      throw new WorkerDisconnectedError(sessionFile.workerId);
    }

    // Build agent with remote tools from the worker
    const tools = this.buildRemoteTools(worker, sessionFile.workerId);

    // Add server-local skill tool if worker has skills
    const skillTool = buildSkillTool(worker);
    if (skillTool) {
      tools.push(skillTool);
    }

    // Build system prompt from worker skills
    const systemPrompt = buildAgentSystemPrompt(worker, sessionFile.config);

    // Create agent with existing session history, converting protocol toolCalls to agent-core format
    const serialized: SerializedSession = {
      messages: sessionFile.messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        ...(msg.toolCalls && { toolCalls: msg.toolCalls.map(toAgentCoreToolCall) }),
        ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
      })),
    };
    const session = Session.deserialize(serialized);
    const agent = new Agent(
      {
        behavior: {
          ...(sessionFile.config?.behavior as Partial<BehaviorConfig>),
          systemPrompt,
        },
        llm: sessionFile.config?.llm as Partial<LLMConfig>,
      },
      session,
    );

    // Register tools
    for (const tool of tools) {
      agent.registerTool(tool);
    }

    const messageId = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    // Add user message to session file
    const userMessage: SessionMessage = {
      id: messageId,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.sessionMgr.addMessage(sessionId, userMessage);

    // Set up active session tracking
    const activeSession: ActiveSession = {
      agent,
      sessionId,
      workerId: sessionFile.workerId,
      abortController: null,
      status: "idle",
    };
    this.activeSessions.set(sessionId, activeSession);

    // Subscribe to agent events and forward to event bus
    agent.onEvent((event) => {
      const mapped = this.mapAgentEvent(event);
      if (mapped) {
        this.eventBus.emit(sessionId, mapped);

        if (mapped.type === "status_change") {
          activeSession.status = mapped.status;
        }
      }
    });

    // Run prompt asynchronously
    this.runPrompt(activeSession, text).catch((err) => {
      this.eventBus.emit(sessionId, {
        type: "error",
        code: "AGENT_ERROR",
        message: err instanceof Error ? err.message : String(err),
        context: { sessionId },
      });
    });

    return { messageId };
  }

  abort(sessionId: string): boolean {
    const active = this.activeSessions.get(sessionId);
    if (!active) return false;
    active.agent.abort();
    return true;
  }

  private async runPrompt(
    activeSession: ActiveSession,
    text: string,
  ): Promise<void> {
    try {
      await activeSession.agent.prompt(text);

      // Persist all intermediate messages (tool calls, tool results, final assistant)
      const newMessages = activeSession.agent.getLastPromptMessages();
      for (const msg of newMessages) {
        const sessionMsg: SessionMessage = {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          ...(msg.toolCalls && {
            toolCalls: msg.toolCalls.map(toProtocolToolCall),
          }),
          ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
        };
        this.sessionMgr.addMessage(activeSession.sessionId, sessionMsg);
      }
      this.sessionMgr.save(activeSession.sessionId);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || activeSession.status === "aborted")
      ) {
        // Abort is expected, already handled by agent events
        return;
      }
      throw err;
    }
  }

  private buildRemoteTools(
    worker: WorkerRegistration,
    workerId: string,
  ): Tool<JSONSchema>[] {
    return worker.tools.map((toolInfo): Tool<JSONSchema> => ({
      name: toolInfo.name,
      description: toolInfo.description,
      inputSchema: toolInfo.inputSchema as JSONSchema,
      execute: async (args: unknown) => {
        const toolCallId = `tc_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

        const { result, error } = await this.toolDispatch.dispatch(workerId, {
          toolCallId,
          toolName: toolInfo.name,
          args: (args ?? {}) as Record<string, unknown>,
        });

        if (error) {
          throw new Error(error);
        }

        return result;
      },
    }));
  }

  private mapAgentEvent(event: AgentCoreEvent): AgentEvent | null {
    switch (event.type) {
      case "status_change":
        return { type: "status_change", status: event.status };
      case "content_delta":
        return {
          type: "content_delta",
          delta: event.delta,
          content: event.content,
        };
      case "tool_call_start":
        return {
          type: "tool_call_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
        };
      case "tool_call_end":
        return {
          type: "tool_call_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
        };
      case "turn_complete":
        return {
          type: "turn_complete",
          message: {
            id: event.message.id,
            role: event.message.role,
            content: event.message.content,
            timestamp: event.message.timestamp,
          },
        };
      case "error":
        return {
          type: "error",
          code: "AGENT_ERROR",
          message: event.error?.message ?? "Unknown error",
        };
      default:
        return null;
    }
  }
}
