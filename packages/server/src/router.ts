import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "./context.js";
import { SessionNotFoundError, AgentBusyError, WorkerDisconnectedError } from "./agent-runner.js";
import { SessionCorruptError } from "./session-mgr.js";

const connLogger = getLogger(["molf", "server", "conn"]);
const agentLogger = getLogger(["molf", "server", "agent"]);
import {
  sessionCreateInput,
  sessionListInput,
  sessionLoadInput,
  sessionDeleteInput,
  sessionRenameInput,
  sessionSetModelInput,
  agentPromptInput,
  agentUploadInput,
  agentUploadOutput,
  agentShellExecInput,
  agentShellExecOutput,
  agentAbortInput,
  agentStatusInput,
  agentOnEventsInput,
  toolListInput,
  toolApproveInput,
  toolDenyInput,
  workerRegisterInput,
  workerSyncStateInput,
  workerRenameInput,
  workerIdInput,
  workerToolResultInput,
  workerUploadResultInput,
  fsReadInput,
  fsReadOutput,
  workerFsReadResultInput,
  MAX_ATTACHMENT_BYTES,
  errorMessage,
} from "@molf-ai/protocol";
import type { AgentEvent, ToolCallRequest, FsReadRequest } from "@molf-ai/protocol";

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

      const session = await ctx.sessionMgr.create({
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
      return await ctx.sessionMgr.list(
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
      const renamed = await ctx.sessionMgr.rename(input.sessionId, input.name);
      if (!renamed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }
      return { renamed };
    }),

  setModel: authedProcedure
    .input(sessionSetModelInput)
    .mutation(async ({ input, ctx }) => {
      const updated = await ctx.sessionMgr.setModel(input.sessionId, input.model);
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }
      return { updated };
    }),
});

// --- Agent Router ---

const agentRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const known = ctx.connectionRegistry.getKnownWorkers();
    return {
      workers: known.map((w) => ({
        workerId: w.id,
        name: w.name,
        tools: w.tools,
        skills: w.skills,
        connected: w.online,
      })),
    };
  }),

  prompt: authedProcedure
    .input(agentPromptInput)
    .mutation(async ({ input, ctx }) => {
      try {
        return await ctx.agentRunner.prompt(input.sessionId, input.text, input.fileRefs, input.model);
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

  // NOTE: shell_exec via ! is intentionally outside the approval gate.
  // This is a user-initiated command (the human typed it), not an LLM tool call,
  // so it does not require LLM approval. The gate only covers LLM-initiated tool calls.
  shellExec: authedProcedure
    .input(agentShellExecInput)
    .output(agentShellExecOutput)
    .mutation(async ({ input, ctx }) => {
      // 1. Load session
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

      // 2. Guard: if saveToSession, reject when agent is busy (same as agent.prompt)
      if (input.saveToSession) {
        const status = ctx.agentRunner.getStatus(input.sessionId);
        if (status === "streaming" || status === "executing_tool") {
          throw new TRPCError({ code: "CONFLICT", message: "Agent is busy, cannot save shell result to session" });
        }
      }

      // 3. Resolve worker
      const worker = ctx.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Worker not connected" });
      }

      // 4. Capability check
      if (!worker.tools.some((t) => t.name === "shell_exec")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Worker does not support shell_exec" });
      }

      // 5. Audit log
      agentLogger.info("shell_exec start", {
        sessionId: input.sessionId,
        workerId: session.workerId,
        command: input.command,
        saveToSession: !!input.saveToSession,
      });

      // 6. Build request and dispatch
      const request: ToolCallRequest = {
        toolCallId: `se_${crypto.randomUUID().slice(0, 8)}`,
        toolName: "shell_exec",
        args: { command: input.command },
      };

      const dispatchResult = await ctx.toolDispatch.dispatch(session.workerId, request);

      // 7. Handle dispatch error
      if (dispatchResult.error) {
        if (dispatchResult.error.toLowerCase().includes("disconnect")) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: dispatchResult.error });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: dispatchResult.error });
      }

      // 8. Extract exit code from meta
      const meta = dispatchResult.meta;
      if (!meta || meta.exitCode === undefined) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unexpected result from worker" });
      }
      const exitCode = meta.exitCode;

      // 9. Audit log result
      agentLogger.info("shell_exec result", {
        sessionId: input.sessionId,
        exitCode,
      });

      // 10. If saveToSession, inject synthetic messages into session
      if (input.saveToSession) {
        // Re-check agent status: a concurrent agent.prompt may have started during dispatch
        const statusNow = ctx.agentRunner.getStatus(input.sessionId);
        if (statusNow === "streaming" || statusNow === "executing_tool") {
          agentLogger.warn("shell_exec: skipping session injection — agent became busy during dispatch", { sessionId: input.sessionId });
        } else if (!ctx.sessionMgr.getActive(input.sessionId)) {
          agentLogger.warn("shell_exec: skipping injection — session deleted during dispatch", { sessionId: input.sessionId });
        } else {
          await ctx.agentRunner.injectShellResult(input.sessionId, input.command, dispatchResult.output);
        }
      }

      return {
        output: dispatchResult.output,
        exitCode,
        truncated: meta.truncated ?? false,
        outputPath: meta.outputPath,
      };
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

      // Replay pending approval events for reconnecting clients
      for (const pending of ctx.approvalGate.getPendingForSession(input.sessionId)) {
        queue.push({
          type: "tool_approval_required",
          approvalId: pending.approvalId,
          toolName: pending.toolName,
          arguments: pending.args,
          sessionId: input.sessionId,
        });
      }

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
        await ctx.agentRunner.releaseIfIdle(input.sessionId);
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
    .mutation(async ({ input, ctx }) => {
      const response = input.always ? "always" : "once";
      const applied = ctx.approvalGate.reply(input.approvalId, response);
      return { applied };
    }),

  deny: authedProcedure
    .input(toolDenyInput)
    .mutation(async ({ input, ctx }) => {
      const applied = ctx.approvalGate.reply(input.approvalId, "reject", input.feedback);
      return { applied };
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
        ctx.fsDispatch.workerDisconnected(input.workerId);
        connLogger.warn("Worker re-registering (stale cleanup)", { workerName: input.name, workerId: input.workerId });
      }

      ctx.connectionRegistry.registerWorker({
        id: input.workerId,
        name: input.name,
        connectedAt: Date.now(),
        tools: input.tools,
        skills: input.skills ?? [],
        metadata: input.metadata,
      });

      connLogger.info("Worker connected", { workerName: input.name, workerId: input.workerId });

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

// --- Filesystem Router ---

const fsRouter = router({
  read: authedProcedure
    .input(fsReadInput)
    .output(fsReadOutput)
    .mutation(async ({ input, ctx }) => {
      // 1. Load session -> get workerId
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

      // 2. Verify worker is connected
      const worker = ctx.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Worker not connected" });
      }

      // 3. Dispatch fs read request via FsDispatch (30s timeout built into FsDispatch)
      const request: FsReadRequest = {
        requestId: `fs_${crypto.randomUUID().slice(0, 8)}`,
        outputId: input.outputId,
        path: input.path,
      };

      let result;
      try {
        result = await ctx.fsDispatch.dispatch(session.workerId, request);
      } catch (err) {
        if (err instanceof Error && err.message.includes("timeout")) {
          throw new TRPCError({ code: "TIMEOUT", message: "File read timed out" });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: errorMessage(err) });
      }

      if (result.error) {
        if (result.error.toLowerCase().includes("disconnect")) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.error });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
      }

      return {
        content: result.content,
        size: result.size,
        encoding: result.encoding,
      };
    }),
});

// --- Provider Router ---

const providerRouter = router({
  listProviders: authedProcedure.query(async ({ ctx }) => {
    const providers = ctx.providerState.providers;
    return {
      providers: Object.values(providers).map((p) => ({
        id: p.id,
        name: p.name,
        modelCount: Object.keys(p.models).length,
      })),
    };
  }),

  listModels: authedProcedure
    .input(z.object({ providerID: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const providers = ctx.providerState.providers;
      const providerID = input?.providerID;

      const models: Array<{
        id: string;
        name: string;
        providerID: string;
        capabilities: { reasoning: boolean; toolcall: boolean; temperature: boolean };
        cost: { input: number; output: number };
        limit: { context: number; output: number };
        status: string;
      }> = [];

      for (const [pid, provider] of Object.entries(providers)) {
        if (providerID && pid !== providerID) continue;
        for (const model of Object.values(provider.models)) {
          models.push({
            id: `${model.providerID}/${model.id}`,
            name: model.name,
            providerID: model.providerID,
            capabilities: {
              reasoning: model.capabilities.reasoning,
              toolcall: model.capabilities.toolcall,
              temperature: model.capabilities.temperature,
            },
            cost: { input: model.cost.input, output: model.cost.output },
            limit: { context: model.limit.context, output: model.limit.output },
            status: model.status,
          });
        }
      }

      return { models };
    }),
});

// --- Combined Router ---

export const appRouter = router({
  session: sessionRouter,
  agent: agentRouter,
  tool: toolRouter,
  worker: workerRouter,
  fs: fsRouter,
  provider: providerRouter,
});

export type AppRouter = typeof appRouter;
