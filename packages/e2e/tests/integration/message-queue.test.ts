import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  collectEvents,
  waitUntil,
  getDefaultWsId,
  sleep,
  clearWsIdCache,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Message queue: queued messages are processed after the current turn completes
// =============================================================================

describe("Message queue — drain after turn", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Each call returns a short text response with a small delay
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      const reply = `response-${callCount}`;
      return {
        fullStream: (async function* () {
          await sleep(50);
          yield { type: "text-delta" as const, text: reply };
          yield { type: "finish" as const, finishReason: "stop" };
        })(),
      };
    });

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "queue-drain-worker");
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("queued message is processed after first turn completes", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(client.client, session.sessionId);
      await started;

      // First prompt — starts streaming
      client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "first",
      });

      // Wait for streaming to start
      await waitUntil(
        () => events.some((e) => e.type === "status_change" && (e as any).status === "streaming"),
        5000,
        "streaming to start",
      );

      // Second prompt — should be queued
      const queueResult = await client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "second",
      });
      expect(queueResult.queued).toBe(true);

      // Verify message_queued event was emitted
      await waitUntil(
        () => events.some((e) => e.type === "message_queued"),
        3000,
        "message_queued event",
      );

      const queuedEvent = events.find((e) => e.type === "message_queued") as any;
      expect(queuedEvent.queuePosition).toBe(1);

      // Wait for two turn_complete events (first turn + queued turn)
      await waitUntil(
        () => events.filter((e) => e.type === "turn_complete").length >= 2,
        15000,
        "two turn_complete events",
      );

      const turnCompletes = events.filter((e) => e.type === "turn_complete");
      expect(turnCompletes.length).toBe(2);

      unsubscribe();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Message queue: abort clears queued messages
// =============================================================================

describe("Message queue — abort clears queue", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        // Slow response so we have time to queue + abort
        for (let i = 0; i < 10; i++) {
          await sleep(30);
          yield { type: "text-delta" as const, text: "." };
        }
        yield { type: "finish" as const, finishReason: "stop" };
      })(),
    }));

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "queue-abort-worker");
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("abort while messages are queued clears the queue", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(client.client, session.sessionId);
      await started;

      // Start first prompt
      client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "slow prompt",
      });

      await waitUntil(
        () => events.some((e) => e.type === "status_change" && (e as any).status === "streaming"),
        5000,
        "streaming to start",
      );

      // Queue two messages
      const q1 = await client.client.agent.prompt({ sessionId: session.sessionId, text: "queued-1" });
      const q2 = await client.client.agent.prompt({ sessionId: session.sessionId, text: "queued-2" });
      expect(q1.queued).toBe(true);
      expect(q2.queued).toBe(true);

      // Abort — should clear queue and stop current turn
      const abortResult = await client.client.agent.abort({ sessionId: session.sessionId });
      expect(abortResult.aborted).toBe(true);

      // Wait for aborted status
      await waitUntil(
        () => events.some((e) => e.type === "status_change" && (e as any).status === "aborted"),
        5000,
        "aborted status",
      );

      // Wait a bit to verify no queued messages get processed
      await sleep(500);

      // At most one turn_complete (from the in-progress turn) — queued messages must not run
      const turnCompletes = events.filter((e) => e.type === "turn_complete");
      expect(turnCompletes.length).toBeLessThanOrEqual(1);

      unsubscribe();
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Message queue: queue full returns TOO_MANY_REQUESTS
// =============================================================================

describe("Message queue — queue full", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        // Very slow response to keep the agent busy
        for (let i = 0; i < 100; i++) {
          await sleep(50);
          yield { type: "text-delta" as const, text: "." };
        }
        yield { type: "finish" as const, finishReason: "stop" };
      })(),
    }));

    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "queue-full-worker");
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("rejects with TOO_MANY_REQUESTS when queue is full", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });

      const { events, started, unsubscribe } = collectEvents(client.client, session.sessionId);
      await started;

      // Start streaming
      client.client.agent.prompt({
        sessionId: session.sessionId,
        text: "keep busy",
      });

      await waitUntil(
        () => events.some((e) => e.type === "status_change" && (e as any).status === "streaming"),
        5000,
        "streaming to start",
      );

      // Fill the queue (max 20)
      for (let i = 0; i < 20; i++) {
        const r = await client.client.agent.prompt({
          sessionId: session.sessionId,
          text: `queued-${i}`,
        });
        expect(r.queued).toBe(true);
      }

      // 21st message should be rejected
      await expect(
        client.client.agent.prompt({
          sessionId: session.sessionId,
          text: "overflow",
        }),
      ).rejects.toThrow(/queue.*full|TOO_MANY_REQUESTS/i);

      unsubscribe();
      await client.client.agent.abort({ sessionId: session.sessionId });
    } finally {
      client.cleanup();
    }
  });
});
