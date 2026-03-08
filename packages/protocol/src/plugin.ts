import type { ZodType } from "zod";
import type {
  SessionMessage,
  ToolCall,
  WorkerToolInfo,
  WorkerSkillInfo,
  WorkerTool,
} from "./types.js";

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
  handler: (input: TInput, ctx: TCtx) => TOutput | Promise<TOutput>;
}

export type RouteMap<TCtx = unknown> = Record<string, RouteDefinition<any, any, TCtx>>;

/** Typed identity function for plugin route definitions. */
export function defineRoutes<TCtx, T extends RouteMap<TCtx>>(routes: T): T {
  return routes;
}

// ---------------------------------------------------------------------------
// createPluginClient — proxy for typed plugin route calls
// ---------------------------------------------------------------------------

/** Minimal shape of the trpc client needed by createPluginClient. */
export interface PluginTrpcClient {
  plugin: {
    query: { query(input: { plugin: string; method: string; input: unknown }): Promise<unknown> };
    mutate: { mutate(input: { plugin: string; method: string; input: unknown }): Promise<unknown> };
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
 * `trpc.plugin.query/call` procedures. Uses the routes object at runtime to
 * determine whether each method is a query or mutation.
 */
export function createPluginClient<TRoutes extends RouteMap>(
  pluginName: string,
  trpc: PluginTrpcClient,
  routes: TRoutes,
): PluginClient<TRoutes> {
  return new Proxy({} as any, {
    get(_target, method: string) {
      return (input: unknown) => {
        const route = routes[method];
        if (!route) return Promise.reject(new Error(`Unknown route: ${pluginName}.${method}`));
        if (route.type === "query") {
          return trpc.plugin.query.query({ plugin: pluginName, method, input });
        }
        return trpc.plugin.mutate.mutate({ plugin: pluginName, method, input });
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Plugin API interfaces (type-only — implementations live in server/worker)
// ---------------------------------------------------------------------------

/** Logger interface matching LogTape's Logger shape. */
export interface PluginLogger {
  debug(message: string, props?: Record<string, unknown>): void;
  info(message: string, props?: Record<string, unknown>): void;
  warn(message: string, props?: Record<string, unknown>): void;
  error(message: string, props?: Record<string, unknown>): void;
}

export interface SessionToolContext {
  sessionId: string;
  workerId: string;
  workspaceId: string;
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
  log: PluginLogger;
  config: TConfig;
  /** Scoped data path under `plugins/{pluginName}/`. With args: `plugins/{pluginName}/workers/{wId}/workspaces/{wsId}`. */
  dataPath(workerId?: string, workspaceId?: string): string;
  /** Raw server data directory — escape hatch. */
  serverDataDir: string;
  sessionMgr: unknown;
  eventBus: unknown;
  agentRunner: unknown;
  connectionRegistry: unknown;
  workspaceStore: unknown;
  workspaceNotifier: unknown;
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
  log: PluginLogger;
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
