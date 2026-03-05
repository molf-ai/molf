import { getLogger } from "@logtape/logtape";
import {
  Agent,
  Session,
  buildSystemPrompt,
  getDefaultSystemPrompt,
} from "@molf-ai/agent-core";
import type {
  ProviderState,
  ResolvedModel,
} from "@molf-ai/agent-core";
import {
  resolveLanguageModel,
  getModel,
} from "@molf-ai/agent-core";
import type {
  SerializedSession,
  AgentEvent as AgentCoreEvent,
  ResolvedAttachment,
} from "@molf-ai/agent-core";
import { errorMessage, parseModelId, formatModelId } from "@molf-ai/protocol";
import type { BaseAgentEvent, SessionMessage, SessionFile, AgentStatus, FileRef, Attachment, ModelId } from "@molf-ai/protocol";
import { resolveAgentTypes } from "./subagent-types.js";
import type { ResolvedAgentType } from "./subagent-types.js";
import type { SessionManager } from "./session-mgr.js";
import type { EventBus } from "./event-bus.js";
import type { ConnectionRegistry, WorkerRegistration } from "./connection-registry.js";
import type { ToolDispatch } from "./tool-dispatch.js";
import type { InlineMediaCache } from "./inline-media-cache.js";
import type { ApprovalGate } from "./approval/approval-gate.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { shouldSummarize, performSummarization } from "./summarization.js";
import { MEDIA_HINT, resolveFileRef, resolveSessionMessages } from "./attachment-resolver.js";
import { buildSkillTool, buildRemoteTools } from "./tool-builder.js";
import { buildTaskTool, runSubagent } from "./subagent-runner.js";
import { buildCronTool } from "./cron/tool.js";
import type { CronService } from "./cron/service.js";
import { buildRuntimeContext } from "./runtime-context.js";
import type { CachedSession } from "./types.js";

const logger = getLogger(["molf", "server", "agent"]);

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

/**
 * Build the final system prompt for an agent session.
 * When skills exist, adds a hint about the skill tool instead of injecting full content.
 */
export function buildAgentSystemPrompt(
  worker: WorkerRegistration,
  resolvedAgents?: ResolvedAgentType[],
): string {
  const skillHint =
    worker.skills.length > 0
      ? "You have a 'skill' tool available. Use it to load detailed instructions for specialized tasks."
      : undefined;

  const agents = resolvedAgents ?? resolveAgentTypes(worker.agents ?? []);
  const agentHint = agents.length > 0
    ? "You have a 'task' tool to spawn subagents for parallel or specialized work."
    : undefined;

  const instructions = worker.metadata?.agentsDoc;

  const workdir = worker.metadata?.workdir;
  const workdirHint = workdir
    ? `Your working directory is: ${workdir}\nAll relative file paths and shell commands will execute relative to this directory.`
    : undefined;

  const hasReadFile = worker.tools.some((t) => t.name === "read_file");
  const mediaHint = hasReadFile ? MEDIA_HINT : undefined;

  return buildSystemPrompt(getDefaultSystemPrompt(), instructions, skillHint, agentHint, workdirHint, mediaHint);
}

/** Per-turn timeout: 30 minutes. Catches hung tool calls, network stalls, etc. */
const TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** Idle agent eviction: 30 minutes of inactivity. */
const IDLE_EVICTION_MS = 30 * 60 * 1000;

export class AgentRunner {
  private cachedSessions = new Map<string, CachedSession>();
  /** Truncation metadata stashed by remote tool execute, consumed by mapAgentEvent for tool_call_end */
  private truncationMeta = new Map<string, { truncated?: boolean; outputId?: string }>();
  /** Attachment data stashed by remote tool execute, consumed by toModelOutput (keyed by toolCallId) */
  private attachmentMeta = new Map<string, Attachment[]>();
  private cronService: CronService | null = null;

  constructor(
    private sessionMgr: SessionManager,
    private eventBus: EventBus,
    private connectionRegistry: ConnectionRegistry,
    private toolDispatch: ToolDispatch,
    private providerState: ProviderState,
    private defaultModel: ModelId,
    private inlineMediaCache: InlineMediaCache,
    private approvalGate: ApprovalGate,
    private workspaceStore: WorkspaceStore,
  ) {}

