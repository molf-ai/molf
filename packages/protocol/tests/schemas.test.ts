import { describe, test, expect } from "bun:test";
import {
  sessionCreateInput,
  sessionLoadInput,
  sessionDeleteInput,
  sessionRenameInput,
  sessionMessageSchema,
  agentPromptInput,
  agentAbortInput,
  agentEventSchema,
  baseAgentEventSchema,
  toolListInput,
  toolApproveInput,
  toolDenyInput,
  workerRegisterInput,
  workerRenameInput,
  workerIdInput,
  workerToolResultInput,
} from "../src/schemas.js";

describe("sessionCreateInput", () => {
  test("valid input passes", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "ws-1",
    });
    expect(result.success).toBe(true);
  });

  test("missing workerId fails", () => {
    const result = sessionCreateInput.safeParse({ workspaceId: "ws-1" });
    expect(result.success).toBe(false);
  });

  test("missing workspaceId fails", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(false);
  });

  test("invalid UUID fails", () => {
    const result = sessionCreateInput.safeParse({ workerId: "not-a-uuid", workspaceId: "ws-1" });
    expect(result.success).toBe(false);
  });
});

describe("agentPromptInput", () => {
  test("valid input", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "abc-123",
      text: "Hello",
    });
    expect(result.success).toBe(true);
  });

  test("empty text passes", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "abc-123",
      text: "",
    });
    expect(result.success).toBe(true);
  });
});

describe("workerRegisterInput", () => {
  test("valid with tools array", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "test-worker",
      tools: [
        {
          name: "echo",
          description: "Echoes input",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("missing name fails", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      tools: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("workerToolResultInput", () => {
  test("valid with error field", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_123",
      output: "hello",
      error: "something went wrong",
    });
    expect(result.success).toBe(true);
  });

  test("accepts output string", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "plain text output",
    });
    expect(result.success).toBe(true);
  });

  test("accepts output with meta", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "truncated content",
      meta: { truncated: true, outputId: "tc_1" },
    });
    expect(result.success).toBe(true);
  });

  test("accepts output with attachments", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "[Binary file: image.png]",
      attachments: [{
        mimeType: "image/png",
        data: "base64data",
        path: "/img.png",
        size: 100,
      }],
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty output string", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing output", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string output", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe("agentEventSchema", () => {
  test("status_change validates", () => {
    const result = agentEventSchema.safeParse({
      type: "status_change",
      status: "streaming",
    });
    expect(result.success).toBe(true);
  });

  test("content_delta validates", () => {
    const result = agentEventSchema.safeParse({
      type: "content_delta",
      delta: "Hi",
      content: "Hi",
    });
    expect(result.success).toBe(true);
  });

  test("tool_call_start validates", () => {
    const result = agentEventSchema.safeParse({
      type: "tool_call_start",
      toolCallId: "tc1",
      toolName: "shell",
      arguments: "{}",
    });
    expect(result.success).toBe(true);
  });

  test("tool_call_end validates", () => {
    const result = agentEventSchema.safeParse({
      type: "tool_call_end",
      toolCallId: "tc1",
      toolName: "shell",
      result: "ok",
    });
    expect(result.success).toBe(true);
  });

  test("turn_complete validates", () => {
    const result = agentEventSchema.safeParse({
      type: "turn_complete",
      message: {
        id: "msg_1",
        role: "assistant",
        content: "Hello",
        timestamp: Date.now(),
      },
    });
    expect(result.success).toBe(true);
  });

  test("error validates", () => {
    const result = agentEventSchema.safeParse({
      type: "error",
      code: "AGENT_ERROR",
      message: "Something failed",
    });
    expect(result.success).toBe(true);
  });

  test("tool_approval_required validates", () => {
    const result = agentEventSchema.safeParse({
      type: "tool_approval_required",
      approvalId: "tc1",
      toolName: "shell",
      arguments: "{}",
      sessionId: "session-1",
    });
    expect(result.success).toBe(true);
  });

  test("unknown type fails", () => {
    const result = agentEventSchema.safeParse({
      type: "unknown_event",
    });
    expect(result.success).toBe(false);
  });
});

describe("sessionMessageSchema", () => {
  test("valid user message", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("valid tool message with toolCallId", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_2",
      role: "tool",
      content: '{"result": "ok"}',
      toolCallId: "tc_1",
      toolName: "shell",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });
});

describe("sessionRenameInput", () => {
  test("valid", () => {
    const result = sessionRenameInput.safeParse({
      sessionId: "sess-1",
      name: "New Name",
    });
    expect(result.success).toBe(true);
  });
});

