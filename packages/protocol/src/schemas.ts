import { z } from "zod";

// --- Session schemas ---

export const sessionCreateInput = z.object({
  name: z.string().optional(),
  workerId: z.string().uuid(),
  config: z
    .object({
      llm: z.record(z.string(), z.unknown()).optional(),
      behavior: z.record(z.string(), z.unknown()).optional(),
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
    workerId: z.string().uuid().optional(),
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
});

export const sessionLoadInput = z.object({
  sessionId: z.string(),
});

export const sessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        toolCallId: z.string(),
        toolName: z.string(),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  timestamp: z.number(),
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
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.string(),
    sessionId: z.string(),
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
  toolCallId: z.string(),
});

export const toolApproveOutput = z.object({
  applied: z.boolean(),
});

export const toolDenyInput = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
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

export const workerOnToolCallInput = z.object({
  workerId: z.string().uuid(),
});

export const workerToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const workerToolResultInput = z.object({
  toolCallId: z.string(),
  result: z.unknown(),
  error: z.string().optional(),
});

export const workerToolResultOutput = z.object({
  received: z.boolean(),
});
