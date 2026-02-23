import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  waitUntil,
  sleep,
  type TestServer,
  type TestWorker,
} from "../../helpers/index.js";
import type { AgentEvent } from "@molf-ai/protocol";
import { SessionMap } from "../../../client-telegram/src/session-map.js";
import { Renderer } from "../../../client-telegram/src/renderer.js";
import { ApprovalManager } from "../../../client-telegram/src/approval.js";
import { MessageHandler } from "../../../client-telegram/src/handler.js";
import { SessionEventDispatcher } from "../../../client-telegram/src/event-dispatcher.js";
import { subscribeToEvents } from "../../../client-telegram/src/connection.js";

/**
 * Integration tests for the Telegram client.
 *
 * These tests wire up a real Molf server + worker and test the Telegram
 * client modules (SessionMap, Renderer, MessageHandler, ApprovalManager)
 * against them. The grammY Telegram API is mocked since we can't hit
 * the real Telegram servers in tests.
 */

let server: TestServer;
let worker: TestWorker;

/** Create a mock grammY Api object that records all calls. */
function createMockApi() {
  const sentMessages: Array<{ chatId: number; text: string; opts?: any; messageId: number }> = [];
  const editedMessages: Array<{ chatId: number; messageId: number; text: string; opts?: any }> = [];
  const chatActions: Array<{ chatId: number; action: string }> = [];
  const reactions: Array<{ chatId: number; messageId: number; reaction: any }> = [];
  const callbackAnswers: string[] = [];

  let nextMessageId = 1000;

  const api = {
    sendMessage: mock(async (chatId: number, text: string, opts?: any) => {
      const msgId = nextMessageId++;
      sentMessages.push({ chatId, text, opts, messageId: msgId });
      return { message_id: msgId };
    }),
    editMessageText: mock(async (chatId: number, messageId: number, text: string, opts?: any) => {
      editedMessages.push({ chatId, messageId, text, opts });
      return true;
    }),
    sendChatAction: mock(async (chatId: number, action: string) => {
      chatActions.push({ chatId, action });
    }),
    setMessageReaction: mock(async (chatId: number, messageId: number, reaction: any) => {
      reactions.push({ chatId, messageId, reaction });
    }),
    answerCallbackQuery: mock(async (id: string) => {
      callbackAnswers.push(id);
    }),
  };

  return {
    api,
    sentMessages,
    editedMessages,
    chatActions,
    reactions,
    callbackAnswers,
  };
}

beforeAll(async () => {
  server = startTestServer();
  worker = await connectTestWorker(server.url, server.token, "telegram-test-worker", {
    echo: {
      description: "Echo the input text back",
      execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
    },
    greet: {
      description: "Greet a person by name",
      execute: async (args: any) => ({ output: `Hello, ${args.name}!` }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

// ---------- SessionMap ----------

describe("Telegram client integration: SessionMap", () => {
  test("creates sessions on the real server", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(trpc, worker.workerId);

      const sessionId = await sessionMap.getOrCreate(12345);
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");

      // Verify session exists on server
      const loaded = await trpc.session.load.mutate({ sessionId });
      expect(loaded.sessionId).toBe(sessionId);
    } finally {
      wsClient.close();
    }
  });

  test("reuses existing session for same chat", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(trpc, worker.workerId);

      const id1 = await sessionMap.getOrCreate(100);
      const id2 = await sessionMap.getOrCreate(100);
      expect(id1).toBe(id2);
    } finally {
      wsClient.close();
    }
  });

  test("creates separate sessions for different chats", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(trpc, worker.workerId);

      const id1 = await sessionMap.getOrCreate(200);
      const id2 = await sessionMap.getOrCreate(201);
      expect(id1).not.toBe(id2);
    } finally {
      wsClient.close();
    }
  });

  test("createNew replaces session and creates new one on server", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(trpc, worker.workerId);

      const original = await sessionMap.getOrCreate(300);
      const replacement = await sessionMap.createNew(300);

      expect(replacement).not.toBe(original);
      expect(sessionMap.get(300)).toBe(replacement);

      // Both sessions should exist on server
      const loadedOriginal = await trpc.session.load.mutate({ sessionId: original });
      const loadedReplacement = await trpc.session.load.mutate({ sessionId: replacement });
      expect(loadedOriginal.sessionId).toBe(original);
      expect(loadedReplacement.sessionId).toBe(replacement);
    } finally {
      wsClient.close();
    }
  });

  test("sessions appear in server listing", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const sessionMap = new SessionMap(trpc, worker.workerId);
      const sessionId = await sessionMap.getOrCreate(400);

      const listed = await trpc.session.list.query();
      const found = listed.sessions.find((s) => s.sessionId === sessionId);
      expect(found).toBeTruthy();
    } finally {
      wsClient.close();
    }
  });
});

