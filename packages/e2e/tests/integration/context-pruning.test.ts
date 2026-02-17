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
// Context pruning: small context passthrough
// =============================================================================

describe("Context pruning: small context passthrough", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("Small context OK"));
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "prune-worker", {
      echo: {
        description: "Echo input",
        execute: async (args: any) => ({ echoed: args.text ?? "default" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("small context with pruning enabled works normally", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        config: { behavior: { contextPruning: true } },
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Hello",
      });

      const types = events.map((e) => e.type);
      expect(types).toContain("content_delta");
      expect(types).toContain("turn_complete");

      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete.message.content).toBe("Small context OK");
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Context pruning: error recovery on context length error
// =============================================================================

describe("Context pruning: error recovery", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "recovery-worker", {
      echo: {
        description: "Echo input",
        execute: async (args: any) => ({ echoed: args.text ?? "default" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("recovers from context_length_exceeded by retrying with aggressive pruning", async () => {
    let callCount = 0;
    let streamTextCalls: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      streamTextCalls.push(args);
      callCount++;
      if (callCount === 1) {
        throw new Error("context_length_exceeded: request too large");
      }
      return mockTextResponse("Recovered after pruning");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Trigger error recovery",
      });

      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("Recovered after pruning");

      // streamText should have been called twice (fail + retry)
      expect(streamTextCalls.length).toBe(2);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Context pruning: session messages persist unmodified
// =============================================================================

describe("Context pruning: session persistence", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Tool call mock: first call does tool dispatch, second returns final text
    let perSessionCallCount = 0;
    setStreamTextImpl((opts: any) => {
      perSessionCallCount++;
      if (perSessionCallCount === 1) {
        const toolCallId = "tc_prune_1";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "big_result",
              input: {},
            };
            let result: unknown = "fallback";
            const toolDef = opts.tools?.["big_result"];
            if (toolDef?.execute) {
              result = await toolDef.execute({});
            }
            yield {
              type: "tool-result",
              toolCallId,
              toolName: "big_result",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      perSessionCallCount = 0; // reset for next session
      return mockTextResponse("Final answer after tool use");
    });

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "persist-worker", {
      big_result: {
        description: "Returns a large result",
        execute: async () => "R".repeat(5000),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("session messages retain full tool results after pruning-enabled prompt", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        config: { behavior: { contextPruning: true } },
      });

      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "Use big_result tool",
      });

      // Wait for persistence
      await sleep(300);

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Should have messages persisted
      expect(loaded.messages.length).toBeGreaterThanOrEqual(3);

      // Tool result should be persisted in full (pruning is in-memory only)
      const toolMsgs = loaded.messages.filter((m) => m.role === "tool");
      expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
      // The tool result content should contain the full result
      expect(toolMsgs[0].content).toContain("R".repeat(100));

      // Final assistant response should be persisted
      const assistantMsgs = loaded.messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.cleanup();
    }
  });
});
