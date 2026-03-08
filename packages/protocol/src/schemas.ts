import { z } from "zod";
import type { JsonValue } from "./types.js";

// --- JSON value schema (recursive, accepts all valid JSON structures) ---

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// --- Config schemas ---

const behaviorConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  maxSteps: z.number().optional(),
  contextPruning: z.boolean().optional(),
  temperature: z.number().optional(),
});

// --- Session schemas ---

export const sessionCreateInput = z.object({
  name: z.string().optional(),
  workerId: z.string().uuid(),
  workspaceId: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const sessionCreateOutput = z.object({
  sessionId: z.string(),
  name: z.string(),
  workerId: z.string(),
  createdAt: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const sessionListInput = z
  .object({
    sessionId: z.string().optional(),
    name: z.string().optional(),
    workerId: z.string().uuid().optional(),
    active: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

export const sessionListOutput = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      name: z.string(),
      workerId: z.string(),
      createdAt: z.number(),
      lastActiveAt: z.number(),
      messageCount: z.number(),
      active: z.boolean(),
      lastMessage: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  total: z.number(),
});

export const sessionLoadInput = z.object({
  sessionId: z.string(),
});

export const fileRefSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  filename: z.string().optional(),
  size: z.number().optional(),
});

export const fileRefInputSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
});

export const sessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  attachments: z.array(fileRefSchema).optional(),
  toolCalls: z
    .array(
      z.object({
        toolCallId: z.string(),
        toolName: z.string(),
        args: z.record(z.string(), z.unknown()),
        providerMetadata: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  timestamp: z.number(),
  synthetic: z.boolean().optional(),
  summary: z.boolean().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  }).optional(),
  model: z.string().optional(),
});

export const sessionLoadOutput = z.object({
  sessionId: z.string(),
  name: z.string(),
  workerId: z.string(),
  messages: z.array(sessionMessageSchema),
});

export const sessionDeleteInput = z.object({
  sessionId: z.string(),
});

export const sessionDeleteOutput = z.object({
  deleted: z.boolean(),
});

export const sessionRenameInput = z.object({
  sessionId: z.string(),
  name: z.string(),
});

export const sessionRenameOutput = z.object({
  renamed: z.boolean(),
});

// --- Agent schemas ---

/** CompactPermission: tool name → action, or tool name → { pattern → action } */
const compactPermissionSchema = z.record(
  z.string(),
  z.union([
    z.enum(["allow", "deny", "ask"]),
    z.record(z.string(), z.enum(["allow", "deny", "ask"])),
  ]),
);

const workerAgentInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  permission: compactPermissionSchema.optional(),
  maxSteps: z.number().optional(),
});

export const agentListOutput = z.object({
  workers: z.array(
    z.object({
      workerId: z.string(),
      name: z.string(),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
        }),
      ),
      skills: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          content: z.string(),
        }),
      ),
      agents: z.array(workerAgentInfoSchema),
      connected: z.boolean(),
    }),
  ),
});

export const agentPromptInput = z.object({
  sessionId: z.string(),
  text: z.string(),
  model: z.string().optional(),
  fileRefs: z.array(fileRefInputSchema).max(10).optional(),
});

export const agentPromptOutput = z.object({
  messageId: z.string(),
});

export const agentAbortInput = z.object({
  sessionId: z.string(),
});

export const agentAbortOutput = z.object({
  aborted: z.boolean(),
});

export const agentStatusInput = z.object({
  sessionId: z.string(),
});

export const agentStatusOutput = z.object({
  status: z.enum(["idle", "streaming", "executing_tool", "error", "aborted"]),
  sessionId: z.string(),
});

export const agentOnEventsInput = z.object({
  sessionId: z.string(),
});

// Base agent event variants (shared between baseAgentEventSchema and agentEventSchema)
const baseAgentEventVariants = [
  z.object({
    type: z.literal("status_change"),
    status: z.enum(["idle", "streaming", "executing_tool", "error", "aborted"]),
  }),
  z.object({
    type: z.literal("content_delta"),
    delta: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.string(),
    truncated: z.boolean().optional(),
    outputId: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn_complete"),
    message: sessionMessageSchema,
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("tool_approval_required"),
    approvalId: z.string(),
    toolName: z.string(),
    arguments: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("context_compacted"),
    summaryMessageId: z.string(),
  }),
] as const;

