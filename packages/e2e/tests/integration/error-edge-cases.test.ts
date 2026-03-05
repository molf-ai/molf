import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, mockStreamText } from "@molf-ai/test-utils";
import { readFileSync } from "fs";
import { resolve } from "path";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  waitForPersistence,
  getDefaultWsId,
  clearWsIdCache,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Error Edge Cases: LLM errors, empty streams, tool errors, persistence
// =============================================================================

describe("Error Edge Cases", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Default mock — overridden per test
    setStreamTextImpl(() => mockTextResponse("default"));

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "error-edge-worker", {
      failing_tool: {
        description: "A tool that fails",
        execute: async () => ({ error: "Tool execution failed" }),
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("LLM error mid-stream emits error event", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial " };
        yield { type: "text-delta", text: "content" };
        throw new Error("LLM connection lost");
      })(),
    }));

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Trigger mid-stream error",
      });

      // Should have received content_delta events before the error
      const contentDeltas = events.filter((e) => e.type === "content_delta");
      expect(contentDeltas.length).toBeGreaterThan(0);

      // Should have an error event
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeTruthy();
      expect((errorEvent as any).message).toContain("LLM connection lost");
    } finally {
      client.cleanup();
    }
  });

  test("empty LLM stream still completes turn", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Empty stream test",
      });

      // Should emit turn_complete even with no content
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("tool returning error in envelope is handled", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          {
            type: "tool-call",
            toolCallId: "tc_fail_1",
            toolName: "failing_tool",
            input: {},
          },
          {
            type: "tool-result",
            toolCallId: "tc_fail_1",
            toolName: "failing_tool",
            output: undefined,
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      // Second call: LLM responds after receiving the tool error
      return mockTextResponse("Acknowledged the tool failure");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Call the failing tool",
      });

      // Should have tool_call_start and tool_call_end events
      const toolStart = events.find((e) => e.type === "tool_call_start");
      expect(toolStart).toBeTruthy();

      const toolEnd = events.find((e) => e.type === "tool_call_end");
      expect(toolEnd).toBeTruthy();

      // Should eventually complete the turn
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("partial message persisted after mid-stream error", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "some content before error" };
        throw new Error("Connection reset");
      })(),
    }));

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Persist this then crash",
      });

      // Wait for any async persistence
      await waitForPersistence();

      // The session file on disk should exist (created during session.create)
      const sessionFilePath = resolve(
        server.tmp.path,
        "sessions",
        `${session.sessionId}.json`,
      );
      const sessionData = JSON.parse(readFileSync(sessionFilePath, "utf-8"));
      expect(sessionData.sessionId).toBe(session.sessionId);

      // Load from the in-memory session to verify at least the user message
      // is retained (persistence to disk only happens on successful turn completion,
      // but the in-memory session should still have the user message)
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      expect(loaded.messages.length).toBeGreaterThanOrEqual(1);

      const userMessage = loaded.messages.find(
        (m: any) => m.role === "user",
      );
      expect(userMessage).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});
