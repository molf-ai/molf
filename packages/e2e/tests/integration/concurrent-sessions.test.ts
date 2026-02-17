import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";

let server: TestServer;
let worker: TestWorker;

function createClient(url: string, token: string) {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("token", token);
  wsUrl.searchParams.set("clientId", crypto.randomUUID());
  wsUrl.searchParams.set("name", "test-client");
  const wsClient = createWSClient({ url: wsUrl.toString() });
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });
  return { trpc, wsClient };
}

beforeAll(async () => {
  server = startTestServer();
  worker = await connectTestWorker(server.url, server.token, "concurrent-worker", {
    echo: {
      description: "Echo tool",
      execute: async (args: any) => `echo: ${args.text}`,
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Concurrent Sessions", () => {
  test("create + delete in rapid succession", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const created = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const deleted = await trpc.session.delete.mutate({
        sessionId: created.sessionId,
      });
      expect(deleted.deleted).toBe(true);
      await expect(
        trpc.session.load.query({ sessionId: created.sessionId }),
      ).rejects.toThrow();
    } finally {
      wsClient.close();
    }
  });

  test("concurrent session creates get unique IDs", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          trpc.session.create.mutate({ workerId: worker.workerId }),
        ),
      );
      const ids = new Set(results.map((r) => r.sessionId));
      expect(ids.size).toBe(6);
    } finally {
      wsClient.close();
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

    // Clean up remaining listeners
    expect(true).toBe(true);
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
