import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import { startTestServer, connectTestWorker, createTestClient, collectEvents, promptAndWait, waitUntil, getDefaultWsId, clearWsIdCache } from "../../helpers/index.js";
import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

describe("Client Disconnect", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "client-disconnect-worker");
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("client unsubscribes mid-stream but agent continues running", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Hello " };
        await new Promise(r => setTimeout(r, 200));
        yield { type: "text-delta", text: "world" };
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });
      const sessionId = session.sessionId;

      const { events, started, unsubscribe: unsub } = collectEvents(client.trpc, sessionId);

      // Wait for subscription to be established server-side
      await started;

      // Fire and forget — don't await the prompt
      client.trpc.agent.prompt.mutate({
        sessionId,
        text: "Say hello",
      });

      // Wait until at least one event arrives
      await waitUntil(() => events.length > 0, 5000, "at least one event");

      // Unsubscribe mid-stream
      unsub();

      // Wait for the agent to finish on its own
      await waitUntil(
        () => server.instance._ctx.agentRunner.getStatus(sessionId) === "idle",
        10000,
        "agent becomes idle",
      );

      // Load the session and verify messages exist
      const loaded = server.instance._ctx.sessionMgr.load(sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBeGreaterThan(0);
    } finally {
      client.cleanup();
    }
  });

  test("late subscriber to active session receives ongoing events", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Slow " };
        await new Promise(r => setTimeout(r, 300));
        yield { type: "text-delta", text: "response" };
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const client1 = createTestClient(server.url, server.token);
    const client2 = createTestClient(server.url, server.token);
    try {
      const session = await client1.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client1.trpc, worker.workerId),
      });
      const sessionId = session.sessionId;

      // Start the prompt on client1 (don't await — fire and forget)
      // But first set up a subscription so the prompt is sent after it's established
      const { events: events1, started: started1, unsubscribe: unsub1 } = collectEvents(client1.trpc, sessionId);
      await started1;

      client1.trpc.agent.prompt.mutate({
        sessionId,
        text: "Give me a slow response",
      });

      // Wait for agent to start processing (at least one event)
      await waitUntil(() => events1.length > 0, 5000, "agent starts processing");

      // Late subscriber: client2 subscribes while agent is running
      const { events: events2, unsubscribe: unsub2 } = collectEvents(client2.trpc, sessionId);

      // Wait for the agent to finish
      await waitUntil(
        () => events1.some(e => e.type === "turn_complete"),
        10000,
        "turn_complete on client1",
      );

      // Wait for late subscriber to receive turn_complete
      await waitUntil(
        () => events2.some(e => e.type === "turn_complete"),
        5000,
        "turn_complete on late subscriber",
      );

      // The late subscriber should have received some events
      expect(events2.length).toBeGreaterThan(0);

      // At minimum, the late subscriber should see turn_complete
      const hasTurnComplete = events2.some(e => e.type === "turn_complete");
      expect(hasTurnComplete).toBe(true);

      unsub1();
      unsub2();
    } finally {
      client1.cleanup();
      client2.cleanup();
    }
  });
});