  /** Set the cron service (breaks circular dependency). */
  setCronService(service: CronService): void {
    this.cronService = service;
  }

  getStatus(sessionId: string): AgentStatus {
    return this.cachedSessions.get(sessionId)?.status ?? "idle";
  }

  /**
   * Wait for the current `runPrompt` cycle (persistence + summarization) to
   * complete. Returns immediately if no turn is in progress. Useful for
   * graceful shutdown and test synchronization.
   */
  async waitForTurn(sessionId: string): Promise<void> {
    await this.cachedSessions.get(sessionId)?.turnCompletion;
  }

  /** Shared deps for buildRemoteTools calls. */
  private toolBuilderDeps() {
    return {
      approvalGate: this.approvalGate,
      toolDispatch: this.toolDispatch,
      truncationMeta: this.truncationMeta,
      attachmentMeta: this.attachmentMeta,
    };
  }

  /** Resolve a combined ModelId to a ResolvedModel (LanguageModel + metadata). */
  private resolveModel(modelId?: ModelId): ResolvedModel {
    const id = modelId ?? this.defaultModel;
    const ref = parseModelId(id);
    const info = getModel(this.providerState, ref.providerID, ref.modelID);
    const language = resolveLanguageModel(this.providerState, info);
    return { language, info };
  }

  async prompt(
    sessionId: string,
    text: string,
    fileRefs?: Array<{ path: string; mimeType: string }>,
    modelId?: ModelId,
    options?: { synthetic?: boolean },
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

    // 2. Resolve model for this prompt (prompt-level > workspace config > server default)
    const workspace = await this.workspaceStore.get(sessionFile.workerId, sessionFile.workspaceId);
    const resolvedModel = this.resolveModel(modelId ?? workspace?.config?.model);

    // 3. Prepare agent, tools, system prompt, and resolve attachments
    const { activeSession, promptText, resolvedAttachments } =
      this.prepareAgentRun(sessionId, sessionFile, worker, text, resolvedModel, fileRefs);

    // 4. Persist user message with FileRefs
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
      ...(options?.synthetic ? { synthetic: true } : {}),
    };
    this.sessionMgr.addMessage(sessionId, userMessage);

    logger.debug("Prompt started", {
      sessionId,
      textLength: text.length,
      hasAttachments: !!fileRefs?.length,
      model: formatModelId({ providerID: resolvedModel.info.providerID, modelID: resolvedModel.info.id }),
    });

    // 5. Mark status synchronously to prevent concurrent prompt race
    activeSession.status = "streaming";

