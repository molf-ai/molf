import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent } from "@molf-ai/protocol";

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
  worker = await connectTestWorker(server.url, server.token, "e2e-worker", {
    echo: {
      description: "Echo the input text",
      execute: async (args: any) => `echoed: ${args.text}`,
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Server-Worker Integration (1 server + 1 worker + 1 client)", () => {
  test("client sees worker via agent.list", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.agent.list.query();
      expect(result.workers.length).toBeGreaterThanOrEqual(1);
      const w = result.workers.find((w) => w.workerId === worker.workerId);
      expect(w).toBeTruthy();
      expect(w!.name).toBe("e2e-worker");
    } finally {
      wsClient.close();
    }
  });

  test("client creates session bound to worker", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      expect(result.sessionId).toBeTruthy();
      expect(result.workerId).toBe(worker.workerId);
    } finally {
      wsClient.close();
    }
  });

  test("client lists sessions", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.session.list.query();
      expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    } finally {
      wsClient.close();
    }
  });

  test("client deletes session", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const created = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const deleted = await trpc.session.delete.mutate({
        sessionId: created.sessionId,
      });
      expect(deleted.deleted).toBe(true);
    } finally {
      wsClient.close();
    }
  });

  test("client renames session", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const created = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const renamed = await trpc.session.rename.mutate({
        sessionId: created.sessionId,
        name: "Renamed Session",
      });
      expect(renamed.renamed).toBe(true);

      const sessions = await trpc.session.list.query();
      const found = sessions.sessions.find(
        (s) => s.sessionId === created.sessionId,
      );
      expect(found!.name).toBe("Renamed Session");
    } finally {
      wsClient.close();
    }
  });

  test("tool.list returns worker tools", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const created = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const tools = await trpc.tool.list.query({
        sessionId: created.sessionId,
      });
      expect(tools.tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.tools.find((t) => t.name === "echo")).toBeTruthy();
    } finally {
      wsClient.close();
    }
  });

  test("tool.approve returns applied=true", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.tool.approve.mutate({
        sessionId: "any-session",
        toolCallId: "any-tc",
      });
      expect(result.applied).toBe(true);
    } finally {
      wsClient.close();
    }
  });

  test("tool.deny returns applied=false", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.tool.deny.mutate({
        sessionId: "any-session",
        toolCallId: "any-tc",
      });
      expect(result.applied).toBe(false);
    } finally {
      wsClient.close();
    }
  });
});
