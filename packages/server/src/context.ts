import { initTRPC, TRPCError } from "@trpc/server";
import type { SessionManager } from "./session-mgr.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { AgentRunner } from "./agent-runner.js";
import type { EventBus } from "./event-bus.js";
import type { ToolDispatch } from "./tool-dispatch.js";

export interface ServerContext {
  token: string | null;
  clientId: string | null;
  sessionMgr: SessionManager;
  connectionRegistry: ConnectionRegistry;
  agentRunner: AgentRunner;
  eventBus: EventBus;
  toolDispatch: ToolDispatch;
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
