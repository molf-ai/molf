import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../context.js";
import {
  workspaceListInput,
  workspaceCreateInput,
  workspaceRenameInput,
  workspaceSetConfigInput,
  workspaceSessionsInput,
  workspaceEnsureDefaultInput,
  workspaceOnEventsInput,
} from "@molf-ai/protocol";
import type { WorkspaceEvent } from "@molf-ai/protocol";

export const workspaceRouter = router({
  list: authedProcedure
    .input(workspaceListInput)
    .query(async ({ input, ctx }) => {
      return await ctx.workspaceStore.list(input.workerId);
    }),

  create: authedProcedure
    .input(workspaceCreateInput)
    .mutation(async ({ input, ctx }) => {
      const workspace = await ctx.workspaceStore.create(input.workerId, input.name, input.config);

      // Create the first session in the new workspace
      const session = await ctx.sessionMgr.create({
        workerId: input.workerId,
        workspaceId: workspace.id,
      });

      await ctx.workspaceStore.addSession(input.workerId, workspace.id, session.sessionId);

      return {
        workspace,
        sessionId: session.sessionId,
      };
    }),

  rename: authedProcedure
    .input(workspaceRenameInput)
    .mutation(async ({ input, ctx }) => {
      const success = await ctx.workspaceStore.rename(input.workerId, input.workspaceId, input.name);
      if (!success) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace ${input.workspaceId} not found`,
        });
      }
      return { success };
    }),

  setConfig: authedProcedure
    .input(workspaceSetConfigInput)
    .mutation(async ({ input, ctx }) => {
      const workspace = await ctx.workspaceStore.get(input.workerId, input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace ${input.workspaceId} not found`,
        });
      }

      await ctx.workspaceStore.setConfig(input.workerId, input.workspaceId, input.config);

      ctx.workspaceNotifier.emit(input.workerId, input.workspaceId, {
        type: "config_changed",
        config: input.config,
      });

      return { success: true };
    }),

  sessions: authedProcedure
    .input(workspaceSessionsInput)
    .query(async ({ input, ctx }) => {
      const workspace = await ctx.workspaceStore.get(input.workerId, input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace ${input.workspaceId} not found`,
        });
      }

      const results = [];
      for (const sessionId of workspace.sessions) {
        const session = ctx.sessionMgr.load(sessionId);
        if (!session) continue;
        results.push({
          sessionId: session.sessionId,
          name: session.name,
          messageCount: session.messages.length,
          lastActiveAt: session.lastActiveAt,
          isLastSession: sessionId === workspace.lastSessionId,
        });
      }

      // Sort: lastSessionId pinned first, then by lastActiveAt desc
      results.sort((a, b) => {
        if (a.isLastSession) return -1;
        if (b.isLastSession) return 1;
        return b.lastActiveAt - a.lastActiveAt;
      });

      return results;
    }),

  ensureDefault: authedProcedure
    .input(workspaceEnsureDefaultInput)
    .mutation(async ({ input, ctx }) => {
      const workspace = await ctx.workspaceStore.ensureDefault(input.workerId);

      // If workspace has no sessions yet, create the first one
      if (workspace.sessions.length === 0) {
        const session = await ctx.sessionMgr.create({
          workerId: input.workerId,
          workspaceId: workspace.id,
        });
        await ctx.workspaceStore.addSession(input.workerId, workspace.id, session.sessionId);
        return { workspace, sessionId: session.sessionId };
      }

      // Validate lastSessionId — lazy self-repair if broken
      let sessionId = workspace.lastSessionId;
      const existing = ctx.sessionMgr.load(sessionId);
      if (!existing) {
        const session = await ctx.sessionMgr.create({
          workerId: input.workerId,
          workspaceId: workspace.id,
        });
        await ctx.workspaceStore.addSession(input.workerId, workspace.id, session.sessionId);
        sessionId = session.sessionId;
      }

      return { workspace, sessionId };
    }),

  onEvents: authedProcedure
    .input(workspaceOnEventsInput)
    .subscription(async function* ({ input, ctx, signal }) {
      const queue: WorkspaceEvent[] = [];
      let resolve: (() => void) | null = null;

      const unsub = ctx.workspaceNotifier.subscribe(input.workerId, input.workspaceId, (event) => {
        queue.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      try {
        while (!signal?.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
              signal?.addEventListener("abort", () => r(), { once: true });
            });
          }

          while (queue.length > 0) {
            yield queue.shift()!;
          }
        }
      } finally {
        unsub();
      }
    }),
});
