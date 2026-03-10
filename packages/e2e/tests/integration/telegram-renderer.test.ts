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
import { createMockApi } from "@molf-ai/test-utils";
import { Renderer } from "../../../client-telegram/src/renderer.js";
import { SessionEventDispatcher } from "../../../client-telegram/src/event-dispatcher.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "telegram-renderer-worker", {
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

      const session = await trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(trpc, worker.workerId) });
      renderer.startSession(1001, session.sessionId);

      // Wait for subscription to establish
      await waitForPersistence(500);

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

      const session = await trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(trpc, worker.workerId) });
      renderer.startSession(1002, session.sessionId);
      await waitForPersistence(500);

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

      const session = await trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(trpc, worker.workerId) });
      renderer.startSession(1003, session.sessionId);
      await waitForPersistence(500);

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

      const session = await trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(trpc, worker.workerId) });
      renderer.startSession(1004, session.sessionId);
      renderer.startSession(1004, session.sessionId); // duplicate — should be no-op
      await waitForPersistence(500);

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

      const session = await trpc.session.create.mutate({ workerId: worker.workerId, workspaceId: await getDefaultWsId(trpc, worker.workerId) });
      renderer.startSession(1005, session.sessionId);
      await waitForPersistence(500);

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
