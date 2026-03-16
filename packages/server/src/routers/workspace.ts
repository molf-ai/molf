import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import type { WorkspaceEvent } from "@molf-ai/protocol";

export const workspaceHandlers = {
  list: os.workspace.list
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      return await context.workspaceStore.list(input.workerId);
    }),

  create: os.workspace.create
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const workspace = await context.workspaceStore.create(input.workerId, input.name, input.config);

      const session = await context.sessionMgr.create({
        workerId: input.workerId,
        workspaceId: workspace.id,
      });

      await context.workspaceStore.addSession(input.workerId, workspace.id, session.sessionId);

      return {
        workspace,
        sessionId: session.sessionId,
      };
    }),

  rename: os.workspace.rename
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const success = await context.workspaceStore.rename(input.workerId, input.workspaceId, input.name);
      if (!success) {
        throw new ORPCError("NOT_FOUND", {
          message: `Workspace ${input.workspaceId} not found`,
        });
      }
      return { success };
    }),

  setConfig: os.workspace.setConfig
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const workspace = await context.workspaceStore.get(input.workerId, input.workspaceId);
      if (!workspace) {
        throw new ORPCError("NOT_FOUND", {
          message: `Workspace ${input.workspaceId} not found`,
        });
      }

      await context.workspaceStore.setConfig(input.workerId, input.workspaceId, input.config);

      context.serverBus.emit(input.workerId, input.workspaceId, {
        type: "config_changed",
        config: input.config,
      });

      return { success: true };
    }),

  sessions: os.workspace.sessions
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const workspace = await context.workspaceStore.get(input.workerId, input.workspaceId);
      if (!workspace) {
        throw new ORPCError("NOT_FOUND", {
          message: `Workspace ${input.workspaceId} not found`,
        });
      }

      const results = [];
      for (const sessionId of workspace.sessions) {
        const session = context.sessionMgr.load(sessionId);
        if (!session) continue;
        results.push({
          sessionId: session.sessionId,
          name: session.name,
          messageCount: session.messages.length,
          lastActiveAt: session.lastActiveAt,
          isLastSession: sessionId === workspace.lastSessionId,
        });
      }

      results.sort((a, b) => {
        if (a.isLastSession) return -1;
        if (b.isLastSession) return 1;
        return b.lastActiveAt - a.lastActiveAt;
      });

      return results;
    }),

  ensureDefault: os.workspace.ensureDefault
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const workspace = await context.workspaceStore.ensureDefault(input.workerId);

      if (workspace.sessions.length === 0) {
        const session = await context.sessionMgr.create({
          workerId: input.workerId,
          workspaceId: workspace.id,
        });
        await context.workspaceStore.addSession(input.workerId, workspace.id, session.sessionId);
        return { workspace, sessionId: session.sessionId };
      }

      let sessionId = workspace.lastSessionId;
      const existing = context.sessionMgr.load(sessionId);
      if (!existing) {
        const session = await context.sessionMgr.create({
          workerId: input.workerId,
          workspaceId: workspace.id,
        });
        await context.workspaceStore.addSession(input.workerId, workspace.id, session.sessionId);
        sessionId = session.sessionId;
      }

      return { workspace, sessionId };
    }),

  onEvents: os.workspace.onEvents
    .use(authMiddleware)
    .handler(async function* ({ input, context, signal }) {
      const queue: WorkspaceEvent[] = [];
      let resolve: (() => void) | null = null;

      const unsub = context.serverBus.subscribe(input.workerId, input.workspaceId, (event) => {
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
              const onAbort = () => r();
              signal?.addEventListener("abort", onAbort, { once: true });
              resolve = () => { signal?.removeEventListener("abort", onAbort); r(); };
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
};
