import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "./context.js";
import { SessionNotFoundError, AgentBusyError, WorkerDisconnectedError } from "./agent-runner.js";
import { SessionCorruptError } from "./session-mgr.js";
import {
  sessionCreateInput,
  sessionListInput,
  sessionLoadInput,
  sessionDeleteInput,
  sessionRenameInput,
  agentPromptInput,
  agentUploadInput,
  agentUploadOutput,
  agentAbortInput,
  agentStatusInput,
  agentOnEventsInput,
  toolListInput,
  toolApproveInput,
  toolDenyInput,
  workerRegisterInput,
  workerRenameInput,
  workerIdInput,
  workerToolResultInput,
  workerUploadResultInput,
  MAX_ATTACHMENT_BYTES,
  errorMessage,
} from "@molf-ai/protocol";
import type { AgentEvent, ToolCallRequest } from "@molf-ai/protocol";

const UPLOAD_TIMEOUT_MS = 30_000;

// --- Session Router ---

const sessionRouter = router({
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

      const session = ctx.sessionMgr.create({
        name: input.name,
        workerId: input.workerId,
        config: input.config,
        metadata: input.metadata,
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
      return ctx.sessionMgr.list(
        isActive,
        Object.keys(filters).length > 0 ? filters : undefined,
        limit !== undefined || offset !== undefined ? { limit, offset } : undefined,
      );
    }),

  load: authedProcedure
    .input(sessionLoadInput)
    .mutation(async ({ input, ctx }) => {
      let session;
      try {
        session = ctx.sessionMgr.load(input.sessionId);
      } catch (err) {
        if (err instanceof SessionCorruptError) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
        }
        throw err;
      }
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }

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
      const renamed = ctx.sessionMgr.rename(input.sessionId, input.name);
      if (!renamed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }
      return { renamed };
    }),
});

// --- Agent Router ---

const agentRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const workers = ctx.connectionRegistry.getWorkers();
    return {
      workers: workers.map((w) => ({
        workerId: w.id,
        name: w.name,
        tools: w.tools,
        skills: w.skills,
        connected: true,
      })),
    };
  }),

  prompt: authedProcedure
    .input(agentPromptInput)
    .mutation(async ({ input, ctx }) => {
      try {
        return await ctx.agentRunner.prompt(input.sessionId, input.text, input.fileRefs);
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        if (err instanceof AgentBusyError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        if (err instanceof WorkerDisconnectedError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errorMessage(err) });
      }
    }),

  upload: authedProcedure
    .input(agentUploadInput)
    .output(agentUploadOutput)
    .mutation(async ({ input, ctx }) => {
      // 1. Validate size
      const rawSize = Math.floor(input.data.length * 3 / 4);
      if (rawSize > MAX_ATTACHMENT_BYTES) {
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "File too large (max 15MB)" });
      }

      // 2. Look up session → worker
      let session;
      try {
        session = ctx.sessionMgr.load(input.sessionId);
      } catch (err) {
        if (err instanceof SessionCorruptError) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
        }
        throw err;
      }
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }
      const worker = ctx.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Worker not connected" });
      }

      // 3. Forward to worker via UploadDispatch (with timeout)
      const uploadId = `upload_${crypto.randomUUID().slice(0, 8)}`;
      let result: { path: string; size: number; error?: string };
      let timer: ReturnType<typeof setTimeout>;
      try {
        result = await Promise.race([
          ctx.uploadDispatch.dispatch(session.workerId, {
            uploadId,
            data: input.data,
            filename: input.filename,
            mimeType: input.mimeType,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Upload timeout")), UPLOAD_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        throw new TRPCError({
          code: "TIMEOUT",
          message: errorMessage(err),
        });
      } finally {
        clearTimeout(timer!);
      }

      if (result.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
      }

      // 4. Cache image bytes for inline
      if (input.mimeType.startsWith("image/")) {
        const buffer = Buffer.from(input.data, "base64");
        ctx.inlineMediaCache.save(result.path, new Uint8Array(buffer), input.mimeType);
      }

      return { path: result.path, mimeType: input.mimeType, size: result.size };
    }),

  abort: authedProcedure
    .input(agentAbortInput)
    .mutation(async ({ input, ctx }) => {
      const aborted = ctx.agentRunner.abort(input.sessionId);
      return { aborted };
    }),

  status: authedProcedure
    .input(agentStatusInput)
    .query(async ({ input, ctx }) => {
      const status = ctx.agentRunner.getStatus(input.sessionId);
      return { status, sessionId: input.sessionId };
    }),

  onEvents: authedProcedure
    .input(agentOnEventsInput)
    .subscription(async function* ({ input, ctx, signal }) {
      // Create a queue for events
      const queue: AgentEvent[] = [];
      let resolve: (() => void) | null = null;

      const unsub = ctx.eventBus.subscribe(input.sessionId, (event) => {
        queue.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      try {
        while (!signal?.aborted) {
          // Wait for events
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
              // Also resolve on abort
              signal?.addEventListener("abort", () => r(), { once: true });
            });
          }

          // Drain queue
          while (queue.length > 0) {
            const event = queue.shift()!;
            yield event;
          }
        }
      } finally {
        unsub();
        ctx.agentRunner.releaseIfIdle(input.sessionId);
      }
    }),
});

