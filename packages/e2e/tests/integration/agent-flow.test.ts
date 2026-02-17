import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  promptAndWait,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker, TestClient } from "../../helpers/index.js";

// =============================================================================
// P0: Full prompt → LLM stream → events → persist flow
// =============================================================================

describe("Agent flow: text streaming", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("Hello from the LLM!"));
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "flow-worker", {
      echo: {
        description: "Echo the input text",
        execute: async (args: any) => ({ echoed: args.text ?? "default" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("full text streaming emits events in correct order", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      // Should have status_change→streaming, content_delta(s), status_change→idle, turn_complete
      const types = events.map((e) => e.type);
      expect(types).toContain("status_change");
      expect(types).toContain("content_delta");
      expect(types).toContain("turn_complete");

      // First event: status_change → streaming
      expect(events[0].type).toBe("status_change");
      expect((events[0] as any).status).toBe("streaming");

      // Content delta with correct text
      const deltas = events.filter((e) => e.type === "content_delta");
      expect(deltas.length).toBeGreaterThan(0);
      const lastDelta = deltas[deltas.length - 1] as any;
      expect(lastDelta.content).toBe("Hello from the LLM!");

      // Last two events: status_change→idle, then turn_complete
      const last2 = events.slice(-2);
      expect(last2[0].type).toBe("status_change");
      expect((last2[0] as any).status).toBe("idle");
      expect(last2[1].type).toBe("turn_complete");
      expect((last2[1] as any).message.content).toBe("Hello from the LLM!");
    } finally {
      client.cleanup();
    }
  });

  test("messages are persisted to session after turn completes", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Persist this message",
      });

      // Wait for persistence
      await sleep(200);

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Should have user message + assistant message
      expect(loaded.messages.length).toBeGreaterThanOrEqual(2);

      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg).toBeTruthy();
      expect(userMsg!.content).toBe("Persist this message");

      const assistantMsg = loaded.messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();
      expect(assistantMsg!.content).toBe("Hello from the LLM!");
    } finally {
      client.cleanup();
    }
  });

  test("turn_complete message has valid id and timestamp", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Check message format",
      });

      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.id).toBeTruthy();
      expect(turnComplete.message.role).toBe("assistant");
      expect(turnComplete.message.timestamp).toBeGreaterThan(0);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// P0: Full tool call round-trip
// =============================================================================

describe("Agent flow: tool call round-trip", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Custom mock that actually invokes tools from the opts.tools parameter,
    // triggering real dispatch to the worker via ToolDispatch.
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        const toolCallId = "tc_mock_1";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "echo",
              input: { text: "hello" },
            };
            // Execute the tool via the registered tool set (dispatches to worker)
            let result: unknown = "fallback";
            const toolDef = opts.tools?.["echo"];
            if (toolDef?.execute) {
              result = await toolDef.execute({ text: "hello" });
            }
            yield {
              type: "tool-result",
              toolCallId,
              toolName: "echo",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      // Second invocation: return final text
      callCount = 0; // reset for next test
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "Tool execution complete" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    });

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "tool-worker", {
      echo: {
        description: "Echo the input text",
        execute: async (args: any) => ({ echoed: args.text ?? "default" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("tool call dispatches to worker and returns result", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Use the echo tool",
      });

      const types = events.map((e) => e.type);

      // Should contain tool_call_start and tool_call_end
      expect(types).toContain("tool_call_start");
      expect(types).toContain("tool_call_end");

      // Verify tool_call_start details
      const tcStart = events.find((e) => e.type === "tool_call_start") as any;
      expect(tcStart.toolName).toBe("echo");

      // Verify tool_call_end has the worker's result
      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd.toolName).toBe("echo");
      expect(tcEnd.result).toContain("echoed");

      // Should end with content_delta (final text), status_change→idle, turn_complete
      expect(types).toContain("content_delta");
      expect(types).toContain("turn_complete");

      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete.message.content).toBe("Tool execution complete");
    } finally {
      client.cleanup();
    }
  });

  test("tool call messages are persisted in session history", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Use echo tool for persistence check",
      });

      await sleep(300);

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Should have: user msg, assistant msg (with toolCalls), tool result msg, final assistant msg
      expect(loaded.messages.length).toBeGreaterThanOrEqual(3);

      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg).toBeTruthy();

      // Should have tool messages
      const toolMsgs = loaded.messages.filter((m) => m.role === "tool");
      expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
      expect(toolMsgs[0].toolName).toBe("echo");

      // Should have final assistant message
      const assistantMsgs = loaded.messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.cleanup();
    }
  });

  test("event order for tool call: streaming → executing_tool → tool events → streaming → idle", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Check event order",
      });

      // Extract status_change events
      const statusChanges = events
        .filter((e) => e.type === "status_change")
        .map((e) => (e as any).status);

      // Expected sequence: streaming → executing_tool → streaming → idle
      expect(statusChanges[0]).toBe("streaming");
      expect(statusChanges).toContain("executing_tool");
      expect(statusChanges[statusChanges.length - 1]).toBe("idle");

      // tool_call_start comes after executing_tool status
      const execToolIdx = events.findIndex(
        (e) => e.type === "status_change" && (e as any).status === "executing_tool",
      );
      const tcStartIdx = events.findIndex((e) => e.type === "tool_call_start");
      expect(tcStartIdx).toBeGreaterThan(execToolIdx);
    } finally {
      client.cleanup();
    }
  });
});
