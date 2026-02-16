import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { appRouter } from "./router.js";
import { SessionManager } from "./session-mgr.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { AgentRunner } from "./agent-runner.js";
import { EventBus } from "./event-bus.js";
import { ToolDispatch } from "./tool-dispatch.js";
import { UploadDispatch } from "./upload-dispatch.js";
import { InlineMediaCache } from "./inline-media-cache.js";
import { initAuth, verifyToken } from "./auth.js";
import type { ServerConfig } from "@molf-ai/protocol";
import type { ServerContext } from "./context.js";

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
    inlineMediaCache: InlineMediaCache;
  };
}

export function startServer(config: ServerConfig): ServerInstance {
  // Initialize auth
  const { token } = initAuth(config.dataDir);

  // Initialize shared state
  const sessionMgr = new SessionManager(config.dataDir);
  const connectionRegistry = new ConnectionRegistry();
  const eventBus = new EventBus();
  const toolDispatch = new ToolDispatch();
  const uploadDispatch = new UploadDispatch();
  const inlineMediaCache = new InlineMediaCache();
  const agentRunner = new AgentRunner(
    sessionMgr,
    eventBus,
    connectionRegistry,
    toolDispatch,
    config.llm,
    inlineMediaCache,
  );

  // Create WebSocket server
  const wss = new WebSocketServer({
    host: config.host,
    port: config.port,
    maxPayload: 50 * 1024 * 1024, // 50MB
  });

  // Apply tRPC handler
  const handler = applyWSSHandler({
    wss,
    router: appRouter,
    createContext: ({ req }): ServerContext => {
      // Extract token from URL query params or headers
      let authToken: string | null = null;
      let clientId: string | null = null;

      if (req?.url) {
        const url = new URL(req.url, `http://${config.host}:${config.port}`);
        authToken = url.searchParams.get("token");
        clientId = url.searchParams.get("clientId");
      }

      // Verify token
      if (authToken && !verifyToken(authToken, config.dataDir)) {
        authToken = null; // Will cause UNAUTHORIZED in authedProcedure
      }

      return {
        token: authToken,
        clientId,
        sessionMgr,
        connectionRegistry,
        agentRunner,
        eventBus,
        toolDispatch,
        uploadDispatch,
        inlineMediaCache,
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

    console.log(
      `[${new Date().toISOString()}] connection opened: ${clientName} (id=${clientId})`,
    );

    ws.on("close", () => {
      // Clean up worker if this was a worker connection
      const worker = connectionRegistry.getWorker(clientId);
      if (worker) {
        connectionRegistry.unregister(clientId);
        toolDispatch.workerDisconnected(clientId);
        uploadDispatch.workerDisconnected(clientId);
        console.log(
          `[${new Date().toISOString()}] worker disconnected: ${worker.name} (id=${clientId})`,
        );
      } else {
        connectionRegistry.unregister(clientId);
        console.log(
          `[${new Date().toISOString()}] connection closed: ${clientName} (id=${clientId})`,
        );
      }
    });
  });

  console.log(
    `[${new Date().toISOString()}] Molf server listening on ws://${config.host}:${config.port}`,
  );
  console.log(`[${new Date().toISOString()}] Data directory: ${config.dataDir}`);
  console.log(`[${new Date().toISOString()}] LLM: ${config.llm.provider}/${config.llm.model}`);

  return {
    wss,
    close: () => {
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
      inlineMediaCache,
    },
  };
}
