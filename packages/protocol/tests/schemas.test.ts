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