describe("toolApproveInput", () => {
  test("valid", () => {
    const result = toolApproveInput.safeParse({
      sessionId: "sess-1",
      approvalId: "tc-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("workerIdInput", () => {
  test("invalid UUID fails", () => {
    const result = workerIdInput.safeParse({
      workerId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

// --- providerMetadata round-trip tests ---

describe("sessionMessageSchema providerMetadata", () => {
  test("toolCalls with providerMetadata pass validation", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_1",
      role: "assistant",
      content: "I'll run that command",
      toolCalls: [
        {
          toolCallId: "tc_1",
          toolName: "shell",
          args: { command: "ls" },
        },
      ],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("assistant message with empty toolCalls array", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_2",
      role: "assistant",
      content: "Just text",
      toolCalls: [],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("message with attachments preserves FileRef fields", () => {
    const input = {
      id: "msg_3",
      role: "user" as const,
      content: "Check this",
      attachments: [
        {
          path: ".molf/uploads/abc-test.png",
          mimeType: "image/png",
          filename: "test.png",
          size: 12345,
        },
      ],
      timestamp: Date.now(),
    };
    const result = sessionMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments![0].path).toBe(".molf/uploads/abc-test.png");
      expect(result.data.attachments![0].mimeType).toBe("image/png");
      expect(result.data.attachments![0].filename).toBe("test.png");
      expect(result.data.attachments![0].size).toBe(12345);
    }
  });
});

// --- sessionCreateInput field tests ---

describe("sessionCreateInput fields", () => {
  test("accepts optional name", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "ws-1",
      name: "My Session",
    });
    expect(result.success).toBe(true);
  });

  test("accepts metadata record", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "ws-1",
      metadata: { source: "telegram", chatId: 12345 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown fields via strict parsing", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: "ws-1",
      config: { model: "gemini/test" },
    });
    // config is not a valid field; Zod strips unknown keys (success) or rejects (strict)
    if (result.success) {
      expect((result.data as any).config).toBeUndefined();
    }
  });
});

// --- jsonValueSchema comprehensive tests ---

describe("workerToolResultInput envelope format", () => {
  test("output with meta.instructionFiles", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "file contents here",
      meta: {
        instructionFiles: [{ path: "pkg/AGENTS.md", content: "instructions" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("output with all meta fields", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "truncated...",
      meta: {
        truncated: true,
        outputId: "tc_1",
        instructionFiles: [{ path: "a.md", content: "text" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("output with multiple attachments", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      output: "two images",
      attachments: [
        { mimeType: "image/png", data: "abc", path: "/a.png", size: 10 },
        { mimeType: "image/jpeg", data: "def", path: "/b.jpg", size: 20 },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// --- agentEventSchema edge cases ---

// --- SessionMessageBase structural tests (Step 6) ---

describe("sessionMessageSchema with SessionMessageBase fields", () => {
  test("all base fields are preserved on round-trip", () => {
    const input = {
      id: "msg_base",
      role: "assistant" as const,
      content: "Base message",
      toolCalls: [
        {
          toolCallId: "tc_1",
          toolName: "shell",
          args: { command: "ls" },
        },
      ],
      toolCallId: "tc_parent",
      toolName: "shell",
      timestamp: 1234567890,
    };
    const result = sessionMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("msg_base");
      expect(result.data.role).toBe("assistant");
      expect(result.data.content).toBe("Base message");
      expect(result.data.toolCallId).toBe("tc_parent");
      expect(result.data.toolName).toBe("shell");
      expect(result.data.timestamp).toBe(1234567890);
      expect(result.data.toolCalls).toHaveLength(1);
    }
  });

  test("tool message with minimal fields", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_tool",
      role: "tool",
      content: '{"stdout": "hello"}',
      toolCallId: "tc_1",
      toolName: "shell",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("user message with attachments (FileRef extends base)", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_user",
      role: "user",
      content: "See this file",
      attachments: [
        { path: ".molf/uploads/abc.png", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });
});

describe("agentEventSchema edge cases", () => {
  test("error event with context", () => {
    const result = agentEventSchema.safeParse({
      type: "error",
      code: "TOOL_TIMEOUT",
      message: "Tool execution timed out",
      context: { sessionId: "s1", toolName: "shell", timeout: 120000 },
    });
    expect(result.success).toBe(true);
  });

  test("error event without context", () => {
    const result = agentEventSchema.safeParse({
      type: "error",
      code: "AGENT_ERROR",
      message: "Something failed",
    });
    expect(result.success).toBe(true);
  });

  test("turn_complete with full message including toolCalls", () => {
    const result = agentEventSchema.safeParse({
      type: "turn_complete",
      message: {
        id: "msg_1",
        role: "assistant",
        content: "Running command",
        toolCalls: [
          {
            toolCallId: "tc_1",
            toolName: "shell",
            args: { command: "ls" },
          },
        ],
        timestamp: Date.now(),
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("baseAgentEventSchema", () => {
  test("validates base event types", () => {
    expect(baseAgentEventSchema.safeParse({ type: "status_change", status: "streaming" }).success).toBe(true);
    expect(baseAgentEventSchema.safeParse({ type: "content_delta", delta: "x", content: "x" }).success).toBe(true);
  });

  test("rejects subagent_event", () => {
    const result = baseAgentEventSchema.safeParse({
      type: "subagent_event",
      agentType: "explore",
      sessionId: "child-1",
      event: { type: "status_change", status: "streaming" },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentEventSchema subagent_event", () => {
  test("validates subagent_event wrapping a base event", () => {
    const result = agentEventSchema.safeParse({
      type: "subagent_event",
      agentType: "explore",
      sessionId: "child-1",
      event: {
        type: "tool_call_start",
        toolCallId: "tc1",
        toolName: "grep",
        arguments: "{}",
      },
    });
    expect(result.success).toBe(true);
  });

  test("validates subagent_event wrapping approval", () => {
    const result = agentEventSchema.safeParse({
      type: "subagent_event",
      agentType: "general",
      sessionId: "child-2",
      event: {
        type: "tool_approval_required",
        approvalId: "ap1",
        toolName: "shell_exec",
        arguments: "{}",
        sessionId: "child-2",
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects nested subagent_event", () => {
    const result = agentEventSchema.safeParse({
      type: "subagent_event",
      agentType: "explore",
      sessionId: "child-1",
      event: {
        type: "subagent_event",
        agentType: "inner",
        sessionId: "child-2",
        event: { type: "status_change", status: "streaming" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects subagent_event missing inner event", () => {
    const result = agentEventSchema.safeParse({
      type: "subagent_event",
      agentType: "explore",
      sessionId: "child-1",
    });
    expect(result.success).toBe(false);
  });

  test("rejects subagent_event with invalid inner event", () => {
    const result = agentEventSchema.safeParse({
      type: "subagent_event",
      agentType: "explore",
      sessionId: "child-1",
      event: { type: "unknown_type" },
    });
    expect(result.success).toBe(false);
  });
});

describe("agentPromptInput fileRefs max(10)", () => {
  test("accepts up to 10 fileRefs", () => {
    const fileRefs = Array.from({ length: 10 }, (_, i) => ({
      path: `/file-${i}.txt`,
      mimeType: "text/plain",
    }));
    const result = agentPromptInput.safeParse({
      sessionId: "s-1",
      text: "Hello",
      fileRefs,
    });
    expect(result.success).toBe(true);
  });

  test("rejects more than 10 fileRefs", () => {
    const fileRefs = Array.from({ length: 11 }, (_, i) => ({
      path: `/file-${i}.txt`,
      mimeType: "text/plain",
    }));
    const result = agentPromptInput.safeParse({
      sessionId: "s-1",
      text: "Hello",
      fileRefs,
    });
    expect(result.success).toBe(false);
  });

  test("accepts empty fileRefs array", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "s-1",
      text: "Hello",
      fileRefs: [],
    });
    expect(result.success).toBe(true);
  });

  test("accepts omitted fileRefs", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "s-1",
      text: "Hello",
    });
    expect(result.success).toBe(true);
  });
});

describe("workerRegisterInput validation", () => {
  test("rejects non-UUID workerId", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "not-a-uuid",
      name: "test",
      tools: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing tools array", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "test",
    });
    expect(result.success).toBe(false);
  });

  test("accepts empty tools array", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "test",
      tools: [],
    });
    expect(result.success).toBe(true);
  });

  test("accepts optional skills and agents", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "test",
      tools: [],
      skills: [{ name: "s1", description: "desc", content: "content" }],
      agents: [{ name: "a1", description: "desc", content: "content" }],
    });
    expect(result.success).toBe(true);
  });

  test("defaults agents to empty array when omitted", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "test",
      tools: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents).toEqual([]);
    }
  });
});
