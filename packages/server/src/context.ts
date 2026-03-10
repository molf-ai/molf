import { initTRPC, TRPCError } from "@trpc/server";
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
}

const t = initTRPC.context<ServerContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/** Middleware that checks the auth token */
export const authedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.token) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing authentication token",
    });
  }

  // Token verification is done at WebSocket upgrade time.
  // If ctx.token is set, the connection was already authenticated.
  return next({ ctx: { ...ctx, token: ctx.token } });
});
