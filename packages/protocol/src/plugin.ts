import type { ZodType } from "zod";
import type {
  SessionMessage,
  SessionFile,
  SessionListItem,
  ToolCall,
  AgentEvent,
  AgentStatus,
  ConnectionEntry,
  WorkerRegistration,
  KnownWorker,
  ClientRegistration,
  Registration,
  WorkerMetadata,
  WorkerToolInfo,
  WorkerSkillInfo,
  WorkerAgentInfo,
  WorkerTool,
  Workspace,
  WorkspaceConfig,
  WorkspaceEvent,
} from "./types.js";
import type { ModelId } from "./model-id.js";

// ---------------------------------------------------------------------------
// Hook event data types
// ---------------------------------------------------------------------------

export interface ServerHookEvents {
  before_prompt: {
    sessionId: string;
    systemPrompt: string;
    messages: SessionMessage[];
    model: string;
    tools: string[];
  };
  after_prompt: {
    sessionId: string;
    response: { content: string; toolCalls?: ToolCall[] };
    usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
    duration: number;
  };
  before_tool_call: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    workerId: string;
  };
  after_tool_call: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: { output: string; error?: string; meta?: Record<string, unknown> };
    duration: number;
  };
  turn_start: {
    sessionId: string;
    prompt: string;
    model: string;
  };
  turn_end: {
    sessionId: string;
    message: SessionMessage;
    toolCallCount: number;
    stepCount: number;
    duration: number;
  };
  session_create: {
    sessionId: string;
    name: string;
    workerId: string;
    workspaceId: string;
  };
  session_delete: {
    sessionId: string;
  };
  session_save: {
    sessionId: string;
    messages: SessionMessage[];
  };
  before_compaction: {
    sessionId: string;
    messages: SessionMessage[];
    reason: "context_limit" | "manual";
  };
  after_compaction: {
    sessionId: string;
    originalCount: number;
    compactedCount: number;
    summary: string;
  };
  worker_connect: {
    workerId: string;
    name: string;
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
  };
  worker_disconnect: {
    workerId: string;
    reason: "clean" | "timeout" | "error";
  };
  server_start: {
    port: number;
    dataDir: string;
  };
  server_stop: {};
}

export interface WorkerHookEvents {
  before_tool_execute: {
    toolName: string;
    args: Record<string, unknown>;
    workdir: string;
  };
  after_tool_execute: {
    toolName: string;
    args: Record<string, unknown>;
    result: { output: string; error?: string; meta?: Record<string, unknown> };
    duration: number;
  };
  worker_start: {
    workerId: string;
    workdir: string;
  };
  worker_stop: {};
}

export type AllHookEvents = ServerHookEvents & WorkerHookEvents;

// ---------------------------------------------------------------------------
// Hook mode classification
// ---------------------------------------------------------------------------

export type HookMode = "modifying" | "observing";

export const HOOK_MODES: Record<keyof AllHookEvents, HookMode> = {
  // Server
  before_prompt: "modifying",
  after_prompt: "observing",
  before_tool_call: "modifying",
  after_tool_call: "modifying",
  turn_start: "observing",
  turn_end: "observing",
  session_create: "observing",
  session_delete: "observing",
  session_save: "modifying",
  before_compaction: "modifying",
  after_compaction: "observing",
  worker_connect: "observing",
  worker_disconnect: "observing",
  server_start: "observing",
  server_stop: "observing",
  // Worker
  before_tool_execute: "modifying",
  after_tool_execute: "modifying",
  worker_start: "observing",
  worker_stop: "observing",
};

/** Hooks where handlers may return `{ block: "reason" }` to cancel the action. */
export const BLOCKABLE_HOOKS: ReadonlySet<keyof AllHookEvents> = new Set<keyof AllHookEvents>([
  "before_tool_call",
  "before_compaction",
  "before_tool_execute",
]);

// ---------------------------------------------------------------------------
// Hook handler types
// ---------------------------------------------------------------------------

/** Result from a modifying hook handler. */
export type HookHandlerResult<T> = void | undefined | { block: string } | Partial<T>;

export type HookHandlerFn<T> = (event: T) => HookHandlerResult<T> | Promise<HookHandlerResult<T>>;

