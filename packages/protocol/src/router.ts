/**
 * tRPC Router type definition for the Molf protocol.
 *
 * This module defines the full API surface as a tRPC router.
 * The stubs return typed values to produce correct AppRouter type inference.
 * The server creates its own router with real implementations.
 */
import { router, publicProcedure } from "./trpc.js";
import {
  sessionCreateInput,
  sessionListInput,
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
} from "./schemas.js";
import type {
  AgentEvent,
  AgentStatus,
  SessionMessage,
  SessionListItem,
  WorkerToolInfo,
  WorkerSkillInfo,
  ToolCallRequest,
} from "./types.js";

// Type-only stubs — these are never called, they exist solely for type inference
const stub = <T>(v: T): T => v;

// --- Output types for the router ---

interface SessionCreateOutput {
  sessionId: string;
  name: string;
  workerId: string;
  createdAt: number;
}

interface SessionListOutput {
  sessions: SessionListItem[];
}

interface SessionLoadOutput {
  sessionId: string;
  name: string;
  workerId: string;
  messages: SessionMessage[];
}

interface SessionDeleteOutput {
  deleted: boolean;
}

interface SessionRenameOutput {
  renamed: boolean;
}

interface AgentListOutput {
  workers: Array<{
    workerId: string;
    name: string;
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    connected: boolean;
  }>;
}

interface AgentPromptOutput {
  messageId: string;
}

interface AgentAbortOutput {
  aborted: boolean;
}

interface AgentStatusOutput {
  status: AgentStatus;
  sessionId: string;
}

interface ToolListOutput {
  tools: Array<{
    name: string;
    description: string;
    workerId: string;
  }>;
}

interface ToolApproveOutput {
  applied: boolean;
}

interface ToolDenyOutput {
  applied: boolean;
}

interface WorkerRegisterOutput {
  workerId: string;
}

interface WorkerRenameOutput {
  renamed: boolean;
}

interface WorkerToolResultOutput {
  received: boolean;
}

export const appRouter = router({
  session: router({
    create: publicProcedure
      .input(sessionCreateInput)
      .mutation((): SessionCreateOutput => stub({
        sessionId: "", name: "", workerId: "", createdAt: 0,
      })),

    list: publicProcedure
      .input(sessionListInput)
      .query((): SessionListOutput => stub({ sessions: [] })),

    load: publicProcedure
      .input(sessionLoadInput)
      .mutation((): SessionLoadOutput => stub({
        sessionId: "", name: "", workerId: "", messages: [],
      })),

    delete: publicProcedure
      .input(sessionDeleteInput)
      .mutation((): SessionDeleteOutput => stub({ deleted: false })),

    rename: publicProcedure
      .input(sessionRenameInput)
      .mutation((): SessionRenameOutput => stub({ renamed: false })),
  }),

  agent: router({
    list: publicProcedure
      .query((): AgentListOutput => stub({ workers: [] })),

    prompt: publicProcedure
      .input(agentPromptInput)
      .mutation((): AgentPromptOutput => stub({ messageId: "" })),

    abort: publicProcedure
      .input(agentAbortInput)
      .mutation((): AgentAbortOutput => stub({ aborted: false })),

    status: publicProcedure
      .input(agentStatusInput)
      .query((): AgentStatusOutput => stub({ status: "idle", sessionId: "" })),

    onEvents: publicProcedure
      .input(agentOnEventsInput)
      .subscription(async function* (): AsyncGenerator<AgentEvent> {
        // Stub — yields nothing
      }),
  }),

  tool: router({
    list: publicProcedure
      .input(toolListInput)
      .query((): ToolListOutput => stub({ tools: [] })),

    approve: publicProcedure
      .input(toolApproveInput)
      .mutation((): ToolApproveOutput => stub({ applied: false })),

    deny: publicProcedure
      .input(toolDenyInput)
      .mutation((): ToolDenyOutput => stub({ applied: false })),
  }),

  worker: router({
    register: publicProcedure
      .input(workerRegisterInput)
      .mutation((): WorkerRegisterOutput => stub({ workerId: "" })),

    rename: publicProcedure
      .input(workerRenameInput)
      .mutation((): WorkerRenameOutput => stub({ renamed: false })),

    onToolCall: publicProcedure
      .input(workerOnToolCallInput)
      .subscription(async function* (): AsyncGenerator<ToolCallRequest> {
        // Stub — yields nothing
      }),

    toolResult: publicProcedure
      .input(workerToolResultInput)
      .mutation((): WorkerToolResultOutput => stub({ received: false })),
  }),
});

export type AppRouter = typeof appRouter;
