import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/protocol";

let server: TestServer;
let workerA: TestWorker;
let workerB: TestWorker;

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
  workerA = await connectTestWorker(server.url, server.token, "worker-A", {
    toolA: {
      description: "Tool from worker A",
      execute: async () => "result-A",
    },
  });
  workerB = await connectTestWorker(server.url, server.token, "worker-B", {
    toolB: {
      description: "Tool from worker B",
      execute: async () => "result-B",
    },
  });
});

afterAll(() => {
  workerA.cleanup();
  workerB.cleanup();
  server.cleanup();
});

describe("Server Multi-Worker", () => {
  test("both workers visible in agent.list", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.agent.list.query();
      const ids = result.workers.map((w) => w.workerId);
      expect(ids).toContain(workerA.workerId);
      expect(ids).toContain(workerB.workerId);
    } finally {
      wsClient.close();
    }
  });

  test("workers have distinct tools", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.agent.list.query();
      const wA = result.workers.find((w) => w.workerId === workerA.workerId)!;
      const wB = result.workers.find((w) => w.workerId === workerB.workerId)!;
      expect(wA.tools.find((t) => t.name === "toolA")).toBeTruthy();
      expect(wB.tools.find((t) => t.name === "toolB")).toBeTruthy();
    } finally {
      wsClient.close();
    }
  });

  test("session bound to worker-A dispatches to worker-A", async () => {
    const td = server.instance._ctx.toolDispatch;
    const result = await td.dispatch(workerA.workerId, {
      toolCallId: "tc-multi-A",
      toolName: "toolA",
      args: {},
    });
    expect(result.result).toBe("result-A");
  });

  test("session bound to worker-B dispatches to worker-B", async () => {
    const td = server.instance._ctx.toolDispatch;
    const result = await td.dispatch(workerB.workerId, {
      toolCallId: "tc-multi-B",
      toolName: "toolB",
      args: {},
    });
    expect(result.result).toBe("result-B");
  });

  test("concurrent tool dispatches to different workers", async () => {
    const td = server.instance._ctx.toolDispatch;
    const [resultA, resultB] = await Promise.all([
      td.dispatch(workerA.workerId, {
        toolCallId: "tc-concurrent-A",
        toolName: "toolA",
        args: {},
      }),
      td.dispatch(workerB.workerId, {
        toolCallId: "tc-concurrent-B",
        toolName: "toolB",
        args: {},
      }),
    ]);
    expect(resultA.result).toBe("result-A");
    expect(resultB.result).toBe("result-B");
  });

  test("concurrent session creates get unique IDs", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const [s1, s2, s3] = await Promise.all([
        trpc.session.create.mutate({ workerId: workerA.workerId }),
        trpc.session.create.mutate({ workerId: workerA.workerId }),
        trpc.session.create.mutate({ workerId: workerB.workerId }),
      ]);
      const ids = new Set([s1.sessionId, s2.sessionId, s3.sessionId]);
      expect(ids.size).toBe(3);
    } finally {
      wsClient.close();
    }
  });

  test("session.list with workerId filter returns only matching sessions", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      // Create sessions for both workers
      const sA1 = await trpc.session.create.mutate({ workerId: workerA.workerId });
      const sA2 = await trpc.session.create.mutate({ workerId: workerA.workerId });
      const sB1 = await trpc.session.create.mutate({ workerId: workerB.workerId });

      // Filter by worker A
      const listA = await trpc.session.list.query({ workerId: workerA.workerId });
      const idsA = listA.sessions.map((s) => s.sessionId);
      expect(idsA).toContain(sA1.sessionId);
      expect(idsA).toContain(sA2.sessionId);
      expect(idsA).not.toContain(sB1.sessionId);
      expect(listA.sessions.every((s) => s.workerId === workerA.workerId)).toBe(true);

      // Filter by worker B
      const listB = await trpc.session.list.query({ workerId: workerB.workerId });
      const idsB = listB.sessions.map((s) => s.sessionId);
      expect(idsB).toContain(sB1.sessionId);
      expect(idsB).not.toContain(sA1.sessionId);
      expect(listB.sessions.every((s) => s.workerId === workerB.workerId)).toBe(true);

      // No filter — returns all (including previous sessions from other tests)
      const listAll = await trpc.session.list.query();
      expect(listAll.sessions.length).toBeGreaterThanOrEqual(3);
    } finally {
      wsClient.close();
    }
  });
});
