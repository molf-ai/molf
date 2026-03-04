import { getLogger } from "@logtape/logtape";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../context.js";
import { SessionNotFoundError, AgentBusyError, WorkerDisconnectedError } from "../agent-runner.js";
import { loadSessionOrThrow } from "./_helpers.js";
import {
  agentPromptInput,
  agentUploadInput,
  agentUploadOutput,
  agentShellExecInput,
  agentShellExecOutput,
  agentAbortInput,
  agentStatusInput,
  agentOnEventsInput,
  MAX_ATTACHMENT_BYTES,
  errorMessage,
} from "@molf-ai/protocol";
import type { AgentEvent, ToolCallRequest } from "@molf-ai/protocol";

const agentLogger = getLogger(["molf", "server", "agent"]);

const UPLOAD_TIMEOUT_MS = 30_000;

export const agentRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    const known = ctx.connectionRegistry.getKnownWorkers();
    return {
      workers: known.map((w) => ({
        workerId: w.id,
        name: w.name,
        tools: w.tools,
        skills: w.skills,
        agents: w.agents,
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
      const session = loadSessionOrThrow(ctx.sessionMgr, input.sessionId);
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
      const session = loadSessionOrThrow(ctx.sessionMgr, input.sessionId);

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
