import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  promptAndCollect,
  waitForPersistence,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Gap 18: Large session message history
//
// Pre-populate a session with 100+ messages via direct SessionManager access,
// then prompt it with context pruning enabled. Verify the agent responds
// successfully despite the large history.
// =============================================================================

describe("Large session message history", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => mockTextResponse("Response after large history"));
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "large-session-worker");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("session with 100+ messages handles prompt with context pruning", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create session with context pruning enabled
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // Pre-populate with 120 messages (60 user + 60 assistant pairs)
      const mgr = server.instance._ctx.sessionMgr;
      for (let i = 0; i < 60; i++) {
        mgr.addMessage(session.sessionId, {
          id: `msg_user_${i}`,
          role: "user",
          content: `User message number ${i}: ${"x".repeat(200)}`,
          timestamp: Date.now() - (60 - i) * 1000,
        });
        mgr.addMessage(session.sessionId, {
          id: `msg_asst_${i}`,
          role: "assistant",
          content: `Assistant response number ${i}: ${"y".repeat(200)}`,
          timestamp: Date.now() - (60 - i) * 1000 + 500,
        });
      }

      // Verify messages were added
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });
      expect(loaded.messages.length).toBe(120);

      // Prompt the session — should succeed despite large history
      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Summarize the conversation",
      });

      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("Response after large history");

      // Verify the new messages were added (user + assistant)
      await waitForPersistence();
      const loadedAfter = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });
      expect(loadedAfter.messages.length).toBe(122); // 120 + user + assistant
    } finally {
      client.cleanup();
    }
  });

  test("session with tool call messages in large history loads correctly", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // Pre-populate with mixed message types including tool calls
      const mgr = server.instance._ctx.sessionMgr;
      for (let i = 0; i < 40; i++) {
        mgr.addMessage(session.sessionId, {
          id: `msg_u_${i}`,
          role: "user",
          content: `Question ${i}`,
          timestamp: Date.now() - (40 - i) * 2000,
        });
        // Assistant with tool call
        mgr.addMessage(session.sessionId, {
          id: `msg_a_tc_${i}`,
          role: "assistant",
          content: "",
          timestamp: Date.now() - (40 - i) * 2000 + 500,
          toolCalls: [{
            toolCallId: `tc_hist_${i}`,
            toolName: "echo",
            arguments: { text: `echo ${i}` },
          }],
        });
        // Tool result
        mgr.addMessage(session.sessionId, {
          id: `msg_tool_${i}`,
          role: "tool",
          content: `echo ${i}`,
          timestamp: Date.now() - (40 - i) * 2000 + 700,
          toolCallId: `tc_hist_${i}`,
          toolName: "echo",
        });
        // Final assistant response
        mgr.addMessage(session.sessionId, {
          id: `msg_a_final_${i}`,
          role: "assistant",
          content: `Done with echo ${i}`,
          timestamp: Date.now() - (40 - i) * 2000 + 900,
        });
      }

      expect(mgr.getMessages(session.sessionId).length).toBe(160);

      // Prompt should succeed
      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Continue",
      });

      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("messages added through prompt path have correct structure", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Verify message structure",
      });

      // Wait for persistence
      await waitForPersistence();

      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Should have at least user + assistant messages
      expect(loaded.messages.length).toBeGreaterThanOrEqual(2);

      for (const msg of loaded.messages) {
        // Every message must have an id
        expect(msg.id).toBeTruthy();
        expect(typeof msg.id).toBe("string");

        // Every message must have a valid role
        expect(msg.role).toBeTruthy();
        expect(["user", "assistant", "tool", "system"]).toContain(msg.role);

        // Every message must have content defined (may be empty string for tool-call assistant messages)
        expect(msg.content).toBeDefined();

        // Every message must have a timestamp
        expect(msg.timestamp).toBeTruthy();
        expect(typeof msg.timestamp).toBe("number");
        expect(msg.timestamp).toBeGreaterThan(0);
      }

      // Verify specific roles are present
      const userMsg = loaded.messages.find((m) => m.role === "user");
      expect(userMsg).toBeTruthy();
      expect(userMsg!.content).toBe("Verify message structure");

      const assistantMsg = loaded.messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeTruthy();
      expect(assistantMsg!.content).toBe("Response after large history");
    } finally {
      client.cleanup();
    }
  });
});