// ---------- Event subscription ----------

describe("Telegram client integration: Event subscription", () => {
  test("subscribeToEvents receives events emitted by the server", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      const events: AgentEvent[] = [];

      const unsub = subscribeToEvents(trpc, session.sessionId, (e) => events.push(e));

      // Allow subscription to fully establish over WebSocket
      await sleep(500);

      // Emit events via the server's EventBus
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(() => events.length >= 1, 3000, "status_change event");

      const statusEvent = events.find((e) => e.type === "status_change");
      expect(statusEvent).toBeTruthy();

      unsub();
    } finally {
      wsClient.close();
    }
  });

  test("receives multiple content_delta events", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      const events: AgentEvent[] = [];

      const unsub = subscribeToEvents(trpc, session.sessionId, (e) => events.push(e));
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "content_delta",
        delta: "Hello",
        content: "Hello",
      });
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "content_delta",
        delta: " world",
        content: "Hello world",
      });

      await waitUntil(() => events.filter((e) => e.type === "content_delta").length >= 2, 3000, "2 content_delta events");

      const deltas = events.filter((e) => e.type === "content_delta");
      expect(deltas.length).toBe(2);

      unsub();
    } finally {
      wsClient.close();
    }
  });

  test("unsubscribe stops receiving events", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      const events: AgentEvent[] = [];

      const unsub = subscribeToEvents(trpc, session.sessionId, (e) => events.push(e));
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(() => events.length >= 1, 3000, "first event");

      unsub();
      const countAfterUnsub = events.length;

      // Emit after unsubscribe
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "idle",
      });

      await sleep(500);

      // Should not have received the second event
      expect(events.length).toBe(countAfterUnsub);
    } finally {
      wsClient.close();
    }
  });
});

// ---------- Renderer ----------

describe("Telegram client integration: Renderer with real server", () => {
  test("renderer receives error events and sends message to chat", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(1001, session.sessionId);

      // Wait for subscription to establish
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "error",
        code: "test_error",
        message: "Test error from server",
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("Test error from server")),
        3000,
        "error message sent",
      );

      const errorMsg = sentMessages.find((m) => m.text.includes("Test error from server"));
      expect(errorMsg!.chatId).toBe(1001);

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("renderer sends tool status on tool_call_start", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(1002, session.sessionId);
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "echo",
        arguments: '{"text":"hello"}',
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "tool status message",
      );

      const toolMsg = sentMessages.find((m) => m.text.includes("echo"));
      expect(toolMsg!.chatId).toBe(1002);

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("renderer handles streaming content deltas", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(1003, session.sessionId);
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "content_delta",
        delta: "Hello from agent.\n\nMore text",
        content: "Hello from agent.\n\nMore text",
      });

      await waitUntil(
        () => sentMessages.length >= 1,
        3000,
        "draft message sent",
      );

      expect(sentMessages.length).toBeGreaterThanOrEqual(1);

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("renderer does not double-subscribe to the same session", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(1004, session.sessionId);
      renderer.startSession(1004, session.sessionId); // duplicate — should be no-op
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "error",
        code: "test",
        message: "Single event test",
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("Single event test")),
        3000,
        "error message",
      );

      // Should only receive the event once (not duplicated)
      const errorMsgs = sentMessages.filter((m) => m.text.includes("Single event test"));
      expect(errorMsgs.length).toBe(1);

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("renderer tracks agent status from server events", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(1005, session.sessionId);
      await sleep(500);

      expect(renderer.getAgentStatus(1005)).toBe("idle");

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(
        () => renderer.getAgentStatus(1005) === "streaming",
        3000,
        "status change to streaming",
      );

      expect(renderer.getAgentStatus(1005)).toBe("streaming");

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });
});