/** Schema for all concrete event variants (no subagent wrapper). */
export const baseAgentEventSchema = z.discriminatedUnion("type", baseAgentEventVariants);

// AgentEvent schema for subscription yields (base events + subagent wrapper)
export const agentEventSchema = z.discriminatedUnion("type", [
  ...baseAgentEventVariants,
  z.object({
    type: z.literal("subagent_event"),
    agentType: z.string(),
    sessionId: z.string(),
    event: baseAgentEventSchema,
  }),
]);

// --- Tool schemas ---

export const toolListInput = z.object({
  sessionId: z.string(),
});

export const toolListOutput = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      workerId: z.string(),
    }),
  ),
});

export const toolApproveInput = z.object({
  sessionId: z.string(),
  approvalId: z.string(),
  always: z.boolean().optional(),
});

export const toolApproveOutput = z.object({
  applied: z.boolean(),
});

export const toolDenyInput = z.object({
  sessionId: z.string(),
  approvalId: z.string(),
  feedback: z.string().optional(),
});

export const toolDenyOutput = z.object({
  applied: z.boolean(),
});

// --- Worker schemas ---

export const workerRegisterInput = z.object({
  workerId: z.string().uuid(),
  name: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  skills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  agents: z.array(workerAgentInfoSchema).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const workerPluginEntrySchema = z.object({
  specifier: z.string(),
  config: z.unknown().optional(),
});

export const workerRegisterOutput = z.object({
  workerId: z.string(),
  plugins: z.array(workerPluginEntrySchema).optional(),
});

export const workerRenameInput = z.object({
  workerId: z.string().uuid(),
  name: z.string(),
});

export const workerRenameOutput = z.object({
  renamed: z.boolean(),
});

export const workerSyncStateInput = z.object({
  workerId: z.string().uuid(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  skills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  agents: z.array(workerAgentInfoSchema).optional().default([]),
  metadata: z
    .object({
      agentsDoc: z.string().optional(),
    })
    .optional(),
});

export const workerIdInput = z.object({
  workerId: z.string().uuid(),
});

export const workerToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
});

const toolResultMetadataSchema = z.object({
  truncated: z.boolean().optional(),
  outputId: z.string().optional(),
  instructionFiles: z.array(z.object({
    path: z.string(),
    content: z.string(),
  })).optional(),
  exitCode: z.number().optional(),
  outputPath: z.string().optional(),
});

const attachmentSchema = z.object({
  mimeType: z.string(),
  data: z.string(),
  path: z.string(),
  size: z.number(),
});

export const workerToolResultInput = z.object({
  toolCallId: z.string(),
  output: z.string(),
  error: z.string().optional(),
  meta: toolResultMetadataSchema.optional(),
  attachments: z.array(attachmentSchema).optional(),
});

export const workerToolResultOutput = z.object({
  received: z.boolean(),
});

// --- Upload schemas ---

export const agentUploadInput = z.object({
  sessionId: z.string(),
  data: z.string().min(1),        // base64
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

export const agentUploadOutput = z.object({
  path: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

// --- Shell exec schemas ---

export const agentShellExecInput = z.object({
  sessionId: z.string(),
  command: z.string().min(1),
  saveToSession: z.boolean().optional(),
});

export const agentShellExecOutput = z.object({
  output: z.string(),
  exitCode: z.number(),
  truncated: z.boolean(),
  outputPath: z.string().optional(),
});

export const workerUploadRequestSchema = z.object({
  uploadId: z.string(),
  data: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

export const workerUploadResultInput = z.object({
  uploadId: z.string(),
  path: z.string(),
  size: z.number(),
  error: z.string().optional(),
});

export const workerUploadResultOutput = z.object({
  received: z.boolean(),
});

// --- Filesystem protocol schemas ---

export const fsReadInput = z
  .object({
    sessionId: z.string(),
    outputId: z.string().optional(),
    path: z.string().optional(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
  })
  .refine((d) => d.outputId || d.path, { message: "outputId or path required" });

export const fsReadOutput = z.object({
  content: z.string(),
  size: z.number(),
  encoding: z.enum(["utf-8", "base64"]),
});

export const workerFsReadRequestSchema = z.object({
  requestId: z.string(),
  outputId: z.string().optional(),
  path: z.string().optional(),
});

export const workerFsReadResultInput = z.object({
  requestId: z.string(),
  content: z.string(),
  size: z.number(),
  encoding: z.enum(["utf-8", "base64"]),
  error: z.string().optional(),
});

export const workerFsReadResultOutput = z.object({
  received: z.boolean(),
});

// --- Cron schemas ---

export const cronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.number() }),
  z.object({ kind: z.literal("every"), interval_ms: z.number(), anchor_ms: z.number().optional() }),
  z.object({ kind: z.literal("cron"), expr: z.string(), tz: z.string().optional() }),
]);

export const cronPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent_turn"), message: z.string() }),
]);

export const cronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  schedule: cronScheduleSchema,
  payload: cronPayloadSchema,
  workerId: z.string(),
  workspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextRunAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastStatus: z.enum(["ok", "error"]).optional(),
  lastError: z.string().optional(),
  consecutiveErrors: z.number(),
});

