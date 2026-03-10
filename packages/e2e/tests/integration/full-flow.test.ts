import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
  getDefaultWsId,
} from "../../helpers/index.js";
import type { AgentEvent } from "@molf-ai/protocol";

/**
 * Full prompt-flow E2E integration test.
 *
 * Tests the complete client -> server -> worker data flow for session
 * management and event propagation. LLM-dependent tests (prompt flow)
 * are in packages/server/tests/prompt-flow.test.ts where module mocking works.
 *
 * This file tests the plumbing: session CRUD, tool listing, event subscriptions.
 */

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "flow-worker", {
    echo: {
      description: "Echo the input text",
      execute: async (args: any) => ({ output: JSON.stringify({ echoed: args.text ?? "default" }) }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Full flow: session lifecycle (client -> server -> worker)", () => {
  test("create session, list, load, rename, delete", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create
      const created = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
        name: "Flow Test Session",
      });
      expect(created.sessionId).toBeTruthy();
      expect(created.workerId).toBe(worker.workerId);

      // List
      const listed = await client.trpc.session.list.query();
      const found = listed.sessions.find((s) => s.sessionId === created.sessionId);
      expect(found).toBeTruthy();
      expect(found!.name).toBe("Flow Test Session");

      // Load
      const loaded = await client.trpc.session.load.mutate({
        sessionId: created.sessionId,
      });
      expect(loaded.sessionId).toBe(created.sessionId);
      expect(loaded.messages).toEqual([]);

      // Rename
      const renamed = await client.trpc.session.rename.mutate({
        sessionId: created.sessionId,
        name: "Renamed Flow Session",
      });
      expect(renamed.renamed).toBe(true);

      // Verify rename
      const reloaded = await client.trpc.session.load.mutate({
        sessionId: created.sessionId,
      });
      expect(reloaded.name).toBe("Renamed Flow Session");

      // Delete
      const deleted = await client.trpc.session.delete.mutate({
        sessionId: created.sessionId,
      });
      expect(deleted.deleted).toBe(true);

      // Verify deleted
      await expect(
        client.trpc.session.load.mutate({ sessionId: created.sessionId }),
      ).rejects.toThrow("not found");
    } finally {
      client.cleanup();
    }
  });

  test("tool.list reflects worker tools", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });
      const tools = await client.trpc.tool.list.query({
        sessionId: session.sessionId,
      });
      expect(tools.tools.length).toBe(1);
      expect(tools.tools[0].name).toBe("echo");
      expect(tools.tools[0].workerId).toBe(worker.workerId);
    } finally {
      client.cleanup();
    }
  });

  test("agent.list shows connected worker", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.agent.list.query();
      const w = result.workers.find((w) => w.workerId === worker.workerId);
      expect(w).toBeTruthy();
      expect(w!.name).toBe("flow-worker");
      expect(w!.connected).toBe(true);
      expect(w!.tools.length).toBe(1);
    } finally {
      client.cleanup();
    }
  });

  test("agent.status returns idle for new session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });
      const status = await client.trpc.agent.status.query({
        sessionId: session.sessionId,
      });
      expect(status.status).toBe("idle");
    } finally {
      client.cleanup();
    }
  });

  test("agent.abort returns false for non-active session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });
      const result = await client.trpc.agent.abort.mutate({
        sessionId: session.sessionId,
      });
      expect(result.aborted).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("multiple sessions can be created for same worker", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const s1 = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
        name: "Session A",
      });
      const s2 = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
        name: "Session B",
      });
      expect(s1.sessionId).not.toBe(s2.sessionId);

      const listed = await client.trpc.session.list.query();
      const ids = listed.sessions.map((s) => s.sessionId);
      expect(ids).toContain(s1.sessionId);
      expect(ids).toContain(s2.sessionId);
    } finally {
      client.cleanup();
    }
  });
});
