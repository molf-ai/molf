import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";

export const sessionHandlers = {
  create: os.session.create
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const worker = context.connectionRegistry.getWorker(input.workerId);
      if (!worker) {
        throw new ORPCError("NOT_FOUND", {
          message: `Worker ${input.workerId} not found or not connected`,
        });
      }

      const session = await context.sessionMgr.create({
        name: input.name,
        workerId: input.workerId,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
      });

      await context.workspaceStore.addSession(input.workerId, input.workspaceId, session.sessionId);
      context.serverBus.emit({ type: "workspace", workerId: input.workerId, workspaceId: input.workspaceId }, {
        type: "session_created",
        sessionId: session.sessionId,
        sessionName: session.name,
      });

      return {
        sessionId: session.sessionId,
        name: session.name,
        workerId: session.workerId,
        createdAt: session.createdAt,
        metadata: session.metadata,
      };
    }),

  list: os.session.list
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const isActive = (id: string) =>
        context.serverBus.hasListeners({ type: "session", sessionId: id }) || context.agentRunner.getStatus(id) !== "idle";
      const { limit, offset, ...filters } = input ?? {};
      return await context.sessionMgr.list(
        isActive,
        Object.keys(filters).length > 0 ? filters : undefined,
        limit !== undefined || offset !== undefined ? { limit, offset } : undefined,
      );
    }),

  load: os.session.load
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);
      return {
        sessionId: session.sessionId,
        name: session.name,
        workerId: session.workerId,
        messages: session.messages,
      };
    }),

  delete: os.session.delete
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      context.agentRunner.evict(input.sessionId);
      const deleted = context.sessionMgr.delete(input.sessionId);
      return { deleted };
    }),

  rename: os.session.rename
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const renamed = await context.sessionMgr.rename(input.sessionId, input.name);
      if (!renamed) {
        throw new ORPCError("NOT_FOUND", {
          message: `Session ${input.sessionId} not found`,
        });
      }
      return { renamed };
    }),
};