interface RegisteredHandler {
  pluginName: string;
  handler: HookHandlerFn<any>;
  priority: number;
}

/** Dispatch result for modifying hooks. */
export type ModifyResult<T> =
  | { blocked: false; data: T }
  | { blocked: true; reason: string };

// ---------------------------------------------------------------------------
// HookRegistry
// ---------------------------------------------------------------------------

/** Logger shape accepted by dispatch methods. */
export interface HookLogger {
  warn(message: string, props?: Record<string, unknown>): void;
}

export class HookRegistry {
  private handlers = new Map<string, RegisteredHandler[]>();

  on(
    hookName: string,
    pluginName: string,
    handler: HookHandlerFn<any>,
    opts?: { priority?: number },
  ): void {
    const list = this.handlers.get(hookName) ?? [];
    list.push({ pluginName, handler, priority: opts?.priority ?? 0 });
    this.handlers.set(hookName, list);
  }

  /**
   * Dispatch a modifying hook. Handlers run sequentially by priority (descending).
   * Each handler sees accumulated modifications. A handler returning `{ block: "reason" }`
   * short-circuits — no further handlers run.
   * Only keys present in the original event data are merged from handler results.
   */
  async dispatchModifying<T extends Record<string, unknown>>(
    hookName: string,
    eventData: T,
    logger: HookLogger,
  ): Promise<ModifyResult<T>> {
    const list = this.handlers.get(hookName);
    if (!list || list.length === 0) return { blocked: false, data: eventData };

    const sorted = [...list].sort((a, b) => b.priority - a.priority);
    const validKeys = new Set(Object.keys(eventData));

    let data = { ...eventData };
    for (const entry of sorted) {
      try {
        const result = await entry.handler(data);
        if (result == null) continue;
        if ("block" in result && typeof (result as { block: string }).block === "string") {
          if ((BLOCKABLE_HOOKS as ReadonlySet<string>).has(hookName)) {
            return { blocked: true, reason: (result as { block: string }).block };
          }
          logger.warn(
            `Plugin ${entry.pluginName} returned block on non-blockable hook "${hookName}" — ignored`,
          );
          continue;
        }
        // Shallow-merge only keys that exist in the original event
        const partial = result as Partial<T>;
        for (const key of Object.keys(partial)) {
          if (validKeys.has(key)) {
            (data as any)[key] = (partial as any)[key];
          }
        }
      } catch (err) {
        logger.warn(`Plugin ${entry.pluginName} hook ${hookName} threw: ${err}`);
      }
    }

    return { blocked: false, data };
  }

