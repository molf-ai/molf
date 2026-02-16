import {
  Agent,
  Session,
  buildSystemPrompt,
  getDefaultSystemPrompt,
} from "@molf-ai/agent-core";
import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type {
  SerializedSession,
  LLMConfig,
  BehaviorConfig,
  AgentEvent as AgentCoreEvent,
  SessionMessage as AgentCoreSessionMessage,
  ResolvedAttachment,
} from "@molf-ai/agent-core";
import { isBinaryResult } from "@molf-ai/protocol";
import type { AgentEvent, SessionMessage, AgentStatus, FileRef } from "@molf-ai/protocol";
import type { SessionManager } from "./session-mgr.js";
import type { EventBus } from "./event-bus.js";
import type { ConnectionRegistry, WorkerRegistration } from "./connection-registry.js";
import type { ToolDispatch } from "./tool-dispatch.js";
import type { InlineMediaCache } from "./inline-media-cache.js";

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

interface ActiveSession {
  agent: Agent;
  sessionId: string;
  workerId: string;
  abortController: AbortController | null;
  status: AgentStatus;
}

const MEDIA_HINT = [
  "Users can attach files to messages. Attached files are saved in .molf/uploads/ within your working directory.",
  "Images are shown to you inline. Non-image files (PDFs, documents, audio) appear as text references.",
  "To view non-image file contents, use the read_file tool with the file path.",
  "The read_file tool can read binary files (images, PDFs, audio) and show you their contents.",
  "Uploaded files persist in the workspace and can be used by shell commands, scripts, and other tools.",
  "Video files cannot be viewed inline — use shell_exec with ffmpeg or similar tools.",
].join(" ");

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

  const workdir = worker.metadata?.workdir as string | undefined;
  const workdirHint = workdir
    ? `Your working directory is: ${workdir}\nAll relative file paths and shell commands will execute relative to this directory.`
    : undefined;

  const hasReadFile = worker.tools.some((t) => t.name === "read_file");
  const mediaHint = hasReadFile ? MEDIA_HINT : undefined;

  return buildSystemPrompt(getDefaultSystemPrompt(), instructions, skillHint, workdirHint, mediaHint);
}

/**
 * Build a server-local "skill" tool that lets the LLM load skill content on demand.
 * Returns null if the worker has no skills, otherwise returns { name, toolDef } for registration.
 */
export function buildSkillTool(
  worker: WorkerRegistration,
): { name: string; toolDef: ToolSet[string] } | null {
  if (worker.skills.length === 0) return null;

  const skillMap = new Map(worker.skills.map((s) => [s.name, s]));
  const skillNames = worker.skills.map((s) => s.name);

  const descriptionLines = worker.skills.map(
    (s) => `  <skill name="${s.name}">${s.description || s.name}</skill>`,
  );
  const description = `Load detailed instructions for a skill.\n<skills>\n${descriptionLines.join("\n")}\n</skills>`;

  return {
    name: "skill",
    toolDef: tool({
      description,
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: skillNames,
            description: "The skill to load",
          },
        },
        required: ["name"],
      }),
      execute: async (args: unknown) => {
        const { name } = args as { name: string };
        const skill = skillMap.get(name);
        if (!skill) {
          return { error: `Unknown skill "${name}". Available skills: ${skillNames.join(", ")}` };
        }
        return { content: skill.content };
      },
    }),
  };
}

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml",
]);

function binaryToModelOutput(output: unknown) {
  if (!isBinaryResult(output)) {
    return { type: "json" as const, value: output };
  }

  const { data, mimeType, path, size } = output;
  const meta = `path: ${path}, type: ${mimeType}, size: ${size} bytes`;

  if (IMAGE_MIMES.has(mimeType)) {
    return { type: "content" as const, value: [
      { type: "text" as const, text: `[Binary file: ${meta}]` },
      { type: "image-data" as const, data, mediaType: mimeType },
    ]};
  }
  return { type: "content" as const, value: [
    { type: "text" as const, text: `[Binary file: ${meta}]` },
    { type: "file-data" as const, data, mediaType: mimeType },
  ]};
}

export class AgentRunner {
  private activeSessions = new Map<string, ActiveSession>();

  constructor(
    private sessionMgr: SessionManager,
    private eventBus: EventBus,
    private connectionRegistry: ConnectionRegistry,
    private toolDispatch: ToolDispatch,
    private defaultLlm: { provider: string; model: string },
    private inlineMediaCache: InlineMediaCache,
  ) {}

  getStatus(sessionId: string): AgentStatus {
    return this.activeSessions.get(sessionId)?.status ?? "idle";
  }

