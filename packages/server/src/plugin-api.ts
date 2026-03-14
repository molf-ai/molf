import { getLogger } from "@logtape/logtape";
import { join } from "node:path";
import type { ToolSet } from "ai";
import type {
  ServerPluginApi,
  ServerHookEvents,
  HookHandlerFn,
  HookRegistry,
  RouteMap,
  SessionToolContext,
  ISessionManager,
  IEventBus,
  IAgentRunner,
  IConnectionRegistry,
  IWorkspaceStore,
  IWorkspaceNotifier,
} from "@molf-ai/protocol";

export interface PluginService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface PluginRouteEntry {
  pluginName: string;
  routes: RouteMap;
  context: unknown;
}

export interface PluginToolEntry {
  pluginName: string;
  name: string;
  toolDef: ToolSet[string];
}

export type SessionToolFactory = (ctx: SessionToolContext) => { name: string; toolDef: ToolSet[string] } | null;

export interface ServerPluginInternals {
  sessionMgr: ISessionManager;
  eventBus: IEventBus;
  agentRunner: IAgentRunner;
  connectionRegistry: IConnectionRegistry;
  workspaceStore: IWorkspaceStore;
  workspaceNotifier: IWorkspaceNotifier;
  dataDir: string;
}

/**
 * Create the api object passed to a plugin's `server(api)` function.
 * Each plugin gets its own api instance with scoped logger and registries.
 */
export function createServerPluginApi(
  pluginName: string,
  config: unknown,
  hookRegistry: HookRegistry,
  internals: ServerPluginInternals,
  pluginTools: PluginToolEntry[],
  pluginRoutes: PluginRouteEntry[],
  pluginServices: PluginService[],
  sessionToolFactories: SessionToolFactory[],
): ServerPluginApi {
  const log = getLogger(["molf", "plugin", pluginName]);

  return {
    on<K extends keyof ServerHookEvents>(
      event: K,
      handler: HookHandlerFn<ServerHookEvents[K]>,
      opts?: { priority?: number },
    ): void {
      hookRegistry.on(event, pluginName, handler, opts);
    },

    addTool(name: string, toolDef: unknown): void {
      const existing = pluginTools.findIndex(t => t.name === name);
      if (existing !== -1) {
        log.warn(`Tool "${name}" already registered by "${pluginTools[existing].pluginName}", overwriting`);
        pluginTools[existing] = { pluginName, name, toolDef: toolDef as ToolSet[string] };
        return;
      }
      pluginTools.push({
        pluginName,
        name,
        toolDef: toolDef as ToolSet[string],
      });
    },

    addSessionTool(factory: (ctx: SessionToolContext) => { name: string; toolDef: unknown } | null): void {
      sessionToolFactories.push(factory as SessionToolFactory);
    },

    addRoutes(routes: RouteMap, context: unknown): void {
      pluginRoutes.push({ pluginName, routes, context });
    },

    addService(service: { start(): Promise<void>; stop(): Promise<void> }): void {
      pluginServices.push(service);
    },

    config,
    dataPath(workerId?: string, workspaceId?: string): string {
      const base = join(internals.dataDir, "plugins", pluginName);
      if (workerId == null) return base;
      if (workspaceId == null) return join(base, "workers", workerId);
      return join(base, "workers", workerId, "workspaces", workspaceId);
    },
    serverDataDir: internals.dataDir,
    sessionMgr: internals.sessionMgr,
    eventBus: internals.eventBus,
    agentRunner: internals.agentRunner,
    connectionRegistry: internals.connectionRegistry,
    workspaceStore: internals.workspaceStore,
    workspaceNotifier: internals.workspaceNotifier,
  };
}
