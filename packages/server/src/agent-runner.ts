import {
  Agent,
  Session,
  buildSystemPrompt,
  getDefaultSystemPrompt,
} from "@molf-ai/agent-core";
import type { SerializedSession, Tool } from "@molf-ai/agent-core";
import type { AgentEvent, SessionMessage, AgentStatus } from "@molf-ai/protocol";
import type { SessionFile } from "@molf-ai/protocol";
import type { SessionManager } from "./session-mgr.js";
import type { EventBus } from "./event-bus.js";
import type { ConnectionRegistry, WorkerRegistration } from "./connection-registry.js";
import type { ToolDispatch } from "./tool-dispatch.js";

interface ActiveSession {
  agent: Agent;
  sessionId: string;
  workerId: string;
  abortController: AbortController | null;
  status: AgentStatus;
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
      throw new Error(`Session ${sessionId} not found`);
    }

    const existing = this.activeSessions.get(sessionId);
    if (existing && (existing.status === "streaming" || existing.status === "executing_tool")) {
      throw new Error("Agent is already processing a prompt");
    }

    // Check worker is connected
    const worker = this.connectionRegistry.getWorker(sessionFile.workerId);
    if (!worker) {
      throw new Error("Bound worker is disconnected");
    }

    // Build agent with remote tools from the worker
    const tools = this.buildRemoteTools(worker, sessionFile.workerId);

    // Build system prompt from worker skills and AGENTS.md
    const skillDocs = worker.skills
      .map((s) => `## Skill: ${s.name}\n${s.content}`)
      .join("\n\n");
    const systemPrompt = buildSystemPrompt(
      getDefaultSystemPrompt(),
      skillDocs || undefined,
    );

    // Create agent with existing session history
    const serialized: SerializedSession = {
      messages: sessionFile.messages as any,
    };
    const session = Session.deserialize(serialized);
    const agent = new Agent(
      {
        behavior: {
          systemPrompt,
          ...(sessionFile.config?.behavior as any),
        },
        llm: sessionFile.config?.llm as any,
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
      const result = await activeSession.agent.prompt(text);

      // Add assistant message to session file
      const assistantMessage: SessionMessage = {
        id: result.id,
        role: "assistant",
        content: result.content,
        timestamp: result.timestamp,
      };
      this.sessionMgr.addMessage(activeSession.sessionId, assistantMessage);
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
  ): Tool[] {
    return worker.tools.map((toolInfo): Tool => ({
      name: toolInfo.name,
      description: toolInfo.description,
      inputSchema: toolInfo.inputSchema as any,
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

  private mapAgentEvent(event: any): AgentEvent | null {
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
