import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  waitUntil,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Abort During Tool Execution: abort while a slow tool is executing
// =============================================================================

describe("Abort During Tool Execution", () => {
  let server: TestServer;
  let worker: TestWorker;
  let toolAbortController: AbortController;

  beforeAll(async () => {
    setStreamTextImpl((opts: any) => {
      const toolCallId = "tc_slow_1";
      return {
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId,
            toolName: "slow_tool",
            input: {},
          };
          // Execute the tool — this is a slow operation that can be aborted
          const toolDef = opts.tools?.["slow_tool"];
          let result: unknown = "fallback";
          if (toolDef?.execute) {
            try {
              result = await toolDef.execute({}, { toolCallId });
            } catch {
              // Tool execution interrupted by abort
              return;
            }
          }
          yield {
            type: "tool-result",
            toolCallId,
            toolName: "slow_tool",
            output: result,
          };
          yield { type: "finish", finishReason: "tool-calls" };
        })(),
      };
    });

    server = startTestServer();
    worker = await connectTestWorker(server.url, server.token, "abort-tool-worker", {
      slow_tool: {
        description: "A tool that takes a long time",
        execute: async () => {
          // Use a shorter delay with an abort mechanism to avoid resource leaks.
          // The tool sleeps in small intervals and checks if it should stop.
          toolAbortController = new AbortController();
          for (let i = 0; i < 20; i++) {
            if (toolAbortController.signal.aborted) return { output: "aborted" };
            await Bun.sleep(100);
          }
          return { output: "slow result" };
        },
      },
    });
  });

  afterAll(() => {
    // Ensure any lingering tool execution is cleaned up
    toolAbortController?.abort();
    worker.cleanup();
    server.cleanup();
  });

  test("abort during tool execution transitions agent to aborted", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Start collecting events
      const { events, unsubscribe } = collectEvents(client.trpc, session.sessionId);

      // Give subscription time to establish
      await sleep(100);

      // Send prompt (don't await — it triggers async processing)
      client.trpc.agent.prompt.mutate({
        sessionId: session.sessionId,
        text: "Use the slow tool",
      });

      // Wait for executing_tool status
      await waitUntil(
        () => events.some(
          (e) => e.type === "status_change" && (e as any).status === "executing_tool",
        ),
        5000,
        "executing_tool status",
      );

      // Now abort the agent
      const abortResult = await client.trpc.agent.abort.mutate({
        sessionId: session.sessionId,
      });
      expect(abortResult.aborted).toBe(true);

      // Wait for aborted status
      await waitUntil(
        () => events.some(
          (e) => e.type === "status_change" && (e as any).status === "aborted",
        ),
        5000,
        "aborted status",
      );

      // Verify status sequence includes executing_tool → aborted
      const statusChanges = events
        .filter((e) => e.type === "status_change")
        .map((e) => (e as any).status);
      expect(statusChanges).toContain("executing_tool");
      expect(statusChanges).toContain("aborted");

      // Stop the slow tool to prevent resource leak
      toolAbortController?.abort();

      // Wait a moment to ensure no further events arrive
      await sleep(300);

      // Verify no turn_complete was emitted after abort
      const abortedIdx = events.findIndex(
        (e) => e.type === "status_change" && (e as any).status === "aborted",
      );
      const turnCompleteAfterAbort = events.find(
        (e, i) => e.type === "turn_complete" && i > abortedIdx,
      );
      expect(turnCompleteAfterAbort).toBeUndefined();

      unsubscribe();
    } finally {
      client.cleanup();
    }
  });

  test("abort returns false when agent is idle", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });

      // Agent is idle, abort should return false
      const result = await client.trpc.agent.abort.mutate({
        sessionId: session.sessionId,
      });
      expect(result.aborted).toBe(false);
    } finally {
      client.cleanup();
    }
  });
});