    // 6. Fire prompt asynchronously
    activeSession.turnCompletion = this.runPrompt(activeSession, promptText, resolvedAttachments, resolvedModel).catch((err) => {
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
  async injectShellResult(sessionId: string, command: string, resultContent: string): Promise<void> {
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
    const cachedSession = this.cachedSessions.get(sessionId);
    if (cachedSession) {
      const session = cachedSession.agent.getSession();
      session.addMessage({
        id: userMsg.id,
        timestamp: userMsg.timestamp,
        role: userMsg.role,
        content: userMsg.content,
        synthetic: userMsg.synthetic,
      });
      session.addMessage({
        id: assistantMsg.id,
        timestamp: assistantMsg.timestamp,
        role: assistantMsg.role,
        content: assistantMsg.content,
        toolCalls: assistantMsg.toolCalls,
        synthetic: assistantMsg.synthetic,
      });
      session.addMessage({
        id: toolMsg.id,
        timestamp: toolMsg.timestamp,
        role: toolMsg.role,
        content: toolMsg.content,
        toolCallId: toolMsg.toolCallId,
        toolName: toolMsg.toolName,
        synthetic: toolMsg.synthetic,
      });
    }

    await this.sessionMgr.save(sessionId);
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
    this.approvalGate.clearSession(sessionId);
    logger.debug("Agent evicted", { sessionId });
    this.releaseIfIdle(sessionId);
  }

  /**
   * Release session from memory if no clients are subscribed and no agent is cached.
   * Idempotent — safe to call multiple times.
   */
  async releaseIfIdle(sessionId: string): Promise<void> {
    if (this.eventBus.hasListeners(sessionId)) return;
    if (this.cachedSessions.has(sessionId)) return;
    await this.sessionMgr.release(sessionId);
  }

  /** Prepare agent for a prompt: get/create agent, refresh tools+prompt, resolve attachments. */
  private prepareAgentRun(
    sessionId: string,
    sessionFile: SessionFile,
    worker: WorkerRegistration,
    text: string,
    resolvedModel: ResolvedModel,
    fileRefs?: Array<{ path: string; mimeType: string }>,
  ): { activeSession: CachedSession; promptText: string; resolvedAttachments?: ResolvedAttachment[] } {
    // Resolve agents once — used for system prompt hint and task tool
    const agents = resolveAgentTypes(worker.agents ?? []);

    // Get or create the cached session first (needed for buildRemoteTools)
    const cached = this.cachedSessions.get(sessionId);
    let activeSession: CachedSession;
    if (cached) {
      activeSession = cached;
      // Update model for this prompt
      cached.agent.setModel(resolvedModel);
    } else {
      // Restore loadedInstructions from session metadata
      const savedPaths = sessionFile.metadata?.loadedInstructionPaths;
      const loadedInstructions = new Set<string>(
        Array.isArray(savedPaths) ? (savedPaths as string[]) : [],
      );

      const resolvedMessages = resolveSessionMessages(sessionFile.messages, this.inlineMediaCache);
      const serialized: SerializedSession = { messages: resolvedMessages };
      const session = Session.deserialize(serialized);
      const systemPrompt = buildAgentSystemPrompt(worker, agents);
      const agent = new Agent(
        {
          behavior: { systemPrompt },
        },
        resolvedModel,
        session,
      );

      activeSession = {
        agent,
        sessionId,
        workerId: sessionFile.workerId,
        status: "idle",
        lastActiveAt: Date.now(),
        evictionTimer: null,
        loadedInstructions,
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

    // Build remote tools from worker (always refresh — cheap operation)
    const remoteTools = buildRemoteTools(worker, sessionFile.workerId, this.toolBuilderDeps(), { sessionId: activeSession.sessionId, loadedInstructions: activeSession.loadedInstructions });
    const skillTool = buildSkillTool(worker, this.approvalGate, activeSession.sessionId, sessionFile.workerId);
    if (skillTool) {
      remoteTools[skillTool.name] = skillTool.toolDef;
    }
    const subagentDeps = this.subagentDeps();
    const taskTool = buildTaskTool(activeSession.sessionId, sessionFile.workerId, agents, (params) => runSubagent(params, subagentDeps));
    if (taskTool) {
      remoteTools[taskTool.name] = taskTool.toolDef;
    }
    if (this.cronService) {
      const cronTool = buildCronTool(this.cronService, sessionFile.workspaceId, sessionFile.workerId);
      remoteTools[cronTool.name] = cronTool.toolDef;
    }

    // Build system prompt (always refresh — cheap operation)
    const systemPrompt = buildAgentSystemPrompt(worker, agents);

    if (cached) {
      cached.agent.replaceTools(remoteTools);
      cached.agent.setSystemPrompt(systemPrompt);
    } else {
      activeSession.agent.registerTools(remoteTools);
    }

    activeSession.agent.setRuntimeContext(buildRuntimeContext());

    this.cancelEviction(activeSession);
    activeSession.lastActiveAt = Date.now();

    // Resolve current turn's fileRefs
    let resolvedAttachments: ResolvedAttachment[] | undefined;
    let promptText = text;
    if (fileRefs?.length) {
      const inlined: ResolvedAttachment[] = [];
      const hints: string[] = [];
      for (const ref of fileRefs) {
        const resolved = resolveFileRef(ref, this.inlineMediaCache);
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
    attachments: ResolvedAttachment[] | undefined,
    resolvedModel: ResolvedModel,
  ): Promise<void> {
    const startTime = performance.now();
    const timer = setTimeout(() => {
      logger.warn("Turn timed out", { sessionId: activeSession.sessionId });
      activeSession.agent.abort();
    }, TURN_TIMEOUT_MS);
    timer.unref?.();
    try {
      await activeSession.agent.prompt(text, attachments);

      // Guard: session may have been evicted/deleted during the async turn
      if (!this.cachedSessions.has(activeSession.sessionId)) return;

      // Stamp model on assistant messages and persist
      const modelId = formatModelId({
        providerID: resolvedModel.info.providerID,
        modelID: resolvedModel.info.id,
      });
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
          ...(msg.usage && { usage: msg.usage }),
          ...(msg.role === "assistant" && { model: modelId }),
        };
        this.sessionMgr.addMessage(activeSession.sessionId, sessionMsg);
      }

      // Persist loadedInstructions to session metadata
      if (activeSession.loadedInstructions.size > 0) {
        const sessionFile = this.sessionMgr.load(activeSession.sessionId);
        if (sessionFile) {
          sessionFile.metadata = {
            ...sessionFile.metadata,
            loadedInstructionPaths: [...activeSession.loadedInstructions],
          };
        }
      }

      await this.sessionMgr.save(activeSession.sessionId);

      // Update workspace lastSessionId so new clients default to the most recently prompted session
      const sf = this.sessionMgr.load(activeSession.sessionId);
      if (sf) {
        await this.workspaceStore.updateLastSession(sf.workerId, sf.workspaceId, activeSession.sessionId);
      }

      const durationMs = Math.round(performance.now() - startTime);
      const lastMsg = newMessages[newMessages.length - 1];
      logger.info("Turn completed", {
        sessionId: activeSession.sessionId,
        durationMs,
        steps: newMessages.filter((m) => m.role === "assistant").length,
        finishReason: lastMsg?.usage ? "stop" : "unknown",
        model: modelId,
      });

      // Stash resolved model for summarization
      activeSession.lastResolvedModel = resolvedModel;

      // Context summarization: use per-prompt context window
      const contextWindowTokens = resolvedModel.info.limit.context;
      const messages = this.sessionMgr.getMessages(activeSession.sessionId);
      if (!activeSession.summarizing && shouldSummarize(messages, contextWindowTokens)) {
        await performSummarization(activeSession, {
          sessionMgr: this.sessionMgr,
          eventBus: this.eventBus,
          getAgentSession: () => this.cachedSessions.get(activeSession.sessionId)?.agent.getSession(),
        });
      }
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
      this.approvalGate.clearSession(cached.sessionId);
      logger.debug("Agent idle-evicted", { sessionId: cached.sessionId });
      this.releaseIfIdle(cached.sessionId).catch((err) => {
        logger.warn("Failed to release idle session", { sessionId: cached.sessionId, error: err });
      });
    }, IDLE_EVICTION_MS);
    cached.evictionTimer.unref?.();
  }

  /** Clear stale sideband metadata (e.g. on abort, turn_complete, error). */
  private clearSidebandMeta(): void {
    if (this.truncationMeta.size > 0) {
      this.truncationMeta.clear();
    }
    if (this.attachmentMeta.size > 0) {
      this.attachmentMeta.clear();
    }
  }

  /** Cancel a pending eviction timer. */
  private cancelEviction(cached: CachedSession): void {
    if (cached.evictionTimer) {
      clearTimeout(cached.evictionTimer);
      cached.evictionTimer = null;
    }
  }

  /** Shared deps for runSubagent calls. */
  private subagentDeps() {
    return {
      sessionMgr: this.sessionMgr,
      eventBus: this.eventBus,
      connectionRegistry: this.connectionRegistry,
      approvalGate: this.approvalGate,
      buildRemoteTools: (worker: WorkerRegistration, workerId: string, sessionCtx?: { sessionId: string; loadedInstructions: Set<string> }) =>
        buildRemoteTools(worker, workerId, this.toolBuilderDeps(), sessionCtx),
      resolveModel: (modelId?: ModelId) => this.resolveModel(modelId),
      mapAgentEvent: (event: AgentCoreEvent) => this.mapAgentEvent(event),
    };
  }

  async runSubagent(params: {
    parentSessionId: string;
    workerId: string;
    agentType: string;
    prompt: string;
    abortSignal?: AbortSignal;
  }): Promise<{ sessionId: string; result: string }> {
    return runSubagent(params, this.subagentDeps());
  }

  private mapAgentEvent(event: AgentCoreEvent): BaseAgentEvent | null {
    switch (event.type) {
      case "status_change":
        if (event.status === "aborted") this.clearSidebandMeta();
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
        this.clearSidebandMeta();
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
        this.clearSidebandMeta();
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
