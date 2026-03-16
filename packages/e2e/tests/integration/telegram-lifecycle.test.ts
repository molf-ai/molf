import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  waitUntil,
  waitForPersistence,
  type TestServer,
  type TestWorker,
} from "../../helpers/index.js";
import type { AgentEvent } from "@molf-ai/protocol";
import { createMockApi } from "@molf-ai/test-utils";
import { Renderer } from "../../../client-telegram/src/renderer.js";
import { SessionEventDispatcher } from "../../../client-telegram/src/event-dispatcher.js";
import { subscribeToEvents } from "../../../client-telegram/src/connection.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "telegram-lifecycle-worker", {
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

describe("Telegram client integration: Event subscription", () => {
  test("subscribeToEvents receives events emitted by the server", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      const events: AgentEvent[] = [];

      const unsub = subscribeToEvents(client, session.sessionId, (e) => events.push(e));

      // Allow subscription to fully establish over WebSocket
      await waitForPersistence(500);

      // Emit events via the server's EventBus
      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(() => events.length >= 1, 3000, "status_change event");

      const statusEvent = events.find((e) => e.type === "status_change");
      expect(statusEvent).toBeTruthy();

      unsub();
    } finally {
      ws.close();
    }
  });

  test("receives multiple content_delta events", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      const events: AgentEvent[] = [];

      const unsub = subscribeToEvents(client, session.sessionId, (e) => events.push(e));
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "content_delta",
        delta: "Hello",
        content: "Hello",
      });
      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "content_delta",
        delta: " world",
        content: "Hello world",
      });

      await waitUntil(() => events.filter((e) => e.type === "content_delta").length >= 2, 3000, "2 content_delta events");

      const deltas = events.filter((e) => e.type === "content_delta");
      expect(deltas.length).toBe(2);

      unsub();
    } finally {
      ws.close();
    }
  });

  test("unsubscribe stops receiving events", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    try {
      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      const events: AgentEvent[] = [];

      const unsub = subscribeToEvents(client, session.sessionId, (e) => events.push(e));
      await waitForPersistence(500);

      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(() => events.length >= 1, 3000, "first event");

      unsub();
      const countAfterUnsub = events.length;

      // Emit after unsubscribe
      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "status_change",
        status: "idle",
      });

      await waitForPersistence(500);

      // Should not have received the second event
      expect(events.length).toBe(countAfterUnsub);
    } finally {
      ws.close();
    }
  });
});

describe("Telegram client integration: Full event lifecycle", () => {
  test("session create -> status changes -> content -> turn complete", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, chatActions } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      renderer.startSession(4001, session.sessionId);
      await waitForPersistence(500);

      // Start streaming
      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      await waitUntil(
        () => chatActions.some((a) => a.action === "typing"),
        3000,
        "typing indicator",
      );

      // Emit content (needs paragraph break to trigger chunker emission)
      server.instance._ctx.serverBus.emit(session.sessionId, {
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
      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "turn_complete",
        message: {
          id: "msg-1",
          role: "assistant" as const,
          content: "Hello from agent.\n\nMore text here",
          timestamp: Date.now(),
        },
      });

      // Should have sent/edited at least one message
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);

      // Transition to idle
      server.instance._ctx.serverBus.emit(session.sessionId, {
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
      ws.close();
    }
  });

  test("tool call lifecycle: start -> end with status messages", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages, editedMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      renderer.startSession(4002, session.sessionId);
      await waitForPersistence(500);

      // Tool call start
      server.instance._ctx.serverBus.emit(session.sessionId, {
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
      server.instance._ctx.serverBus.emit(session.sessionId, {
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
      ws.close();
    }
  });

  test("error event stops streaming and notifies user", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      renderer.startSession(4003, session.sessionId);
      await waitForPersistence(500);

      // Start streaming
      server.instance._ctx.serverBus.emit(session.sessionId, {
        type: "status_change",
        status: "streaming",
      });

      server.instance._ctx.serverBus.emit(session.sessionId, {
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
      server.instance._ctx.serverBus.emit(session.sessionId, {
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
      ws.close();
    }
  });

  test("multiple chats with separate sessions are isolated", async () => {
    const { client, ws } = createTestClient(server.url, server.token, "telegram-integration-test");
    const { api, sentMessages } = createMockApi();
    try {
      const connection = { client, ws, close: () => ws.close() };
      const dispatcher = new SessionEventDispatcher(connection as any);
      const renderer = new Renderer({
        api: api as any,
        dispatcher,
        streamingThrottleMs: 50,
      });

      const session1 = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });
      const session2 = await client.session.create({ workerId: worker.workerId, workspaceId: await getDefaultWsId(client, worker.workerId) });

      renderer.startSession(5001, session1.sessionId);
      renderer.startSession(5002, session2.sessionId);
      await waitForPersistence(500);

      // Emit error to session 1 only
      server.instance._ctx.serverBus.emit(session1.sessionId, {
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
      ws.close();
    }
  });
});