// --- Tool Router ---

const toolRouter = router({
  list: authedProcedure
    .input(toolListInput)
    .query(async ({ input, ctx }) => {
      let session;
      try {
        session = ctx.sessionMgr.load(input.sessionId);
      } catch (err) {
        if (err instanceof SessionCorruptError) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message });
        }
        throw err;
      }
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }

      const worker = ctx.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        return { tools: [] };
      }

      return {
        tools: worker.tools.map((t) => ({
          name: t.name,
          description: t.description,
          workerId: session.workerId,
        })),
      };
    }),

  approve: authedProcedure
    .input(toolApproveInput)
    .mutation(async ({ input }) => {
      // v1: all tools are auto-approved. Infrastructure for future use.
      return { applied: true };
    }),

  deny: authedProcedure
    .input(toolDenyInput)
    .mutation(async ({ input }) => {
      // v1: all tools are auto-approved. Infrastructure for future use.
      return { applied: false };
    }),
});

// --- Worker Router ---

const workerRouter = router({
  register: authedProcedure
    .input(workerRegisterInput)
    .mutation(async ({ input, ctx }) => {
      // If the same worker ID is already registered (e.g., reconnecting before
      // the old connection's close event fired), clean up the stale entry.
      if (ctx.connectionRegistry.isConnected(input.workerId)) {
        ctx.connectionRegistry.unregister(input.workerId);
        ctx.toolDispatch.workerDisconnected(input.workerId);
        ctx.uploadDispatch.workerDisconnected(input.workerId);
        console.log(
          `[${new Date().toISOString()}] worker re-registering (stale cleanup): ${input.name} (id=${input.workerId})`,
        );
      }

      ctx.connectionRegistry.registerWorker({
        id: input.workerId,
        name: input.name,
        connectedAt: Date.now(),
        tools: input.tools,
        skills: input.skills ?? [],
        metadata: input.metadata,
      });

      console.log(
        `[${new Date().toISOString()}] worker connected: ${input.name} (id=${input.workerId})`,
      );

      return { workerId: input.workerId };
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

      // Update name in registry
      worker.name = input.name;
      return { renamed: true };
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
      const received = ctx.toolDispatch.resolveToolCall(
        input.toolCallId,
        input.result,
        input.error,
      );
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
});

// --- Combined Router ---

export const appRouter = router({
  session: sessionRouter,
  agent: agentRouter,
  tool: toolRouter,
  worker: workerRouter,
});

export type AppRouter = typeof appRouter;