export const cronAddInput = z.object({
  name: z.string(),
  schedule: cronScheduleSchema,
  payload: cronPayloadSchema,
  workerId: z.string(),
  workspaceId: z.string(),
  enabled: z.boolean().default(true),
});

export const cronListInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
});

export const cronRemoveInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
  jobId: z.string(),
});

export const cronUpdateInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
  jobId: z.string(),
  enabled: z.boolean().optional(),
  schedule: cronScheduleSchema.optional(),
  payload: cronPayloadSchema.optional(),
  name: z.string().optional(),
});

// --- Workspace schemas ---

export const workspaceConfigSchema = z.object({
  model: z.string().optional(),
});

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  lastSessionId: z.string(),
  sessions: z.array(z.string()),
  createdAt: z.number(),
  config: workspaceConfigSchema,
});

export const workspaceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_created"), sessionId: z.string(), sessionName: z.string() }),
  z.object({ type: z.literal("config_changed"), config: workspaceConfigSchema }),
  z.object({ type: z.literal("cron_fired"), jobId: z.string(), jobName: z.string(), targetSessionId: z.string(), message: z.string().optional(), error: z.string().optional() }),
]);

export const workspaceListInput = z.object({
  workerId: z.string(),
});

export const workspaceListOutput = z.array(workspaceSchema);

export const workspaceCreateInput = z.object({
  workerId: z.string(),
  name: z.string(),
  config: workspaceConfigSchema.optional(),
});

export const workspaceCreateOutput = z.object({
  workspace: workspaceSchema,
  sessionId: z.string(),
});

export const workspaceRenameInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
});

export const workspaceRenameOutput = z.object({
  success: z.boolean(),
});

export const workspaceSetConfigInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
  config: workspaceConfigSchema,
});

export const workspaceSetConfigOutput = z.object({
  success: z.boolean(),
});

export const workspaceSessionsInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
});

export const workspaceSessionsOutput = z.array(
  z.object({
    sessionId: z.string(),
    name: z.string(),
    messageCount: z.number(),
    lastActiveAt: z.number(),
    isLastSession: z.boolean(),
  }),
);

export const workspaceEnsureDefaultInput = z.object({
  workerId: z.string(),
});

export const workspaceEnsureDefaultOutput = z.object({
  workspace: workspaceSchema,
  sessionId: z.string(),
});

export const workspaceOnEventsInput = z.object({
  workerId: z.string(),
  workspaceId: z.string(),
});

// --- Plugin router schemas ---

export const pluginCallInput = z.object({
  plugin: z.string(),
  method: z.string(),
  input: z.unknown(),
});

export const pluginCallOutput = z.object({
  result: z.unknown(),
});

export const pluginListOutput = z.array(z.object({
  name: z.string(),
  routes: z.array(z.string()),
  tools: z.array(z.string()),
}));

// --- Compile-time schema ↔ type drift checks ---
// If a schema and its corresponding type drift apart, these lines will error.