// ---------- ApprovalManager ----------

describe("Telegram client integration: ApprovalManager with real server", () => {
  test("sends inline keyboard on tool_approval_required event", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      approvalMgr.watchSession(2001, session.sessionId);
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_approval_required",
        toolCallId: "tc-approval-1",
        toolName: "dangerous-tool",
        arguments: '{"action":"delete_everything"}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("dangerous-tool")),
        3000,
        "approval message",
      );

      const approvalMsg = sentMessages.find((m) => m.text.includes("dangerous-tool"));
      expect(approvalMsg!.chatId).toBe(2001);
      expect(approvalMsg!.opts?.reply_markup).toBeDefined();

      approvalMgr.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("handles approve callback and edits message", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      approvalMgr.watchSession(2002, session.sessionId);
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_approval_required",
        toolCallId: "tc-approve-test",
        toolName: "echo",
        arguments: '{"text":"test"}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      // Simulate user pressing Approve
      await approvalMgr.handleCallback("cb-1", "tool_approve_tc-approve-test");

      const approvedEdit = editedMessages.find((m) => m.text.includes("Approved"));
      expect(approvedEdit).toBeTruthy();

      approvalMgr.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("handles deny callback and edits message", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      approvalMgr.watchSession(2003, session.sessionId);
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_approval_required",
        toolCallId: "tc-deny-test",
        toolName: "echo",
        arguments: '{"text":"test"}',
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      await approvalMgr.handleCallback("cb-2", "tool_deny_tc-deny-test");

      const deniedEdit = editedMessages.find((m) => m.text.includes("Denied"));
      expect(deniedEdit).toBeTruthy();

      approvalMgr.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("does not duplicate subscriptions", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const approvalMgr = new ApprovalManager({
        api: api as any,
        connection,
        dispatcher,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      approvalMgr.watchSession(2004, session.sessionId);
      approvalMgr.watchSession(2004, session.sessionId); // duplicate
      await sleep(500);

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_approval_required",
        toolCallId: "tc-dup-test",
        toolName: "echo",
        arguments: "{}",
        sessionId: session.sessionId,
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "approval message",
      );

      const approvalMsgs = sentMessages.filter((m) => m.text.includes("echo"));
      expect(approvalMsgs.length).toBe(1);

      approvalMgr.cleanup();
    } finally {
      wsClient.close();
    }
  });
});

// ---------- MessageHandler ----------

describe("Telegram client integration: MessageHandler with real server", () => {
  test("creates session and submits prompt to real server", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const sessionMap = new SessionMap(trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        ackReaction: "eyes",
      });

      const ctx = {
        chat: { id: 3001, type: "private" },
        message: { text: "Hello server!", message_id: 1 },
        from: { id: 9999 },
        api: api as any,
        reply: mock(() => Promise.resolve()),
      } as any;

      await handler.handleMessage(ctx);

      // Session should have been created
      expect(sessionMap.has(3001)).toBe(true);
      const sessionId = sessionMap.get(3001)!;

      // Verify session exists on the real server
      const loaded = await trpc.session.load.mutate({ sessionId });
      expect(loaded.sessionId).toBe(sessionId);

      handler.cleanup();
      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("reuses session across messages", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const sessionMap = new SessionMap(trpc, worker.workerId);
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const handler = new MessageHandler({
        sessionMap,
        connection,
        renderer,
        ackReaction: "eyes",
      });

      const makeCtx = (text: string) => ({
        chat: { id: 3002, type: "private" },
        message: { text, message_id: 1 },
        from: { id: 9999 },
        api: api as any,
        reply: mock(() => Promise.resolve()),
      }) as any;

      await handler.handleMessage(makeCtx("First message"));
      const sessionId1 = sessionMap.get(3002);

      // Wait a moment for the first prompt to settle
      await sleep(200);

      await handler.handleMessage(makeCtx("Second message"));
      const sessionId2 = sessionMap.get(3002);

      expect(sessionId1).toBe(sessionId2);

      handler.cleanup();
      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });
});

