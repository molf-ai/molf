import { implement, ORPCError } from "@orpc/server";
import { contract } from "@molf-ai/protocol";
import type { SessionManager } from "./session-mgr.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { AgentRunner } from "./agent-runner.js";
import type { EventBus } from "./event-bus.js";
import type { ToolDispatch } from "./tool-dispatch.js";
import type { UploadDispatch } from "./upload-dispatch.js";
import type { FsDispatch } from "./fs-dispatch.js";
import type { InlineMediaCache } from "./inline-media-cache.js";
import type { ApprovalGate } from "./approval/approval-gate.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type { WorkspaceNotifier } from "./workspace-notifier.js";
import type { ProviderState } from "@molf-ai/agent-core";
import type { PluginLoader } from "./plugin-loader.js";
import type { PairingStore } from "./pairing.js";
import type { RateLimiter } from "./rate-limiter.js";

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
  eventBus: EventBus;
  toolDispatch: ToolDispatch;
  uploadDispatch: UploadDispatch;
  fsDispatch: FsDispatch;
  inlineMediaCache: InlineMediaCache;
  approvalGate: ApprovalGate;
  workspaceStore: WorkspaceStore;
  workspaceNotifier: WorkspaceNotifier;
  providerState: ProviderState;
  pairingStore: PairingStore;
  rateLimiter: RateLimiter;
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
