import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "./context.js";
import {
  sessionCreateInput,
  sessionLoadInput,
  sessionDeleteInput,
  sessionRenameInput,
  agentPromptInput,
  agentAbortInput,
  agentStatusInput,
  agentOnEventsInput,
  toolListInput,
  toolApproveInput,
  toolDenyInput,
  workerRegisterInput,
  workerRenameInput,
  workerOnToolCallInput,
  workerToolResultInput,
} from "@molf-ai/protocol";
import type { AgentEvent, ToolCallRequest } from "@molf-ai/protocol";

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
        config: input.config as any,
      });

      return {
        sessionId: session.sessionId,
        name: session.name,
        workerId: session.workerId,
        createdAt: session.createdAt,
      };
    }),

  list: authedProcedure.query(async ({ ctx }) => {
    return { sessions: ctx.sessionMgr.list() };
  }),

  load: authedProcedure
    .input(sessionLoadInput)
    .mutation(async ({ input, ctx }) => {
      const session = ctx.sessionMgr.load(input.sessionId);
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
        return await ctx.agentRunner.prompt(input.sessionId, input.text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes("not found")) {
          throw new TRPCError({ code: "NOT_FOUND", message });
        }
        if (message.includes("already processing")) {
          throw new TRPCError({ code: "CONFLICT", message });
        }
        if (message.includes("disconnected")) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
      }
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
      }
    }),
});

// --- Tool Router ---

const toolRouter = router({
  list: authedProcedure
    .input(toolListInput)
    .query(async ({ input, ctx }) => {
      const session = ctx.sessionMgr.load(input.sessionId);
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
      // Check for duplicate worker ID
      if (ctx.connectionRegistry.isConnected(input.workerId)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Worker ${input.workerId} is already connected`,
        });
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
    .input(workerOnToolCallInput)
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
});

// --- Combined Router ---

export const appRouter = router({
  session: sessionRouter,
  agent: agentRouter,
  tool: toolRouter,
  worker: workerRouter,
});

export type AppRouter = typeof appRouter;
