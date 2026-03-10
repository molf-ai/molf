import { getLogger } from "@logtape/logtape";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { createAppRouter } from "./router.js";
import { SessionManager } from "./session-mgr.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { WorkerStore } from "./worker-store.js";
import { AgentRunner } from "./agent-runner.js";
import { EventBus } from "./event-bus.js";
import { ToolDispatch } from "./tool-dispatch.js";
import { UploadDispatch } from "./upload-dispatch.js";
import { FsDispatch } from "./fs-dispatch.js";
import { InlineMediaCache } from "./inline-media-cache.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceNotifier } from "./workspace-notifier.js";
import { initAuth, verifyCredential } from "./auth.js";
import { PairingStore } from "./pairing.js";
import { RateLimiter } from "./rate-limiter.js";
import { RulesetStorage } from "./approval/ruleset-storage.js";
import { ApprovalGate } from "./approval/approval-gate.js";
import { PluginLoader, type PluginConfigEntry } from "./plugin-loader.js";
import { initProviders } from "@molf-ai/agent-core";
import type { ProviderState, ProviderRegistryConfig } from "@molf-ai/agent-core";
import { parseModelId } from "@molf-ai/protocol";
import type { ServerConfig, ModelId } from "@molf-ai/protocol";
import type { ServerContext } from "./context.js";

const connLogger = getLogger(["molf", "server", "conn"]);

export interface ServerInstance {
  wss: WebSocketServer;
  close: () => void;
  config: ServerConfig;
  token: string;
  /** @internal Exposed for testing */
  _ctx: {
    sessionMgr: SessionManager;
    connectionRegistry: ConnectionRegistry;
    agentRunner: AgentRunner;
    eventBus: EventBus;
    toolDispatch: ToolDispatch;
    uploadDispatch: UploadDispatch;
    fsDispatch: FsDispatch;
    inlineMediaCache: InlineMediaCache;
    approvalGate: ApprovalGate;
    workspaceStore: WorkspaceStore;
    workspaceNotifier: WorkspaceNotifier;
    pluginLoader: PluginLoader;
  };
}

