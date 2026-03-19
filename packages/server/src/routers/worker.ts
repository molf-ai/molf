import { getLogger } from "@logtape/logtape";
import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";

const connLogger = getLogger(["molf", "server", "conn"]);

export const workerHandlers = {
  register: os.worker.register
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      if (context.connectionRegistry.isConnected(input.workerId)) {
        context.connectionRegistry.unregister(input.workerId);
        context.toolDispatch.workerDisconnected(input.workerId);
        context.uploadDispatch.workerDisconnected(input.workerId);
        context.fsDispatch.workerDisconnected(input.workerId);
        connLogger.warn("Worker re-registering (stale cleanup)", { workerName: input.name, workerId: input.workerId });
      }

      context.connectionRegistry.registerWorker({
        id: input.workerId,
        name: input.name,
        connectedAt: Date.now(),
        tools: input.tools,
        skills: input.skills ?? [],
        agents: input.agents ?? [],
        metadata: input.metadata,
      });

      connLogger.info("Worker connected", { workerName: input.name, workerId: input.workerId });

      await context.workspaceStore.ensureDefault(input.workerId);

      return {
        workerId: input.workerId,
        plugins: context.pluginLoader?.workerPluginSpecifiers.map(s => ({ specifier: s })),
      };
    }),

  rename: os.worker.rename
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const worker = context.connectionRegistry.getWorker(input.workerId);
      if (!worker) {
        throw new ORPCError("NOT_FOUND", {
          message: `Worker ${input.workerId} not found`,
        });
      }

      context.connectionRegistry.renameWorker(input.workerId, input.name);
      return { renamed: true };
    }),

  syncState: os.worker.syncState
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const updated = context.connectionRegistry.updateWorkerState(input.workerId, {
        tools: input.tools,
        skills: input.skills ?? [],
        agents: input.agents ?? [],
        metadata: input.metadata,
      });

      if (!updated) {
        throw new ORPCError("NOT_FOUND", {
          message: `Worker ${input.workerId} not found or not connected`,
        });
      }

      connLogger.info("Worker syncState", { workerId: input.workerId, toolCount: input.tools.length, skillCount: (input.skills ?? []).length });

      return { synced: true };
    }),

  onToolCall: os.worker.onToolCall
    .use(authMiddleware)
    .handler(async function* ({ input, context, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), { once: true });

      yield* context.toolDispatch.subscribeWorker(
        input.workerId,
        abortController.signal,
      );
    }),

  onToolCancel: os.worker.onToolCancel
    .use(authMiddleware)
    .handler(async function* ({ input, context, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), { once: true });

      yield* context.cancelNotifier.subscribe(
        input.workerId,
        abortController.signal,
      );
    }),

  toolResult: os.worker.toolResult
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const { toolCallId, output, error, meta, attachments } = input;
      const received = context.toolDispatch.resolveToolCall(toolCallId, {
        output,
        error,
        meta,
        attachments,
      });
      return { received };
    }),

  onUpload: os.worker.onUpload
    .use(authMiddleware)
    .handler(async function* ({ input, context, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), { once: true });

      yield* context.uploadDispatch.subscribeWorker(
        input.workerId,
        abortController.signal,
      );
    }),

  uploadResult: os.worker.uploadResult
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      context.uploadDispatch.resolveUpload(input.uploadId, {
        path: input.path,
        size: input.size,
        error: input.error,
      });
      return { received: true };
    }),

  fetchUpload: os.worker.fetchUpload
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const file = context.uploadDispatch.getUploadFile(input.uploadId);
      if (!file) {
        throw new ORPCError("NOT_FOUND", { message: "Upload not found or expired" });
      }
      return { file };
    }),

  onFsRead: os.worker.onFsRead
    .use(authMiddleware)
    .handler(async function* ({ input, context, signal }) {
      const abortController = new AbortController();
      signal?.addEventListener("abort", () => abortController.abort(), { once: true });

      yield* context.fsDispatch.subscribeWorker(
        input.workerId,
        abortController.signal,
      );
    }),

  fsReadResult: os.worker.fsReadResult
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const received = context.fsDispatch.resolveRead(input.requestId, {
        requestId: input.requestId,
        content: input.content,
        size: input.size,
        encoding: input.encoding,
        error: input.error,
      });
      return { received };
    }),
};
