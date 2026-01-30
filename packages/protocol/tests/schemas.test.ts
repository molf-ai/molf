import { describe, expect, test } from "bun:test";
import {
  sessionCreateInput,
  sessionLoadInput,
  sessionDeleteInput,
  agentPromptInput,
  agentAbortInput,
  agentStatusInput,
  agentOnEventsInput,
  agentEventSchema,
  toolListInput,
  toolApproveInput,
  toolDenyInput,
  workerRegisterInput,
  workerRenameInput,
  workerOnToolCallInput,
  workerToolResultInput,
  sessionMessageSchema,
} from "../src/schemas.js";

describe("Session schemas", () => {
  test("sessionCreateInput accepts valid input", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  test("sessionCreateInput accepts optional name and config", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "My Session",
      config: {
        llm: { model: "gemini-2.5-flash" },
        behavior: { maxIterations: 5 },
      },
    });
    expect(result.success).toBe(true);
  });

  test("sessionCreateInput rejects invalid UUID", () => {
    const result = sessionCreateInput.safeParse({
      workerId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("sessionCreateInput rejects missing workerId", () => {
    const result = sessionCreateInput.safeParse({});
    expect(result.success).toBe(false);
  });

  test("sessionLoadInput accepts valid input", () => {
    const result = sessionLoadInput.safeParse({ sessionId: "abc-123" });
    expect(result.success).toBe(true);
  });

  test("sessionDeleteInput accepts valid input", () => {
    const result = sessionDeleteInput.safeParse({ sessionId: "abc-123" });
    expect(result.success).toBe(true);
  });
});

describe("Agent schemas", () => {
  test("agentPromptInput accepts valid input", () => {
    const result = agentPromptInput.safeParse({
      sessionId: "session-1",
      text: "Hello world",
    });
    expect(result.success).toBe(true);
  });

  test("agentPromptInput rejects missing text", () => {
    const result = agentPromptInput.safeParse({ sessionId: "session-1" });
    expect(result.success).toBe(false);
  });

  test("agentAbortInput accepts valid input", () => {
    const result = agentAbortInput.safeParse({ sessionId: "session-1" });
    expect(result.success).toBe(true);
  });

  test("agentStatusInput accepts valid input", () => {
    const result = agentStatusInput.safeParse({ sessionId: "session-1" });
    expect(result.success).toBe(true);
  });

  test("agentOnEventsInput accepts valid input", () => {
    const result = agentOnEventsInput.safeParse({ sessionId: "session-1" });
    expect(result.success).toBe(true);
  });
});

describe("Agent event schema", () => {
  test("validates status_change event", () => {
    const result = agentEventSchema.safeParse({
      type: "status_change",
      status: "streaming",
    });
    expect(result.success).toBe(true);
  });

  test("validates content_delta event", () => {
    const result = agentEventSchema.safeParse({
      type: "content_delta",
      delta: "Hel",
      content: "Hel",
    });
    expect(result.success).toBe(true);
  });

  test("validates tool_call_start event", () => {
    const result = agentEventSchema.safeParse({
      type: "tool_call_start",
      toolCallId: "tc-1",
      toolName: "shell_exec",
      arguments: '{"command":"ls"}',
    });
    expect(result.success).toBe(true);
  });

  test("validates tool_call_end event", () => {
    const result = agentEventSchema.safeParse({
      type: "tool_call_end",
      toolCallId: "tc-1",
      toolName: "shell_exec",
      result: "file1.txt\nfile2.txt",
    });
    expect(result.success).toBe(true);
  });

  test("validates turn_complete event", () => {
    const result = agentEventSchema.safeParse({
      type: "turn_complete",
      message: {
        id: "msg_1",
        role: "assistant",
        content: "Done",
        timestamp: 1234567890,
      },
    });
    expect(result.success).toBe(true);
  });

  test("validates error event", () => {
    const result = agentEventSchema.safeParse({
      type: "error",
      code: "LLM_ERROR",
      message: "Rate limited",
    });
    expect(result.success).toBe(true);
  });

  test("validates tool_approval_required event", () => {
    const result = agentEventSchema.safeParse({
      type: "tool_approval_required",
      toolCallId: "tc-1",
      toolName: "shell_exec",
      arguments: '{"command":"rm -rf /"}',
      sessionId: "session-1",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status value", () => {
    const result = agentEventSchema.safeParse({
      type: "status_change",
      status: "invalid_status",
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown event type", () => {
    const result = agentEventSchema.safeParse({
      type: "unknown_type",
    });
    expect(result.success).toBe(false);
  });
});

describe("Tool schemas", () => {
  test("toolListInput accepts valid input", () => {
    const result = toolListInput.safeParse({ sessionId: "session-1" });
    expect(result.success).toBe(true);
  });

  test("toolApproveInput accepts valid input", () => {
    const result = toolApproveInput.safeParse({
      sessionId: "session-1",
      toolCallId: "tc-1",
    });
    expect(result.success).toBe(true);
  });

  test("toolDenyInput accepts valid input", () => {
    const result = toolDenyInput.safeParse({
      sessionId: "session-1",
      toolCallId: "tc-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("Worker schemas", () => {
  test("workerRegisterInput accepts valid input", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "code-worker",
      tools: [
        {
          name: "shell_exec",
          description: "Execute shell commands",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("workerRegisterInput accepts optional skills and metadata", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "worker",
      tools: [],
      skills: [{ name: "deploy", description: "Deploy the app", content: "## Steps\n1. Build" }],
      metadata: { workdir: "/home/user" },
    });
    expect(result.success).toBe(true);
  });

  test("workerRegisterInput rejects invalid UUID", () => {
    const result = workerRegisterInput.safeParse({
      workerId: "not-uuid",
      name: "worker",
      tools: [],
    });
    expect(result.success).toBe(false);
  });

  test("workerRenameInput accepts valid input", () => {
    const result = workerRenameInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
      name: "new-name",
    });
    expect(result.success).toBe(true);
  });

  test("workerOnToolCallInput accepts valid input", () => {
    const result = workerOnToolCallInput.safeParse({
      workerId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  test("workerToolResultInput accepts valid input", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc-1",
      result: { output: "success" },
    });
    expect(result.success).toBe(true);
  });

  test("workerToolResultInput accepts error field", () => {
    const result = workerToolResultInput.safeParse({
      toolCallId: "tc-1",
      result: null,
      error: "Tool failed",
    });
    expect(result.success).toBe(true);
  });
});

describe("SessionMessage schema", () => {
  test("validates user message", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("validates assistant message with tool calls", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_2",
      role: "assistant",
      content: "",
      toolCalls: [{ toolCallId: "tc_1", toolName: "test", args: {} }],
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("validates tool result message", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_3",
      role: "tool",
      content: "Result data",
      toolCallId: "tc_1",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid role", () => {
    const result = sessionMessageSchema.safeParse({
      id: "msg_1",
      role: "system",
      content: "Hello",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});
