import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";
import {
  sessionCreateInput,
  sessionListInput,
  sessionLoadInput,
  sessionDeleteInput,
  sessionRenameInput,
} from "@molf-ai/protocol";

export const sessionRouter = router({
  create: authedProcedure
    .input(sessionCreateInput)
    .mutation(async ({ input, ctx }) => {
      // Verify worker exists
      const worker = ctx.connectionRegistry.getWorker(input.workerId);
      if (!worker) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Worker ${input.workerId} not found or not connected`,
        });
      }

      const session = await ctx.sessionMgr.create({
        name: input.name,
        workerId: input.workerId,
        workspaceId: input.workspaceId,
        metadata: input.metadata,
      });

      // Add session to workspace and emit event
      await ctx.workspaceStore.addSession(input.workerId, input.workspaceId, session.sessionId);
      ctx.workspaceNotifier.emit(input.workerId, input.workspaceId, {
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

  list: authedProcedure
    .input(sessionListInput)
    .query(async ({ input, ctx }) => {
      const isActive = (id: string) =>
        ctx.eventBus.hasListeners(id) || ctx.agentRunner.getStatus(id) !== "idle";
      const { limit, offset, ...filters } = input ?? {};
      return await ctx.sessionMgr.list(
        isActive,
        Object.keys(filters).length > 0 ? filters : undefined,
        limit !== undefined || offset !== undefined ? { limit, offset } : undefined,
      );
    }),

  load: authedProcedure
    .input(sessionLoadInput)
    .mutation(async ({ input, ctx }) => {
      const session = loadSessionOrThrow(ctx.sessionMgr, input.sessionId);

      return {
        sessionId: session.sessionId,
        name: session.name,
        workerId: session.workerId,
        messages: session.messages,
      };
    }),

  delete: authedProcedure
    .input(sessionDeleteInput)
    .mutation(async ({ input, ctx }) => {
      ctx.agentRunner.evict(input.sessionId);
      const deleted = ctx.sessionMgr.delete(input.sessionId);
      return { deleted };
    }),

  rename: authedProcedure
    .input(sessionRenameInput)
    .mutation(async ({ input, ctx }) => {
      const renamed = await ctx.sessionMgr.rename(input.sessionId, input.name);
      if (!renamed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }
      return { renamed };
    }),
});
