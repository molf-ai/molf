import { getLogger } from "@logtape/logtape";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../context.js";
import {
  workerRegisterInput,
  workerSyncStateInput,
  workerRenameInput,
  workerIdInput,
  workerToolResultInput,
  workerUploadResultInput,
  workerFsReadResultInput,
} from "@molf-ai/protocol";

const connLogger = getLogger(["molf", "server", "conn"]);

export const workerRouter = router({
  register: authedProcedure
    .input(workerRegisterInput)
    .mutation(async ({ input, ctx }) => {
      // If the same worker ID is already registered (e.g., reconnecting before
      // the old connection's close event fired), clean up the stale entry.
      if (ctx.connectionRegistry.isConnected(input.workerId)) {
        ctx.connectionRegistry.unregister(input.workerId);
        ctx.toolDispatch.workerDisconnected(input.workerId);
        ctx.uploadDispatch.workerDisconnected(input.workerId);
        ctx.fsDispatch.workerDisconnected(input.workerId);
        connLogger.warn("Worker re-registering (stale cleanup)", { workerName: input.name, workerId: input.workerId });
      }

      ctx.connectionRegistry.registerWorker({
        id: input.workerId,
        name: input.name,
        connectedAt: Date.now(),
        tools: input.tools,
        skills: input.skills ?? [],
        agents: input.agents ?? [],
        metadata: input.metadata,
      });

      connLogger.info("Worker connected", { workerName: input.name, workerId: input.workerId });

      // Ensure default workspace exists for this worker
      await ctx.workspaceStore.ensureDefault(input.workerId);

      return {
        workerId: input.workerId,
        plugins: ctx.pluginLoader?.workerPluginSpecifiers.map(s => ({ specifier: s })),
      };
    }),

  rename: authedProcedure
    .input(workerRenameInput)
    .mutation(async ({ input, ctx }) => {
      const worker = ctx.connectionRegistry.getWorker(input.workerId);
      if (!worker) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Worker ${input.workerId} not found`,
        });
      }

      // Update name in both connections and knownWorkers maps, and persist
      ctx.connectionRegistry.renameWorker(input.workerId, input.name);
      return { renamed: true };
    }),

  syncState: authedProcedure
    .input(workerSyncStateInput)
    .mutation(async ({ input, ctx }) => {
      const updated = ctx.connectionRegistry.updateWorkerState(input.workerId, {
        tools: input.tools,
        skills: input.skills ?? [],
        agents: input.agents ?? [],
        metadata: input.metadata,
      });

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Worker ${input.workerId} not found or not connected`,
        });
      }

      connLogger.info("Worker syncState", { workerId: input.workerId, toolCount: input.tools.length, skillCount: (input.skills ?? []).length });

      return { synced: true };
    }),

  onToolCall: authedProcedure
    .input(workerIdInput)
    .subscription(async function* ({ input, ctx, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });

      yield* ctx.toolDispatch.subscribeWorker(
        input.workerId,
        abortController.signal,
      );
    }),

  toolResult: authedProcedure
    .input(workerToolResultInput)
    .mutation(async ({ input, ctx }) => {
      const { toolCallId, output, error, meta, attachments } = input;
      const received = ctx.toolDispatch.resolveToolCall(toolCallId, {
        output,
        error,
        meta,
        attachments,
      });
      return { received };
    }),

  onUpload: authedProcedure
    .input(workerIdInput)
    .subscription(async function* ({ input, ctx, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });

      yield* ctx.uploadDispatch.subscribeWorker(
        input.workerId,
        abortController.signal,
      );
    }),

  uploadResult: authedProcedure
    .input(workerUploadResultInput)
    .mutation(async ({ input, ctx }) => {
      ctx.uploadDispatch.resolveUpload(input.uploadId, {
        path: input.path,
        size: input.size,
        error: input.error,
      });
      return { received: true };
    }),

  onFsRead: authedProcedure
    .input(workerIdInput)
    .subscription(async function* ({ input, ctx, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });

      yield* ctx.fsDispatch.subscribeWorker(
        input.workerId,
        abortController.signal,
      );
    }),

  fsReadResult: authedProcedure
    .input(workerFsReadResultInput)
    .mutation(async ({ input, ctx }) => {
      const received = ctx.fsDispatch.resolveRead(input.requestId, {
        requestId: input.requestId,
        content: input.content,
        size: input.size,
        encoding: input.encoding,
        error: input.error,
      });
      return { received };
    }),
});
