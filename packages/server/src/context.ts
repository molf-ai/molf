import { implement, ORPCError } from "@orpc/server";
import { contract } from "@molf-ai/protocol";
import type { SessionManager } from "./session-mgr.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { AgentRunner } from "./agent-runner.js";
import type { ToolDispatch } from "./tool-dispatch.js";
import type { UploadDispatch } from "./upload-dispatch.js";
import type { FsDispatch } from "./fs-dispatch.js";
import type { InlineMediaCache } from "./inline-media-cache.js";
import type { ApprovalGate } from "./approval/approval-gate.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type { PluginLoader } from "./plugin-loader.js";
import type { PairingStore } from "./pairing.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { ServerState } from "./server-state.js";
import type { ServerBus } from "./server-bus.js";
import type { ProviderKeyStore } from "./provider-keys.js";
import type { CancelNotifier } from "./cancel-notifier.js";

// TODO: Refactor — ServerContext acts as a service locator (18 fields passed to every
// route handler, though each router only uses 2-4). Consider grouping related services
// (e.g. dispatchers: { tool, upload, fs }) or narrowing context per-router so that
// actual dependencies are explicit and routes are easier to test in isolation.
export interface ServerContext {
  token: string | null;
  authType: "master" | "apiKey" | null;
  clientId: string | null;
  remoteIp: string | null;
  sessionMgr: SessionManager;
  connectionRegistry: ConnectionRegistry;
  agentRunner: AgentRunner;
  toolDispatch: ToolDispatch;
  uploadDispatch: UploadDispatch;
  fsDispatch: FsDispatch;
  inlineMediaCache: InlineMediaCache;
  approvalGate: ApprovalGate;
  workspaceStore: WorkspaceStore;
  serverState: ServerState;
  serverBus: ServerBus;
  providerKeyStore: ProviderKeyStore;
  pairingStore: PairingStore;
  rateLimiter: RateLimiter;
  cancelNotifier: CancelNotifier;
  pluginLoader?: PluginLoader;
  dataDir: string;
  uploadTimeoutMs: number;
}

export const os = implement(contract).$context<ServerContext>();

/** Middleware that checks the auth token */
export const authMiddleware = os.middleware(async ({ context, next }) => {
  if (!context.token) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Missing authentication token",
    });
  }

  // Token verification is done at WebSocket upgrade time.
  // If context.token is set, the connection was already authenticated.
  return next({ context: { ...context, token: context.token } });
});
