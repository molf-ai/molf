import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Gap 17: Concurrent tool dispatches to the same worker
//
// Mock the LLM to request two tools in a single step (parallel tool calls).
// Both tool calls are dispatched to the same worker. Verify all dispatches
// resolve correctly and results arrive in the events.
// =============================================================================

describe("Concurrent tool dispatches to same worker", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        // First LLM call: request two tools in parallel
        return {
          fullStream: (async function* () {
            yield { type: "tool-call", toolCallId: "tc_a", toolName: "add", input: { a: 1, b: 2 } };
            yield { type: "tool-call", toolCallId: "tc_b", toolName: "multiply", input: { a: 3, b: 4 } };

            // Execute both tool calls in parallel (simulates parallel dispatch)
            const addDef = opts.tools?.["add"];
            const mulDef = opts.tools?.["multiply"];
            const [addResult, mulResult] = await Promise.all([
              addDef?.execute ? addDef.execute({ a: 1, b: 2 }) : "fallback",
              mulDef?.execute ? mulDef.execute({ a: 3, b: 4 }) : "fallback",
            ]);

            yield { type: "tool-result", toolCallId: "tc_a", toolName: "add", output: addResult };
            yield { type: "tool-result", toolCallId: "tc_b", toolName: "multiply", output: mulResult };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      // Second LLM call: final text
      callCount = 0;
      return mockTextResponse("add=3, multiply=12");
    });

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "math-worker", {
      add: {
        description: "Add two numbers",
        execute: async (args: any) => ({ sum: (args.a ?? 0) + (args.b ?? 0) }),
      },
      multiply: {
        description: "Multiply two numbers",
        execute: async (args: any) => ({ product: (args.a ?? 0) * (args.b ?? 0) }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("parallel tool calls are dispatched and resolved by same worker", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Compute add(1,2) and multiply(3,4)",
      });

      // Both tool calls should appear in events
      const toolStarts = events.filter((e) => e.type === "tool_call_start");
      expect(toolStarts.length).toBe(2);

      const toolNames = toolStarts.map((e) => (e as any).toolName).sort();
      expect(toolNames).toEqual(["add", "multiply"]);

      // Both tool call ends should be present with correct results
      const toolEnds = events.filter((e) => e.type === "tool_call_end");
      expect(toolEnds.length).toBe(2);

      const addEnd = toolEnds.find((e) => (e as any).toolName === "add") as any;
      expect(addEnd).toBeTruthy();
      expect(addEnd.result).toContain("sum");

      const mulEnd = toolEnds.find((e) => (e as any).toolName === "multiply") as any;
      expect(mulEnd).toBeTruthy();
      expect(mulEnd.result).toContain("product");

      // Final turn_complete with LLM's summary
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("add=3, multiply=12");
    } finally {
      client.cleanup();
    }
  });

  test("messages from parallel tool calls are persisted", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Run both tools",
      });

      // Verify turn completed
      expect(events.some((e) => e.type === "turn_complete")).toBe(true);

      await sleep(300);

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Should have: user msg, assistant msg (with 2 toolCalls),
      // 2 tool result msgs, final assistant msg
      expect(loaded.messages.length).toBeGreaterThanOrEqual(4);

      const toolMsgs = loaded.messages.filter((m) => m.role === "tool");
      expect(toolMsgs.length).toBeGreaterThanOrEqual(2);

      const toolNames = toolMsgs.map((m) => m.toolName).sort();
      expect(toolNames).toContain("add");
      expect(toolNames).toContain("multiply");
    } finally {
      client.cleanup();
    }
  });
});