  async prompt(
    sessionId: string,
    text: string,
    fileRefs?: Array<{ path: string; mimeType: string }>,
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

    // Build remote tools from worker
    const remoteTools = this.buildRemoteTools(worker, sessionFile.workerId);

    // Add server-local skill tool if worker has skills
    const skillTool = buildSkillTool(worker);
    if (skillTool) {
      remoteTools[skillTool.name] = skillTool.toolDef;
    }

    // Build system prompt from worker skills
    const systemPrompt = buildAgentSystemPrompt(worker, sessionFile.config);

    // Create agent with existing session history, resolving file refs at runtime
    const resolvedMessages = this.resolveSessionMessages(sessionFile.messages);
    const serialized: SerializedSession = { messages: resolvedMessages };
    const session = Session.deserialize(serialized);
    const mergedLlm = { ...this.defaultLlm, ...(sessionFile.config?.llm as Partial<LLMConfig>) };
    const agent = new Agent(
      {
        behavior: {
          ...(sessionFile.config?.behavior as Partial<BehaviorConfig>),
          systemPrompt,
        },
        llm: mergedLlm,
      },
      session,
    );

    // Register tools
    agent.registerTools(remoteTools);

    const messageId = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    // Persist user message with FileRefs
    const persistRefs: FileRef[] | undefined = fileRefs?.map((ref) => ({
      path: ref.path,
      mimeType: ref.mimeType,
    }));

    const userMessage: SessionMessage = {
      id: messageId,
      role: "user",
      content: text,
      timestamp: Date.now(),
      ...(persistRefs?.length ? { attachments: persistRefs } : {}),
    };
    this.sessionMgr.addMessage(sessionId, userMessage);

    // Resolve current turn's fileRefs: inline cached images, generate text hints for the rest
    let resolvedAttachments: ResolvedAttachment[] | undefined;
    let promptText = text;  // may get file hints prepended
    if (fileRefs?.length) {
      const inlined: ResolvedAttachment[] = [];
      const hintRefs: Array<{ path: string; mimeType: string }> = [];

      for (const ref of fileRefs) {
        if (ref.mimeType.startsWith("image/")) {
          const cached = this.inlineMediaCache.load(ref.path);
          if (cached) {
            inlined.push({ data: cached.buffer, mimeType: ref.mimeType });
            continue;
          }
        }
        hintRefs.push(ref);
      }

      if (inlined.length > 0) resolvedAttachments = inlined;
      if (hintRefs.length > 0) {
        const hints = hintRefs.map(
          (r) => `[Attached file: ${r.path}, ${r.mimeType}. Use read_file to access if needed.]`,
        );
        promptText = promptText
          ? `${hints.join("\n")}\n${promptText}`
          : hints.join("\n");
      }
    }

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
    this.runPrompt(activeSession, promptText, resolvedAttachments).catch((err) => {
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

  /**
   * Release session from memory if no clients are subscribed and no agent is running.
   * Idempotent — safe to call multiple times.
   */
  releaseIfIdle(sessionId: string): void {
    if (this.eventBus.hasListeners(sessionId)) return;
    if (this.activeSessions.has(sessionId)) return;
    this.sessionMgr.release(sessionId);
  }

  private async runPrompt(
    activeSession: ActiveSession,
    text: string,
    attachments?: ResolvedAttachment[],
  ): Promise<void> {
    try {
      await activeSession.agent.prompt(text, attachments);

      // Persist all intermediate messages (tool calls, tool results, final assistant)
      const newMessages = activeSession.agent.getLastPromptMessages();
      for (const msg of newMessages) {
        const sessionMsg: SessionMessage = {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
          ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
          ...(msg.toolName && { toolName: msg.toolName }),
        };
        this.sessionMgr.addMessage(activeSession.sessionId, sessionMsg);
      }
      this.sessionMgr.save(activeSession.sessionId);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || activeSession.status === "aborted")
      ) {
        return;
      }
      throw err;
    } finally {
      this.activeSessions.delete(activeSession.sessionId);
      this.releaseIfIdle(activeSession.sessionId);
    }
  }

  private resolveSessionMessages(
    messages: SessionMessage[],
  ): AgentCoreSessionMessage[] {
    return messages.map((msg) => {
      const base: AgentCoreSessionMessage = {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
        ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
        ...(msg.toolName && { toolName: msg.toolName }),
      };

      if (!msg.attachments?.length) return base;

      // Runtime inlining: split FileRefs into inlined images and non-inlined references
      const inlined: ResolvedAttachment[] = [];
      const fileRefs: FileRef[] = [];

      for (const ref of msg.attachments) {
        if (ref.mimeType.startsWith("image/")) {
          const cached = this.inlineMediaCache.load(ref.path);
          if (cached) {
            inlined.push({ data: cached.buffer, mimeType: ref.mimeType });
            continue;
          }
        }
        fileRefs.push(ref);
      }

      if (inlined.length > 0) base.attachments = inlined;
      if (fileRefs.length > 0) {
        // Append text references so the LLM sees non-inlined files.
        // Phase 4 will add first-class fileRefs support to agent-core's toModelMessages().
        const refs = fileRefs.map((r) => `[Attached file: ${r.path}, ${r.mimeType}. Use read_file to access if needed.]`);
        base.content = base.content
          ? `${refs.join("\n")}\n${base.content}`
          : refs.join("\n");
      }
      return base;
    });
  }

  private buildRemoteTools(
    worker: WorkerRegistration,
    workerId: string,
  ): ToolSet {
    const tools: ToolSet = {};
    for (const toolInfo of worker.tools) {
      tools[toolInfo.name] = tool({
        description: toolInfo.description,
        inputSchema: jsonSchema(toolInfo.inputSchema as any),
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
        toModelOutput({ output }) {
          return binaryToModelOutput(output);
        },
      });
    }
    return tools;
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
