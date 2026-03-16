import { getLogger } from "@logtape/logtape";
import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "../context.js";
import { SessionNotFoundError, AgentBusyError, WorkerDisconnectedError } from "../agent-runner.js";
import { loadSessionOrThrow } from "./_helpers.js";
import { errorMessage } from "@molf-ai/protocol";
import type { AgentEvent, ToolCallRequest } from "@molf-ai/protocol";

const agentLogger = getLogger(["molf", "server", "agent"]);

export const agentHandlers = {
  list: os.agent.list
    .use(authMiddleware)
    .handler(async ({ context }) => {
      const known = context.connectionRegistry.getKnownWorkers();
      return {
        workers: known.map((w) => ({
          workerId: w.id,
          name: w.name,
          tools: w.tools,
          skills: w.skills,
          agents: w.agents ?? [],
          connected: w.online,
        })),
      };
    }),

  prompt: os.agent.prompt
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      try {
        return await context.agentRunner.prompt(input.sessionId, input.text, input.fileRefs, input.model);
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          throw new ORPCError("NOT_FOUND", { message: err.message });
        }
        if (err instanceof AgentBusyError) {
          throw new ORPCError("CONFLICT", { message: err.message });
        }
        if (err instanceof WorkerDisconnectedError) {
          throw new ORPCError("PRECONDITION_FAILED", { message: err.message });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(err) });
      }
    }),

  shellExec: os.agent.shellExec
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);

      if (input.saveToSession) {
        const status = context.agentRunner.getStatus(input.sessionId);
        if (status === "streaming" || status === "executing_tool") {
          throw new ORPCError("CONFLICT", { message: "Agent is busy, cannot save shell result to session" });
        }
      }

      const worker = context.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "Worker not connected" });
      }

      if (!worker.tools.some((t) => t.name === "shell_exec")) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "Worker does not support shell_exec" });
      }

      agentLogger.info("shell_exec start", {
        sessionId: input.sessionId,
        workerId: session.workerId,
        command: input.command,
        saveToSession: !!input.saveToSession,
      });

      const request: ToolCallRequest = {
        toolCallId: `se_${crypto.randomUUID().slice(0, 8)}`,
        toolName: "shell_exec",
        args: { command: input.command },
      };

      const dispatchResult = await context.toolDispatch.dispatch(session.workerId, request);

      if (dispatchResult.error) {
        if (dispatchResult.error.toLowerCase().includes("disconnect")) {
          throw new ORPCError("PRECONDITION_FAILED", { message: dispatchResult.error });
        }
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: dispatchResult.error });
      }

      const meta = dispatchResult.meta;
      if (!meta || meta.exitCode === undefined) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Unexpected result from worker" });
      }
      const exitCode = meta.exitCode;

      agentLogger.info("shell_exec result", { sessionId: input.sessionId, exitCode });

      if (input.saveToSession) {
        const statusNow = context.agentRunner.getStatus(input.sessionId);
        if (statusNow === "streaming" || statusNow === "executing_tool") {
          agentLogger.warn("shell_exec: skipping session injection — agent became busy during dispatch", { sessionId: input.sessionId });
        } else if (!context.sessionMgr.getActive(input.sessionId)) {
          agentLogger.warn("shell_exec: skipping injection — session deleted during dispatch", { sessionId: input.sessionId });
        } else {
          await context.agentRunner.injectShellResult(input.sessionId, input.command, dispatchResult.output);
        }
      }

      return {
        output: dispatchResult.output,
        exitCode,
        truncated: meta.truncated ?? false,
        outputPath: meta.outputPath,
      };
    }),

  abort: os.agent.abort
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const aborted = context.agentRunner.abort(input.sessionId);
      return { aborted };
    }),

  status: os.agent.status
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const status = context.agentRunner.getStatus(input.sessionId);
      return { status, sessionId: input.sessionId };
    }),

  onEvents: os.agent.onEvents
    .use(authMiddleware)
    .handler(async function* ({ input, context, signal }) {
      const queue: AgentEvent[] = [];
      let resolve: (() => void) | null = null;

      const unsub = context.serverBus.subscribe(input.sessionId, (event) => {
        queue.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      // Replay pending approval events for reconnecting clients
      for (const pending of context.approvalGate.getPendingForSession(input.sessionId)) {
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
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
              const onAbort = () => r();
              signal?.addEventListener("abort", onAbort, { once: true });
              resolve = () => { signal?.removeEventListener("abort", onAbort); r(); };
            });
          }

          while (queue.length > 0) {
            const event = queue.shift()!;
            yield event;
          }
        }
      } finally {
        unsub();
        await context.agentRunner.releaseIfIdle(input.sessionId);
      }
    }),
};