import type {
  SessionMessage,
  AgentEvent,
  BaseAgentEvent,
  FileRef,
  ToolCallRequest,
  UploadRequest,
  FsReadRequest,
  FsReadResult,
  WireToolResult,
  Workspace,
  WorkspaceConfig,
  WorkspaceEvent,
  CronJob,
  CronSchedule,
  CronPayload,
} from "./types.js";

type AssertAssignable<_A extends _B, _B> = true;

// Schema → Type: ensures the schema-inferred type is assignable to the hand-written type
type _CheckSessionMessage = AssertAssignable<z.infer<typeof sessionMessageSchema>, SessionMessage>;
type _CheckBaseAgentEvent = AssertAssignable<z.infer<typeof baseAgentEventSchema>, BaseAgentEvent>;
type _CheckAgentEvent = AssertAssignable<z.infer<typeof agentEventSchema>, AgentEvent>;
type _CheckFileRef = AssertAssignable<z.infer<typeof fileRefSchema>, FileRef>;
type _CheckToolCallRequest = AssertAssignable<z.infer<typeof workerToolCallSchema>, ToolCallRequest>;
type _CheckUploadRequest = AssertAssignable<z.infer<typeof workerUploadRequestSchema>, UploadRequest>;

// Type → Schema: ensures the hand-written type is assignable to the schema-inferred type
type _CheckSessionMessageRev = AssertAssignable<SessionMessage, z.infer<typeof sessionMessageSchema>>;
type _CheckBaseAgentEventRev = AssertAssignable<BaseAgentEvent, z.infer<typeof baseAgentEventSchema>>;
type _CheckAgentEventRev = AssertAssignable<AgentEvent, z.infer<typeof agentEventSchema>>;
type _CheckFileRefRev = AssertAssignable<FileRef, z.infer<typeof fileRefSchema>>;
type _CheckToolCallRequestRev = AssertAssignable<ToolCallRequest, z.infer<typeof workerToolCallSchema>>;
type _CheckUploadRequestRev = AssertAssignable<UploadRequest, z.infer<typeof workerUploadRequestSchema>>;
type _CheckFsReadRequest = AssertAssignable<z.infer<typeof workerFsReadRequestSchema>, FsReadRequest>;
type _CheckFsReadRequestRev = AssertAssignable<FsReadRequest, z.infer<typeof workerFsReadRequestSchema>>;
type _CheckFsReadResult = AssertAssignable<z.infer<typeof workerFsReadResultInput>, FsReadResult>;
type _CheckFsReadResultRev = AssertAssignable<FsReadResult, z.infer<typeof workerFsReadResultInput>>;
type _CheckWireToolResult = AssertAssignable<z.infer<typeof workerToolResultInput>, WireToolResult>;
type _CheckWireToolResultRev = AssertAssignable<WireToolResult, z.infer<typeof workerToolResultInput>>;
type _CheckWorkspace = AssertAssignable<z.infer<typeof workspaceSchema>, Workspace>;
type _CheckWorkspaceRev = AssertAssignable<Workspace, z.infer<typeof workspaceSchema>>;
type _CheckWorkspaceConfig = AssertAssignable<z.infer<typeof workspaceConfigSchema>, WorkspaceConfig>;
type _CheckWorkspaceConfigRev = AssertAssignable<WorkspaceConfig, z.infer<typeof workspaceConfigSchema>>;
type _CheckWorkspaceEvent = AssertAssignable<z.infer<typeof workspaceEventSchema>, WorkspaceEvent>;
type _CheckWorkspaceEventRev = AssertAssignable<WorkspaceEvent, z.infer<typeof workspaceEventSchema>>;
type _CheckCronJob = AssertAssignable<z.infer<typeof cronJobSchema>, CronJob>;
type _CheckCronJobRev = AssertAssignable<CronJob, z.infer<typeof cronJobSchema>>;
type _CheckCronSchedule = AssertAssignable<z.infer<typeof cronScheduleSchema>, CronSchedule>;
type _CheckCronScheduleRev = AssertAssignable<CronSchedule, z.infer<typeof cronScheduleSchema>>;
type _CheckCronPayload = AssertAssignable<z.infer<typeof cronPayloadSchema>, CronPayload>;
type _CheckCronPayloadRev = AssertAssignable<CronPayload, z.infer<typeof cronPayloadSchema>>;