export async function startServer(
  config: ServerConfig & {
    approval?: boolean;
    token?: string;
    providerConfig: ProviderRegistryConfig;
    behavior?: { temperature?: number; contextPruning?: boolean };
    plugins?: PluginConfigEntry[];
  },
): Promise<ServerInstance> {
  // Initialize auth
  const { token } = initAuth(config.dataDir, config.token);

  // Initialize provider system
  const providerState = await initProviders(config.providerConfig);

  // Validate default model's provider is available
  const defaultRef = parseModelId(config.model);
  if (!providerState.providers[defaultRef.providerID]) {
    throw new Error(
      `Default model "${config.model}" requires provider "${defaultRef.providerID}", ` +
        `but it has no API key or is not enabled. Check that the appropriate API key ` +
        `environment variable is set and the provider is listed in enabled_providers.`,
    );
  }

  // Initialize shared state
  const sessionMgr = new SessionManager(config.dataDir);
  const workerStore = new WorkerStore(config.dataDir);
  const connectionRegistry = new ConnectionRegistry(workerStore);
  connectionRegistry.init();
  const eventBus = new EventBus();
  const toolDispatch = new ToolDispatch();
  const uploadDispatch = new UploadDispatch();
  const fsDispatch = new FsDispatch();
  const inlineMediaCache = new InlineMediaCache();
  const workspaceStore = new WorkspaceStore(config.dataDir);
  const workspaceNotifier = new WorkspaceNotifier();

  // Initialize approval gate (always present; when disabled, evaluate() returns "allow" for everything)
  const approvalEnabled = config.approval !== false;
  const rulesetStorage = new RulesetStorage(config.dataDir);
  const approvalGate = new ApprovalGate(rulesetStorage, eventBus, approvalEnabled);

  // Initialize plugin system (before AgentRunner so hooks are available)
  const pluginLoader = new PluginLoader();

  const agentRunner = new AgentRunner(
    sessionMgr,
    eventBus,
    connectionRegistry,
    toolDispatch,
    providerState,
    config.model,
    inlineMediaCache,
    approvalGate,
    workspaceStore,
    pluginLoader,
  );

  // Wire hook registry into core components
  sessionMgr.setHookRegistry(pluginLoader.hookRegistry);
  connectionRegistry.setHookRegistry(pluginLoader.hookRegistry);

  if (config.plugins?.length) {
    await pluginLoader.loadAll(config.plugins, {
      sessionMgr,
      eventBus,
      agentRunner,
      connectionRegistry,
      workspaceStore,
      workspaceNotifier,
      dataDir: config.dataDir,
    });
  }

  // Initialize pairing and rate limiting
  const pairingStore = new PairingStore();
  const rateLimiter = new RateLimiter();

  // Create WebSocket server
  const wss = new WebSocketServer({
    host: config.host,
    port: config.port,
    maxPayload: 50 * 1024 * 1024, // 50MB
  });

  // Apply tRPC handler
  const appRouter = createAppRouter(pluginLoader);
  const handler = applyWSSHandler({
    wss,
    router: appRouter,
    createContext: ({ req }): ServerContext => {
      let credential: string | null = null;
      let clientId: string | null = null;
      let remoteIp: string | null = null;

      if (req) {
        remoteIp = req.socket?.remoteAddress ?? null;

        // Extract credential: Authorization header first, then query param fallback
        const authHeader = req.headers?.["authorization"];
        if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
          credential = authHeader.slice(7);
        }

        if (req.url) {
          const url = new URL(req.url, `http://${config.host}:${config.port}`);
          if (!credential) {
            credential = url.searchParams.get("token");
          }
          clientId = url.searchParams.get("clientId");
        }
      }

      // Verify credential
      let verifiedToken: string | null = null;
      let authType: "master" | "apiKey" | null = null;
      if (credential) {
        const result = verifyCredential(credential, config.dataDir);
        if (result.valid) {
          verifiedToken = credential;
          authType = result.type;
        }
      }

      return {
        token: verifiedToken,
        authType,
        clientId,
        remoteIp,
        sessionMgr,
        connectionRegistry,
        agentRunner,
        eventBus,
        toolDispatch,
        uploadDispatch,
        fsDispatch,
        inlineMediaCache,
        approvalGate,
        workspaceStore,
        workspaceNotifier,
        providerState,
        pairingStore,
        rateLimiter,
        pluginLoader,
        dataDir: config.dataDir,
      };
    },
    keepAlive: {
      enabled: true,
      pingMs: 30_000,
      pongWaitMs: 10_000,
    },
  });

  wss.on("connection", (ws, req) => {
    const url = req.url
      ? new URL(req.url, `http://${config.host}:${config.port}`)
      : null;
    const clientId = url?.searchParams.get("clientId") ?? crypto.randomUUID();
    const clientName = url?.searchParams.get("name") ?? "unknown";

    connLogger.debug("Connection opened", { clientName, clientId });

    ws.on("close", () => {
      // Clean up worker if this was a worker connection
      const worker = connectionRegistry.getWorker(clientId);
      if (worker) {
        const workerId = worker.id;
        for (const sessionId of sessionMgr.listByWorker(workerId)) {
          approvalGate.clearSession(sessionId);
        }
        connectionRegistry.unregister(workerId);
        toolDispatch.workerDisconnected(workerId);
        uploadDispatch.workerDisconnected(workerId);
        fsDispatch.workerDisconnected(workerId);
        connLogger.info("Worker disconnected", { workerName: worker.name, workerId });
      } else {
        connectionRegistry.unregister(clientId);
        connLogger.debug("Connection closed", { clientName, clientId });
      }
    });
  });

  // Start plugin services after all initialization
  await pluginLoader.startServices();

  // Startup banner — these are CLI output, NOT logs
  console.log(
    `[${new Date().toISOString()}] Molf server listening on ws://${config.host}:${config.port}`,
  );
  console.log(`[${new Date().toISOString()}] Data directory: ${config.dataDir}`);
  console.log(`[${new Date().toISOString()}] Model: ${config.model}`);

  // Dispatch server_start hook
  pluginLoader.hookRegistry.dispatchObserving("server_start", {
    port: config.port,
    dataDir: config.dataDir,
  }, pluginLoader.hookLogger);

  return {
    wss,
    close: () => {
      // Dispatch server_stop hook (fire-and-forget)
      pluginLoader.hookRegistry.dispatchObserving("server_stop", {}, pluginLoader.hookLogger);
      pluginLoader.shutdown().catch((err) => {
        connLogger.error("Plugin shutdown error", { error: err });
      });
      rateLimiter.close();
      approvalGate.clearAll();
      inlineMediaCache.close();
      handler.broadcastReconnectNotification();
      wss.close();
    },
    config,
    token,
    _ctx: {
      sessionMgr,
      connectionRegistry,
      agentRunner,
      eventBus,
      toolDispatch,
      uploadDispatch,
      fsDispatch,
      inlineMediaCache,
      approvalGate,
      workspaceStore,
      workspaceNotifier,
      pluginLoader,
    },
  };
}