  /**
   * Dispatch an observing hook. All handlers fire in parallel.
   * Fire-and-forget — does NOT block the caller. Errors are logged.
   */
  dispatchObserving(
    hookName: string,
    eventData: Record<string, unknown>,
    logger: HookLogger,
  ): void {
    const list = this.handlers.get(hookName);
    if (!list || list.length === 0) return;

    void Promise.allSettled(
      list.map((entry) => {
        try {
          return entry.handler(eventData);
        } catch (err) {
          return Promise.reject(err);
        }
      }),
    ).then((results) => {
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          logger.warn(
            `Plugin ${list[i].pluginName} hook ${hookName} threw: ${(results[i] as PromiseRejectedResult).reason}`,
          );
        }
      }
    });
  }

  /** Remove all handlers registered by a plugin (used during plugin destroy). */
  removePlugin(pluginName: string): void {
    for (const [hookName, list] of this.handlers) {
      const filtered = list.filter((h) => h.pluginName !== pluginName);
      if (filtered.length === 0) {
        this.handlers.delete(hookName);
      } else {
        this.handlers.set(hookName, filtered);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin route types and defineRoutes
// ---------------------------------------------------------------------------

export interface RouteDefinition<TInput = unknown, TOutput = unknown, TCtx = unknown> {
  type: "query" | "mutation";
  input: ZodType<TInput>;
  output: ZodType<TOutput>;
  handler: (opts: { input: TInput; context: TCtx }) => TOutput | Promise<TOutput>;
}

export type RouteMap<TCtx = unknown> = Record<string, RouteDefinition<any, any, TCtx>>;

/** Typed identity function for plugin route definitions. */
export function defineRoutes<TCtx, T extends RouteMap<TCtx>>(routes: T): T {
  return routes;
}

// ---------------------------------------------------------------------------
// createPluginClient — proxy for typed plugin route calls
// ---------------------------------------------------------------------------

/** Minimal shape of the RPC client needed by createPluginClient. */
export interface PluginRpcClient {
  plugin: {
    query(input: { plugin: string; method: string; input: unknown }): Promise<{ result: unknown }>;
    mutate(input: { plugin: string; method: string; input: unknown }): Promise<{ result: unknown }>;
  };
}

/** Infers a typed client shape from a RouteMap. */
export type PluginClient<TRoutes extends RouteMap> = {
  [K in keyof TRoutes]: (
    input: TRoutes[K] extends RouteDefinition<infer I, any, any> ? I : never,
  ) => Promise<TRoutes[K] extends RouteDefinition<any, infer O, any> ? O : never>;
};

/**
 * Creates a typed proxy that maps `client.methodName(input)` to the generic
 * `plugin.query/mutate` procedures. Uses the routes object at runtime to
 * determine whether each method is a query or mutation.
 */
export function createPluginClient<TRoutes extends RouteMap>(
  pluginName: string,
  client: PluginRpcClient,
  routes: TRoutes,
): PluginClient<TRoutes> {
  return new Proxy({} as any, {
    get(_target, method: string) {
      return async (input: unknown) => {
        const route = routes[method];
        if (!route) throw new Error(`Unknown route: ${pluginName}.${method}`);
        const payload = { plugin: pluginName, method, input };
        const { result } = route.type === "query"
          ? await client.plugin.query(payload)
          : await client.plugin.mutate(payload);
        return result;
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Plugin API interfaces (type-only — implementations live in server/worker)
// ---------------------------------------------------------------------------

export interface SessionToolContext {
  sessionId: string;
  workerId: string;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Manager interfaces — protocol-safe abstractions for server internals
// ---------------------------------------------------------------------------

export interface ISessionManager {
  create(params: {
    name?: string;
    workerId: string;
    workspaceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionFile>;
  list(
    isActive?: (sessionId: string) => boolean,
    filters?: {
      sessionId?: string;
      name?: string;
      workerId?: string;
      active?: boolean;
      metadata?: Record<string, unknown>;
    },
    pagination?: { limit?: number; offset?: number },
  ): Promise<{ sessions: SessionListItem[]; total: number }>;
  load(sessionId: string): SessionFile | null;
  save(sessionId: string): Promise<void>;
  rename(sessionId: string, name: string): Promise<boolean>;
  delete(sessionId: string): boolean;
  release(sessionId: string): Promise<void>;
  getActive(sessionId: string): SessionFile | undefined;
  listByWorker(workerId: string): string[];
  addMessage(sessionId: string, message: SessionMessage): void;
  getMessages(sessionId: string): SessionMessage[];
  replaceMessages(sessionId: string, messages: SessionMessage[]): void;
  setHookRegistry(registry: HookRegistry): void;
}

export interface IEventBus {
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  emit(sessionId: string, event: AgentEvent): void;
  hasListeners(sessionId: string): boolean;
}

export interface IAgentRunner {
  getStatus(sessionId: string): AgentStatus;
  waitForTurn(sessionId: string): Promise<void>;
  prompt(
    sessionId: string,
    text: string,
    fileRefs?: Array<{ path: string; mimeType: string }>,
    modelId?: ModelId,
    options?: { synthetic?: boolean },
  ): Promise<{ messageId: string }>;
  abort(sessionId: string): boolean;
  injectShellResult(sessionId: string, command: string, resultContent: string): Promise<void>;
  evict(sessionId: string): void;
  releaseIfIdle(sessionId: string): Promise<void>;
  runSubagent(params: {
    parentSessionId: string;
    workerId: string;
    agentType: string;
    prompt: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{ sessionId: string; result: string }>;
}

export interface IConnectionRegistry {
  init(): void;
  setHookRegistry(registry: HookRegistry): void;
  registerWorker(entry: Omit<WorkerRegistration, "role">): void;
  registerClient(entry: Omit<ClientRegistration, "role">): void;
  unregister(id: string): void;
  get(id: string): Registration | undefined;
  getWorker(id: string): WorkerRegistration | undefined;
  getWorkers(): WorkerRegistration[];
  getKnownWorkers(): KnownWorker[];
  updateWorkerState(
    workerId: string,
    state: {
      tools: WorkerToolInfo[];
      skills: WorkerSkillInfo[];
      agents: WorkerAgentInfo[];
      metadata?: WorkerMetadata;
    },
  ): boolean;
  renameWorker(workerId: string, name: string): boolean;
  getClients(): ClientRegistration[];
  isConnected(id: string): boolean;
  counts(): { workers: number; clients: number };
}

export interface IWorkspaceStore {
  get(workerId: string, workspaceId: string): Promise<Workspace | undefined>;
  getByName(workerId: string, name: string): Promise<Workspace | undefined>;
  getDefault(workerId: string): Promise<Workspace | undefined>;
  list(workerId: string): Promise<Workspace[]>;
  create(workerId: string, name: string, config?: WorkspaceConfig): Promise<Workspace>;
  rename(workerId: string, workspaceId: string, newName: string): Promise<boolean>;
  addSession(workerId: string, workspaceId: string, sessionId: string): Promise<void>;
  updateLastSession(workerId: string, workspaceId: string, sessionId: string): Promise<void>;
  setConfig(workerId: string, workspaceId: string, config: WorkspaceConfig): Promise<void>;
  ensureDefault(workerId: string): Promise<Workspace>;
}

export interface IWorkspaceNotifier {
  subscribe(workerId: string, workspaceId: string, listener: (event: WorkspaceEvent) => void): () => void;
  emit(workerId: string, workspaceId: string, event: WorkspaceEvent): void;
}

export interface ServerPluginApi<TConfig = unknown> {
  on<K extends keyof ServerHookEvents>(
    event: K,
    handler: HookHandlerFn<ServerHookEvents[K]>,
    opts?: { priority?: number },
  ): void;
  addTool(name: string, def: unknown): void;
  /** Register a tool factory that builds per-session tools (e.g. task, cron). */
  addSessionTool(factory: (ctx: SessionToolContext) => { name: string; toolDef: unknown } | null): void;
  addRoutes(routes: RouteMap, context: unknown): void;
  addService(service: { start(): Promise<void>; stop(): Promise<void> }): void;
  config: TConfig;
  /** Scoped data path under `plugins/{pluginName}/`. With args: `plugins/{pluginName}/workers/{wId}/workspaces/{wsId}`. */
  dataPath(workerId?: string, workspaceId?: string): string;
  /** Raw server data directory — escape hatch. */
  serverDataDir: string;
  sessionMgr: ISessionManager;
  eventBus: IEventBus;
  agentRunner: IAgentRunner;
  connectionRegistry: IConnectionRegistry;
  workspaceStore: IWorkspaceStore;
  workspaceNotifier: IWorkspaceNotifier;
}

export interface WorkerPluginApi<TConfig = unknown> {
  on<K extends keyof WorkerHookEvents>(
    event: K,
    handler: HookHandlerFn<WorkerHookEvents[K]>,
    opts?: { priority?: number },
  ): void;
  addTool(name: string, def: Omit<WorkerTool, "name">): void;
  removeTool(name: string): void;
  syncState(): Promise<void>;
  addSkill(skill: { name: string; description: string; content: string }): void;
  addAgent(agent: {
    name: string;
    description: string;
    content: string;
    permission?: Record<string, unknown>;
    maxSteps?: number;
  }): void;
  config: TConfig;
  workdir: string;
}

// ---------------------------------------------------------------------------
// PluginDescriptor and definePlugin
// ---------------------------------------------------------------------------

/** Return type from plugin init functions. */
export type PluginCleanup = void | { destroy?: () => void | Promise<void> };

export interface PluginDescriptor<TConfig = unknown> {
  name: string;
  configSchema?: ZodType<TConfig>;
  server?: (api: ServerPluginApi<TConfig>) => PluginCleanup | Promise<PluginCleanup>;
  worker?: (api: WorkerPluginApi<TConfig>) => PluginCleanup | Promise<PluginCleanup>;
}

/** Typed identity function for plugin descriptors. Provides type inference. */
export function definePlugin<TConfig = unknown>(
  descriptor: PluginDescriptor<TConfig>,
): PluginDescriptor<TConfig> {
  return descriptor;
}
