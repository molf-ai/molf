import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  type TestServer,
  type TestWorker,
} from "../../helpers/index.js";
import { createMockApi } from "@molf-ai/test-utils";
import { SessionMap } from "../../../client-telegram/src/session-map.js";
import { Renderer } from "../../../client-telegram/src/renderer.js";
import { MessageHandler } from "../../../client-telegram/src/handler.js";
import { SessionEventDispatcher } from "../../../client-telegram/src/event-dispatcher.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "telegram-handler-worker", {
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
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
      });

      const ctx = {
        chat: { id: 3001, type: "private" },
        message: { text: "Hello server!", message_id: 1 },
        from: { id: 9999 },
        api: api as any,
        reply: vi.fn(() => Promise.resolve()),
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
        approvalManager: { watchSession: () => {} } as any,
        ackReaction: "eyes",
      });

      const makeCtx = (text: string) => ({
        chat: { id: 3002, type: "private" },
        message: { text, message_id: 1 },
        from: { id: 9999 },
        api: api as any,
        reply: vi.fn(() => Promise.resolve()),
      }) as any;

      await handler.handleMessage(makeCtx("First message"));
      const sessionId1 = sessionMap.get(3002);

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
