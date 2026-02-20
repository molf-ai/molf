import {
  Agent,
  Session,
  buildSystemPrompt,
  getDefaultSystemPrompt,
  createDefaultRegistry,
} from "@molf-ai/agent-core";
import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type {
  SerializedSession,
  AgentEvent as AgentCoreEvent,
  SessionMessage as AgentCoreSessionMessage,
  ResolvedAttachment,
} from "@molf-ai/agent-core";
import { isBinaryResult, errorMessage, truncateOutput } from "@molf-ai/protocol";
import type { AgentEvent, SessionMessage, SessionFile, AgentStatus, FileRef, LLMConfig, BehaviorConfig, JsonValue } from "@molf-ai/protocol";
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

interface CachedSession {
  agent: Agent;
  sessionId: string;
  workerId: string;
  status: AgentStatus;
  lastActiveAt: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
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
  sessionConfig?: { behavior?: Partial<BehaviorConfig> },
): string {
  const skillHint =
    worker.skills.length > 0
      ? "You have a 'skill' tool available. Use it to load detailed instructions for specialized tasks."
      : undefined;

  const instructions = worker.metadata?.agentsDoc;

  const workdir = worker.metadata?.workdir;
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
    return { type: "json" as const, value: output as JsonValue };
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

/** Per-turn timeout: 10 minutes. Catches hung tool calls, network stalls, etc. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** Idle agent eviction: 30 minutes of inactivity. */
const IDLE_EVICTION_MS = 30 * 60 * 1000;

export class AgentRunner {
  private cachedSessions = new Map<string, CachedSession>();
  private providerRegistry = createDefaultRegistry();
  /** Truncation metadata stashed by remote tool execute, consumed by mapAgentEvent for tool_call_end */
  private truncationMeta = new Map<string, { truncated?: boolean; outputId?: string }>();

  constructor(
    private sessionMgr: SessionManager,
    private eventBus: EventBus,
    private connectionRegistry: ConnectionRegistry,
    private toolDispatch: ToolDispatch,
    private defaultLlm: { provider: string; model: string },
    private inlineMediaCache: InlineMediaCache,
  ) {}

  getStatus(sessionId: string): AgentStatus {
    return this.cachedSessions.get(sessionId)?.status ?? "idle";
  }

  async prompt(
    sessionId: string,
    text: string,
    fileRefs?: Array<{ path: string; mimeType: string }>,
  ): Promise<{ messageId: string }> {
    // 1. Validate
    const sessionFile = this.sessionMgr.load(sessionId);
    if (!sessionFile) {
      throw new SessionNotFoundError(sessionId);
    }

    const cached = this.cachedSessions.get(sessionId);
    if (cached && (cached.status === "streaming" || cached.status === "executing_tool")) {
      throw new AgentBusyError();
    }

    const worker = this.connectionRegistry.getWorker(sessionFile.workerId);
    if (!worker) {
      throw new WorkerDisconnectedError(sessionFile.workerId);
    }

    // 2. Prepare agent, tools, system prompt, and resolve attachments
    const { activeSession, promptText, resolvedAttachments } =
      this.prepareAgentRun(sessionId, sessionFile, worker, text, fileRefs);

    // 3. Persist user message with FileRefs
    const messageId = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
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

    // 4. Fire prompt asynchronously
    this.runPrompt(activeSession, promptText, resolvedAttachments).catch((err) => {
      // Skip re-emitting if Agent already emitted an error event
      if (activeSession.status === "error") return;
      this.eventBus.emit(sessionId, {
        type: "error",
        code: "AGENT_ERROR",
        message: errorMessage(err),
        context: { sessionId },
      });
    });

    return { messageId };
  }

  abort(sessionId: string): boolean {
    const cached = this.cachedSessions.get(sessionId);
    if (!cached) return false;
    const status = cached.agent.getStatus();
    if (status !== "streaming" && status !== "executing_tool") return false;
    cached.agent.abort();
    return true;
  }

  /**
   * Inject a shell execution result into the session as synthetic messages.
   * Creates a user + assistant (with tool call) + tool result triplet, all marked synthetic.
   * No events emitted — avoids duplicate display in clients.
   */
  injectShellResult(sessionId: string, command: string, resultContent: string): void {
    const toolCallId = `se_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const userMsg: SessionMessage = {
      id: `msg_${now}_${crypto.randomUUID().slice(0, 8)}`,
      role: "user",
      content: "The following tool was executed by the user",
      timestamp: now,
      synthetic: true,
    };

    const assistantMsg: SessionMessage = {
      id: `msg_${now + 1}_${crypto.randomUUID().slice(0, 8)}`,
      role: "assistant",
      content: "",
      toolCalls: [{ toolCallId, toolName: "shell_exec", args: { command } }],
      timestamp: now + 1,
      synthetic: true,
    };

    const toolMsg: SessionMessage = {
      id: `msg_${now + 2}_${crypto.randomUUID().slice(0, 8)}`,
      role: "tool",
      content: resultContent,
      toolCallId,
      toolName: "shell_exec",
      timestamp: now + 2,
      synthetic: true,
    };

    // Persist to SessionManager
    this.sessionMgr.addMessage(sessionId, userMsg);
    this.sessionMgr.addMessage(sessionId, assistantMsg);
    this.sessionMgr.addMessage(sessionId, toolMsg);

    // Inject into cached Agent's in-memory Session (if exists)
    // Session.addMessage generates its own id/timestamp — that's fine since
    // SessionManager has the authoritative copies.
    const cached = this.cachedSessions.get(sessionId);
    if (cached) {
      const session = cached.agent.getSession();
      session.addMessage({
        role: userMsg.role,
        content: userMsg.content,
      });
      session.addMessage({
        role: assistantMsg.role,
        content: assistantMsg.content,
        toolCalls: assistantMsg.toolCalls,
      });
      session.addMessage({
        role: toolMsg.role,
        content: toolMsg.content,
        toolCallId: toolMsg.toolCallId,
        toolName: toolMsg.toolName,
      });
    }

    this.sessionMgr.save(sessionId);
  }

  /**
   * Evict a cached agent for a session (e.g., on session deletion).
   * Cancels any pending eviction timer and releases session resources.
   */
  evict(sessionId: string): void {
    const cached = this.cachedSessions.get(sessionId);
    if (!cached) return;
    this.cancelEviction(cached);
    const status = cached.agent.getStatus();
    if (status === "streaming" || status === "executing_tool") {
      cached.agent.abort();
    }
    this.cachedSessions.delete(sessionId);
    this.releaseIfIdle(sessionId);
  }

  /**
   * Release session from memory if no clients are subscribed and no agent is cached.
   * Idempotent — safe to call multiple times.
   */
  releaseIfIdle(sessionId: string): void {
    if (this.eventBus.hasListeners(sessionId)) return;
    if (this.cachedSessions.has(sessionId)) return;
    this.sessionMgr.release(sessionId);
  }

  /** Resolve a single file reference: inline image if cached, otherwise return a text hint. */
  private resolveFileRef(ref: { path: string; mimeType: string }): {
    inlined?: ResolvedAttachment;
    hint?: string;
  } {
    if (ref.mimeType.startsWith("image/")) {
      const cached = this.inlineMediaCache.load(ref.path);
      if (cached) {
        return { inlined: { data: cached.buffer, mimeType: ref.mimeType } };
      }
    }
    return { hint: `[Attached file: ${ref.path}, ${ref.mimeType}. Use read_file to access if needed.]` };
  }

  /** Prepare agent for a prompt: get/create agent, refresh tools+prompt, resolve attachments. */
  private prepareAgentRun(
    sessionId: string,
    sessionFile: SessionFile,
    worker: WorkerRegistration,
    text: string,
    fileRefs?: Array<{ path: string; mimeType: string }>,
  ): { activeSession: CachedSession; promptText: string; resolvedAttachments?: ResolvedAttachment[] } {
    // Build remote tools from worker (always refresh — cheap operation)
    const remoteTools = this.buildRemoteTools(worker, sessionFile.workerId);
    const skillTool = buildSkillTool(worker);
    if (skillTool) {
      remoteTools[skillTool.name] = skillTool.toolDef;
    }

    // Build system prompt (always refresh — cheap operation)
    const systemPrompt = buildAgentSystemPrompt(worker, sessionFile.config);

    // Get or create the agent for this session
    const cached = this.cachedSessions.get(sessionId);
    let activeSession: CachedSession;
    if (cached) {
      cached.agent.replaceTools(remoteTools);
      cached.agent.setSystemPrompt(systemPrompt);
      activeSession = cached;
    } else {
      const resolvedMessages = this.resolveSessionMessages(sessionFile.messages);
      const serialized: SerializedSession = { messages: resolvedMessages };
      const session = Session.deserialize(serialized);
      const mergedLlm = { ...this.defaultLlm, ...sessionFile.config?.llm };
      const agent = new Agent(
        {
          behavior: { ...sessionFile.config?.behavior, systemPrompt },
          llm: mergedLlm,
        },
        session,
        this.providerRegistry,
      );

      agent.registerTools(remoteTools);

      activeSession = {
        agent,
        sessionId,
        workerId: sessionFile.workerId,
        status: "idle",
        lastActiveAt: Date.now(),
        evictionTimer: null,
      };
      this.cachedSessions.set(sessionId, activeSession);

      agent.onEvent((event) => {
        const mapped = this.mapAgentEvent(event);
        if (mapped) {
          this.eventBus.emit(sessionId, mapped);
          if (mapped.type === "status_change") {
            activeSession.status = mapped.status;
          }
        }
      });
    }

    this.cancelEviction(activeSession);
    activeSession.lastActiveAt = Date.now();

    // Resolve current turn's fileRefs
    let resolvedAttachments: ResolvedAttachment[] | undefined;
    let promptText = text;
    if (fileRefs?.length) {
      const inlined: ResolvedAttachment[] = [];
      const hints: string[] = [];
      for (const ref of fileRefs) {
        const resolved = this.resolveFileRef(ref);
        if (resolved.inlined) inlined.push(resolved.inlined);
        if (resolved.hint) hints.push(resolved.hint);
      }
      if (inlined.length > 0) resolvedAttachments = inlined;
      if (hints.length > 0) {
        promptText = promptText
          ? `${hints.join("\n")}\n${promptText}`
          : hints.join("\n");
      }
    }

    return { activeSession, promptText, resolvedAttachments };
  }

  private async runPrompt(
    activeSession: CachedSession,
    text: string,
    attachments?: ResolvedAttachment[],
  ): Promise<void> {
    const timer = setTimeout(() => {
      activeSession.agent.abort();
    }, TURN_TIMEOUT_MS);
    timer.unref?.();
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
      clearTimeout(timer);
      // Only schedule eviction if still in cache (evict() may have removed it)
      if (this.cachedSessions.has(activeSession.sessionId)) {
        this.scheduleEviction(activeSession);
      }
    }
  }

  /** Schedule idle eviction for a cached session. */
  private scheduleEviction(cached: CachedSession): void {
    this.cancelEviction(cached);
    cached.evictionTimer = setTimeout(() => {
      cached.evictionTimer = null;
      this.cachedSessions.delete(cached.sessionId);
      this.releaseIfIdle(cached.sessionId);
    }, IDLE_EVICTION_MS);
    cached.evictionTimer.unref?.();
  }

  /** Clear stale truncation metadata (e.g. on abort, turn_complete, error). */
  private clearTruncationMeta(): void {
    if (this.truncationMeta.size > 0) {
      this.truncationMeta.clear();
    }
  }

  /** Cancel a pending eviction timer. */
  private cancelEviction(cached: CachedSession): void {
    if (cached.evictionTimer) {
      clearTimeout(cached.evictionTimer);
      cached.evictionTimer = null;
    }
  }

  /**
   * Convert protocol SessionMessages to agent-core messages, resolving attachments.
   * For each message with attachments: inlines cached images as binary data,
   * and prepends text hints for non-inlineable files to the message content.
   */
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

      const inlined: ResolvedAttachment[] = [];
      const hints: string[] = [];
      for (const ref of msg.attachments) {
        const resolved = this.resolveFileRef(ref);
        if (resolved.inlined) inlined.push(resolved.inlined);
        if (resolved.hint) hints.push(resolved.hint);
      }

      if (inlined.length > 0) base.attachments = inlined;
      if (hints.length > 0) {
        base.content = base.content
          ? `${hints.join("\n")}\n${base.content}`
          : hints.join("\n");
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

          const { result, error, truncated, outputId } = await this.toolDispatch.dispatch(workerId, {
            toolCallId,
            toolName: toolInfo.name,
            args: (args ?? {}) as Record<string, unknown>,
          });

          // Stash truncation metadata for mapAgentEvent to attach to tool_call_end
          if (truncated || outputId) {
            this.truncationMeta.set(toolCallId, { truncated, outputId });
          }

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
      case "tool_call_end": {
        const meta = this.truncationMeta.get(event.toolCallId);
        if (meta) this.truncationMeta.delete(event.toolCallId);
        return {
          type: "tool_call_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          ...(meta?.truncated && { truncated: meta.truncated }),
          ...(meta?.outputId && { outputId: meta.outputId }),
        };
      }
      case "turn_complete":
        this.clearTruncationMeta();
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
        this.clearTruncationMeta();
        return {
          type: "error",
          code: "AGENT_ERROR",
          message: event.error?.message ?? "Unknown error",
        };
      default: {
        const _exhaustive: never = event;
        return null;
      }
    }
  }
}
