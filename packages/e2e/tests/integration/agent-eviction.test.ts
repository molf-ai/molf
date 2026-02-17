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

import type { TestServer, TestWorker } from "../../helpers/index.js";

describe("Agent idle eviction and recreation", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        // First prompt, first LLM call: trigger tool call
        const toolCallId = "tc_evict_1";
        return {
          fullStream: (async function* () {
            yield { type: "tool-call", toolCallId, toolName: "note", input: { text: "important data" } };
            let result: unknown = "fallback";
            const toolDef = opts.tools?.["note"];
            if (toolDef?.execute) result = await toolDef.execute({ text: "important data" });
            yield { type: "tool-result", toolCallId, toolName: "note", output: result };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      if (callCount === 2) {
        // First prompt, second LLM call: final text after tool
        return mockTextResponse("Noted: important data");
      }
      // After eviction, subsequent prompts get a fresh response
      return mockTextResponse("I remember the context");
    });

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "evict-worker", {
      note: {
        description: "Take a note",
        execute: async (args: any) => ({ noted: args.text ?? "nothing" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("evicted agent is recreated with full message history on next prompt", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // 1. Create session
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // 2. First prompt: builds message history with tool call
      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Take a note for me",
      });

      // Verify first prompt succeeded with tool call
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_call_start");
      expect(types).toContain("turn_complete");

      // Wait for persistence
      await sleep(300);

      // 3. Verify messages are persisted
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });
      const msgCountBefore = loaded.messages.length;
      // user + assistant(with toolCalls) + tool result + assistant(final)
      expect(msgCountBefore).toBeGreaterThanOrEqual(3);

      // 4. Evict the agent from cache
      server.instance._ctx.agentRunner.evict(session.sessionId);

      // Verify agent is evicted (status should be idle since no cached agent)
      const status = server.instance._ctx.agentRunner.getStatus(session.sessionId);
      expect(status).toBe("idle");

      // 5. Prompt again — agent should be recreated from persisted messages
      const { events: secondEvents } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "What did I ask before?",
      });

      // Verify second prompt succeeded
      const secondTypes = secondEvents.map((e) => e.type);
      expect(secondTypes).toContain("turn_complete");

      const turnComplete = secondEvents.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete.message.content).toBe("I remember the context");

      // 6. Wait and verify messages grew (new user + assistant messages)
      await sleep(300);
      const loadedAfter = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });
      expect(loadedAfter.messages.length).toBeGreaterThan(msgCountBefore);

      // Second user message should be in history
      const secondUserMsg = loadedAfter.messages.find(
        (m) => m.role === "user" && m.content === "What did I ask before?",
      );
      expect(secondUserMsg).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});