// ---------- Full event lifecycle ----------

describe("Telegram client integration: Full event lifecycle", () => {
  test("session create -> status changes -> content -> turn complete", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, chatActions } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(4001, session.sessionId);
      await sleep(500);

      // Start streaming
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(
        () => chatActions.some((a) => a.action === "typing"),
        3000,
        "typing indicator",
      );

      // Emit content (needs paragraph break to trigger chunker emission)
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "content_delta",
        delta: "Hello from agent.\n\nMore text here",
        content: "Hello from agent.\n\nMore text here",
      });

      await waitUntil(
        () => sentMessages.length >= 1,
        3000,
        "draft message",
      );

      // Emit turn complete
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "turn_complete",
        message: {
          id: "msg-1",
          role: "assistant" as const,
          content: "Hello from agent.\n\nMore text here",
          timestamp: Date.now(),
        },
      });

      // Wait for turn_complete processing
      await sleep(500);

      // Should have sent/edited at least one message
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);

      // Transition to idle
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "idle",
      });

      await waitUntil(
        () => renderer.getAgentStatus(4001) === "idle",
        3000,
        "idle status",
      );

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("tool call lifecycle: start -> end with status messages", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(4002, session.sessionId);
      await sleep(500);

      // Tool call start
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_call_start",
        toolCallId: "tc-lifecycle-1",
        toolName: "echo",
        arguments: '{"text":"hello"}',
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("echo")),
        3000,
        "tool status message",
      );

      // Tool call end
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "tool_call_end",
        toolCallId: "tc-lifecycle-1",
        toolName: "echo",
        result: '{"echoed":"hello"}',
      });

      await waitUntil(
        () => editedMessages.some((m) => m.text.includes("Completed")),
        3000,
        "tool completed edit",
      );

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("error event stops streaming and notifies user", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await trpc.session.create.mutate({ workerId: worker.workerId });
      renderer.startSession(4003, session.sessionId);
      await sleep(500);

      // Start streaming
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "content_delta",
        delta: "Partial content here.\n\nMore streaming",
        content: "Partial content here.\n\nMore streaming",
      });

      await waitUntil(
        () => sentMessages.length >= 1,
        3000,
        "draft message",
      );

      // Error interrupts
      server.instance._ctx.eventBus.emit(session.sessionId, {
        type: "error",
        code: "llm_error",
        message: "Model unavailable",
      });

      await waitUntil(
        () => sentMessages.some((m) => m.text.includes("Model unavailable")),
        3000,
        "error message",
      );

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });

  test("multiple chats with separate sessions are isolated", async () => {
    const { trpc, wsClient } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { trpc, wsClient, close: () => wsClient.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session1 = await trpc.session.create.mutate({ workerId: worker.workerId });
      const session2 = await trpc.session.create.mutate({ workerId: worker.workerId });

      renderer.startSession(5001, session1.sessionId);
      renderer.startSession(5002, session2.sessionId);
      await sleep(500);

      // Emit error to session 1 only
      server.instance._ctx.eventBus.emit(session1.sessionId, {
        type: "error",
        code: "err",
        message: "Error for chat 5001",
      });

      await waitUntil(
        () => sentMessages.some((m) => m.chatId === 5001),
        3000,
        "error message for chat 5001",
      );

      // Only chat 5001 should receive the error
      const msgs5001 = sentMessages.filter((m) => m.chatId === 5001);
      const msgs5002 = sentMessages.filter((m) => m.chatId === 5002);
      expect(msgs5001.length).toBeGreaterThanOrEqual(1);
      expect(msgs5002.length).toBe(0);

      renderer.cleanup();
    } finally {
      wsClient.close();
    }
  });
});
