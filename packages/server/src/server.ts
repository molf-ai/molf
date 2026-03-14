import { createServer as createHttpsServer, type Server as HttpsServer } from "https";
import { readFileSync } from "fs";
import { getLogger } from "@logtape/logtape";
import { RPCHandler } from "@orpc/server/ws";
import { onError } from "@orpc/server";
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
import { resolveTlsCertPaths, computeFingerprint, checkCertExpiry } from "./tls.js";
import { initProviders } from "@molf-ai/agent-core";
import type { ProviderState, ProviderRegistryConfig } from "@molf-ai/agent-core";
import { parseModelId, MAX_WS_PAYLOAD_BYTES, PING_INTERVAL_MS, PONG_TIMEOUT_MS } from "@molf-ai/protocol";
import type { ServerConfig, ModelId } from "@molf-ai/protocol";
import type { ServerContext } from "./context.js";

const connLogger = getLogger(["molf", "server", "conn"]);

export interface ServerInstance {
  wss: WebSocketServer;
  port: number;
  close: () => void;
  config: ServerConfig;
  token: string;
  tlsFingerprint: string | null;
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
  const uploadDispatch = new UploadDispatch(config.dataDir);
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

  // Create WebSocket server (with optional TLS)
  let httpsServer: HttpsServer | null = null;
  let tlsFingerprint: string | null = null;
  let wss: WebSocketServer;

  if (config.tls) {
    const { certPath, keyPath } = resolveTlsCertPaths(config);
    const certPem = readFileSync(certPath, "utf-8");
    const keyPem = readFileSync(keyPath, "utf-8");

    tlsFingerprint = computeFingerprint(certPem);

    const daysUntilExpiry = checkCertExpiry(certPem);
    if (daysUntilExpiry <= 30) {
      console.warn(
        `WARNING: TLS certificate expires in ${daysUntilExpiry} days. Delete ${config.dataDir}/tls/ and restart to regenerate.`,
      );
    }

    httpsServer = createHttpsServer({
      cert: certPem,
      key: keyPem,
      minVersion: "TLSv1.3",
    });

    wss = new WebSocketServer({ server: httpsServer, maxPayload: MAX_WS_PAYLOAD_BYTES });

    await new Promise<void>((resolve) => {
      httpsServer!.listen(config.port, config.host, resolve);
    });
  } else {
    wss = new WebSocketServer({
      host: config.host,
      port: config.port,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    });

    // Wait for the server to be listening (needed for port: 0 in Node.js)
    await new Promise<void>((resolve) => {
      if (wss.address()) {
        resolve();
      } else {
        wss.once("listening", resolve);
      }
    });
  }

  // Create oRPC handler
  const appRouter = createAppRouter(pluginLoader);
  const handler = new RPCHandler(appRouter, {
    interceptors: [
      onError((error) => {
        connLogger.error("RPC error", { error });
      }),
    ],
  });

  // Set up keepalive ping/pong
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      (ws as any).__pongPending = true;
      ws.ping();
      // Set a timer to terminate if pong doesn't arrive within PONG_TIMEOUT_MS
      const pongTimer = setTimeout(() => {
        if ((ws as any).__pongPending) {
          ws.terminate();
        }
      }, PONG_TIMEOUT_MS);
      (ws as any).__pongTimer = pongTimer;
    }
  }, PING_INTERVAL_MS);

  wss.on("connection", (ws, req) => {
    const url = req.url
      ? new URL(req.url, `http://${config.host}:${config.port}`)
      : null;
    const clientId = url?.searchParams.get("clientId") ?? crypto.randomUUID();
    const clientName = url?.searchParams.get("name") ?? "unknown";

    connLogger.debug("Connection opened", { clientName, clientId });

    // Build context for this connection
    let credential: string | null = null;
    let remoteIp: string | null = null;

    if (req) {
      remoteIp = req.socket?.remoteAddress ?? null;

      const authHeader = req.headers?.["authorization"];
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        credential = authHeader.slice(7);
      }

      if (req.url) {
        const reqUrl = new URL(req.url, `http://${config.host}:${config.port}`);
        if (!credential) {
          credential = reqUrl.searchParams.get("token");
        }
      }
    }

    let verifiedToken: string | null = null;
    let authType: "master" | "apiKey" | null = null;
    if (credential) {
      const result = verifyCredential(credential, config.dataDir);
      if (result.valid) {
        verifiedToken = credential;
        authType = result.type;
      }
    }

    const context: ServerContext = {
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

    // Upgrade WebSocket to oRPC handler
    handler.upgrade(ws, { context });

    // Track pong for keepalive
    ws.on("pong", () => {
      (ws as any).__pongPending = false;
      if ((ws as any).__pongTimer) {
        clearTimeout((ws as any).__pongTimer);
        (ws as any).__pongTimer = null;
      }
    });

    ws.on("close", () => {
      if ((ws as any).__pongTimer) {
        clearTimeout((ws as any).__pongTimer);
        (ws as any).__pongTimer = null;
      }
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

  // Resolve the actual port (may differ from config when port=0)
  const addrSource = httpsServer ?? wss;
  const actualPort = (addrSource.address() as { port: number }).port;

  // Startup banner — these are CLI output, NOT logs
  if (!config.tls) {
    console.warn("WARNING: TLS disabled. Credentials will be transmitted in plaintext.");
    console.warn("Only use this on trusted networks or behind a TLS-terminating reverse proxy.\n");
  }
  const proto = config.tls ? "wss" : "ws";
  console.log(
    `[${new Date().toISOString()}] Molf server listening on ${proto}://${config.host}:${actualPort}`,
  );
  if (tlsFingerprint) {
    console.log(`[${new Date().toISOString()}] TLS fingerprint: ${tlsFingerprint}`);
  }
  console.log(`[${new Date().toISOString()}] Data directory: ${config.dataDir}`);
  console.log(`[${new Date().toISOString()}] Model: ${config.model}`);

  // Dispatch server_start hook
  pluginLoader.hookRegistry.dispatchObserving("server_start", {
    port: actualPort,
    dataDir: config.dataDir,
  }, pluginLoader.hookLogger);

  return {
    wss,
    port: actualPort,
    close: () => {
      // Dispatch server_stop hook (fire-and-forget)
      pluginLoader.hookRegistry.dispatchObserving("server_stop", {}, pluginLoader.hookLogger);
      pluginLoader.shutdown().catch((err) => {
        connLogger.error("Plugin shutdown error", { error: err });
      });
      clearInterval(pingInterval);
      rateLimiter.close();
      approvalGate.clearAll();
      inlineMediaCache.close();
      uploadDispatch.cleanup().catch(() => {});
      // Close all WS connections (replaces broadcastReconnectNotification)
      for (const ws of wss.clients) {
        ws.close(1012, "Server shutting down");
      }
      wss.close();
      if (httpsServer) httpsServer.close();
    },
    config,
    token,
    tlsFingerprint,
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
