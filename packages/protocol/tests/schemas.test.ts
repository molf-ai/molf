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
    });
    expect(result.success).toBe(true);
  });

  test("missing workerId fails", () => {
    const result = sessionCreateInput.safeParse({});
    expect(result.success).toBe(false);
  });

  test("invalid UUID fails", () => {
    const result = sessionCreateInput.safeParse({ workerId: "not-a-uuid" });
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
      result: { data: "hello" },
      error: "something went wrong",
    });
    expect(result.success).toBe(true);
  });

  test("accepts null result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts nested JSON objects", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: {
        files: [{ name: "a.txt", size: 100 }],
        metadata: { nested: { deep: true } },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts string result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: "plain text output",
    });
    expect(result.success).toBe(true);
  });

  test("accepts number result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: 42,
    });
    expect(result.success).toBe(true);
  });

  test("accepts boolean result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: false,
    });
    expect(result.success).toBe(true);
  });

  test("accepts array result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: [1, "two", { three: 3 }, [4, null]],
    });
    expect(result.success).toBe(true);
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
      toolCallId: "tc1",
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
      toolCallId: "tc-1",
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

// --- Config schema tests ---

describe("sessionCreateInput config", () => {
  test("accepts config with llm and behavior", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      config: {
        llm: {
          provider: "gemini",
          model: "gemini-2.0-flash",
          temperature: 0.7,
          maxTokens: 4096,
        },
        behavior: {
          maxSteps: 10,
          contextPruning: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts config with partial llm", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      config: {
        llm: { provider: "gemini" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty config object", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      config: {},
    });
    expect(result.success).toBe(true);
  });

  test("accepts metadata record", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      metadata: { source: "telegram", chatId: 12345 },
    });
    expect(result.success).toBe(true);
  });
});

// --- jsonValueSchema comprehensive tests ---

describe("jsonValueSchema via workerToolResultInput", () => {
  test("deeply nested structures", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: {
        level1: {
          level2: {
            level3: [1, "two", { level4: true }],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("empty object result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: {},
    });
    expect(result.success).toBe(true);
  });

  test("empty array result", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc_1",
      result: [],
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
