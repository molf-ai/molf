import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, type TestServer } from "../../helpers/index.js";
import { connectTestWorker, type TestWorker } from "../../helpers/index.js";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent } from "@molf-ai/protocol";

/**
 * Full prompt-flow E2E integration test.
 *
 * Tests the complete client → server → worker data flow for session
 * management and event propagation. LLM-dependent tests (prompt flow)
 * are in packages/server/tests/prompt-flow.test.ts where module mocking works.
 *
 * This file tests the plumbing: session CRUD, tool listing, event subscriptions.
 */

let server: TestServer;
let worker: TestWorker;

function createClient(url: string, token: string) {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("token", token);
  wsUrl.searchParams.set("clientId", crypto.randomUUID());
  wsUrl.searchParams.set("name", "flow-client");

  const wsClient = createWSClient({ url: wsUrl.toString() });
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient })],
  });
  return { trpc, wsClient };
}

beforeAll(async () => {
  server = startTestServer();
  worker = await connectTestWorker(server.url, server.token, "flow-worker", {
    echo: {
      description: "Echo the input text",
      execute: async (args: any) => ({ echoed: args.text ?? "default" }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Full flow: session lifecycle (client → server → worker)", () => {
  test("create session, list, load, rename, delete", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      // Create
      const created = await trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Flow Test Session",
      });
      expect(created.sessionId).toBeTruthy();
      expect(created.workerId).toBe(worker.workerId);

      // List
      const listed = await trpc.session.list.query();
      const found = listed.sessions.find((s) => s.sessionId === created.sessionId);
      expect(found).toBeTruthy();
      expect(found!.name).toBe("Flow Test Session");

      // Load
      const loaded = await trpc.session.load.mutate({
        sessionId: created.sessionId,
      });
      expect(loaded.sessionId).toBe(created.sessionId);
      expect(loaded.messages).toEqual([]);

      // Rename
      const renamed = await trpc.session.rename.mutate({
        sessionId: created.sessionId,
        name: "Renamed Flow Session",
      });
      expect(renamed.renamed).toBe(true);

      // Verify rename
      const reloaded = await trpc.session.load.mutate({
        sessionId: created.sessionId,
      });
      expect(reloaded.name).toBe("Renamed Flow Session");

      // Delete
      const deleted = await trpc.session.delete.mutate({
        sessionId: created.sessionId,
      });
      expect(deleted.deleted).toBe(true);

      // Verify deleted
      await expect(
        trpc.session.load.mutate({ sessionId: created.sessionId }),
      ).rejects.toThrow("not found");
    } finally {
      wsClient.close();
    }
  });

  test("tool.list reflects worker tools", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const session = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const tools = await trpc.tool.list.query({
        sessionId: session.sessionId,
      });
      expect(tools.tools.length).toBe(1);
      expect(tools.tools[0].name).toBe("echo");
      expect(tools.tools[0].workerId).toBe(worker.workerId);
    } finally {
      wsClient.close();
    }
  });

  test("agent.list shows connected worker", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const result = await trpc.agent.list.query();
      const w = result.workers.find((w) => w.workerId === worker.workerId);
      expect(w).toBeTruthy();
      expect(w!.name).toBe("flow-worker");
      expect(w!.connected).toBe(true);
      expect(w!.tools.length).toBe(1);
    } finally {
      wsClient.close();
    }
  });

  test("agent.status returns idle for new session", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const session = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const status = await trpc.agent.status.query({
        sessionId: session.sessionId,
      });
      expect(status.status).toBe("idle");
    } finally {
      wsClient.close();
    }
  });

  test("agent.abort returns false for non-active session", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const session = await trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const result = await trpc.agent.abort.mutate({
        sessionId: session.sessionId,
      });
      expect(result.aborted).toBe(false);
    } finally {
      wsClient.close();
    }
  });

  test("multiple sessions can be created for same worker", async () => {
    const { trpc, wsClient } = createClient(server.url, server.token);
    try {
      const s1 = await trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Session A",
      });
      const s2 = await trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Session B",
      });
      expect(s1.sessionId).not.toBe(s2.sessionId);

      const listed = await trpc.session.list.query();
      const ids = listed.sessions.map((s) => s.sessionId);
      expect(ids).toContain(s1.sessionId);
      expect(ids).toContain(s2.sessionId);
    } finally {
      wsClient.close();
    }
  });
});
