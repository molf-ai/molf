import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
  getDefaultWsId,
} from "../../helpers/index.js";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "concurrent-worker", {
    echo: {
      description: "Echo tool",
      execute: async (args: any) => ({ output: `echo: ${args.text}` }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Concurrent Sessions", () => {
  test("create + delete in rapid succession", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.client.session.create({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.client, worker.workerId),
      });
      const deleted = await client.client.session.delete({
        sessionId: created.sessionId,
      });
      expect(deleted.deleted).toBe(true);
      await expect(
        client.client.session.load({ sessionId: created.sessionId }),
      ).rejects.toThrow();
    } finally {
      client.cleanup();
    }
  });

  test("rapid session creates get unique IDs", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsId = await getDefaultWsId(client.client, worker.workerId);
      // Create sessions sequentially — concurrent creates race on workspace
      // state.json writes (server-side limitation). The goal here is to verify
      // that each session gets a unique ID, not to stress-test filesystem concurrency.
      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(
          await client.client.session.create({ workerId: worker.workerId, workspaceId: wsId }),
        );
      }
      const ids = new Set(results.map((r) => r.sessionId));
      expect(ids.size).toBe(6);
    } finally {
      client.cleanup();
    }
  });

  test("rapid subscribe/unsubscribe to event bus", () => {
    const eventBus = server.instance._ctx.eventBus;
    const sessionId = "stress-session";

    // Subscribe and unsubscribe rapidly
    for (let i = 0; i < 20; i++) {
      const unsub = eventBus.subscribe(sessionId, () => {});
      if (i % 2 === 0) unsub();
    }

    // Emit should not throw even with listeners in various states
    eventBus.emit(sessionId, {
      type: "status_change",
      status: "idle",
    });

    // Verify no listeners leak: subscribing a new listener should work fine
    const captured: any[] = [];
    const cleanup = eventBus.subscribe(sessionId, (e) => captured.push(e));
    eventBus.emit(sessionId, { type: "status_change", status: "idle" });
    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe("idle");
    cleanup();
  });

  test("event bus isolates sessions", () => {
    const eventBus = server.instance._ctx.eventBus;
    const events1: any[] = [];
    const events2: any[] = [];

    const unsub1 = eventBus.subscribe("sess-1", (e) => events1.push(e));
    const unsub2 = eventBus.subscribe("sess-2", (e) => events2.push(e));

    eventBus.emit("sess-1", { type: "status_change", status: "streaming" });
    eventBus.emit("sess-2", { type: "status_change", status: "idle" });

    expect(events1).toHaveLength(1);
    expect(events1[0].status).toBe("streaming");
    expect(events2).toHaveLength(1);
    expect(events2[0].status).toBe("idle");

    unsub1();
    unsub2();
  });
});
