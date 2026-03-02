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
  config: z
    .object({
      behavior: behaviorConfigSchema.optional(),
      model: z.string().optional(),
    })
    .optional(),
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

export const sessionSetModelInput = z.object({
  sessionId: z.string(),
  model: z.string().nullable(),
});

export const sessionSetModelOutput = z.object({
  updated: z.boolean(),
});

// --- Agent schemas ---

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

// AgentEvent schema for subscription yields
export const agentEventSchema = z.discriminatedUnion("type", [
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
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const workerRegisterOutput = z.object({
  workerId: z.string(),
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

// --- Compile-time schema ↔ type drift checks ---
// If a schema and its corresponding type drift apart, these lines will error.

import type {
  SessionMessage,
  AgentEvent,
  FileRef,
  ToolCallRequest,
  UploadRequest,
  FsReadRequest,
  FsReadResult,
  WireToolResult,
} from "./types.js";

type AssertAssignable<_A extends _B, _B> = true;

// Schema → Type: ensures the schema-inferred type is assignable to the hand-written type
type _CheckSessionMessage = AssertAssignable<z.infer<typeof sessionMessageSchema>, SessionMessage>;
type _CheckAgentEvent = AssertAssignable<z.infer<typeof agentEventSchema>, AgentEvent>;
type _CheckFileRef = AssertAssignable<z.infer<typeof fileRefSchema>, FileRef>;
type _CheckToolCallRequest = AssertAssignable<z.infer<typeof workerToolCallSchema>, ToolCallRequest>;
type _CheckUploadRequest = AssertAssignable<z.infer<typeof workerUploadRequestSchema>, UploadRequest>;

// Type → Schema: ensures the hand-written type is assignable to the schema-inferred type
type _CheckSessionMessageRev = AssertAssignable<SessionMessage, z.infer<typeof sessionMessageSchema>>;
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
