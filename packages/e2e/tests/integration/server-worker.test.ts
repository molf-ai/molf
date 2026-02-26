import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startTestServer,
  type TestServer,
  connectTestWorker,
  type TestWorker,
  createTestClient,
} from "../../helpers/index.js";
import type { AgentEvent } from "@molf-ai/protocol";

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  server = await startTestServer();
  worker = await connectTestWorker(server.url, server.token, "e2e-worker", {
    echo: {
      description: "Echo the input text",
      execute: async (args: any) => ({ output: `echoed: ${args.text}` }),
    },
  });
});

afterAll(() => {
  worker.cleanup();
  server.cleanup();
});

describe("Server-Worker Integration (1 server + 1 worker + 1 client)", () => {
  test("client sees worker via agent.list", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.agent.list.query();
      expect(result.workers.length).toBeGreaterThanOrEqual(1);
      const w = result.workers.find((w) => w.workerId === worker.workerId);
      expect(w).toBeTruthy();
      expect(w!.name).toBe("e2e-worker");
    } finally {
      client.cleanup();
    }
  });

  test("client creates session bound to worker", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      expect(result.sessionId).toBeTruthy();
      expect(result.workerId).toBe(worker.workerId);
    } finally {
      client.cleanup();
    }
  });

  test("client lists sessions", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.session.list.query();
      expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.cleanup();
    }
  });

  test("client deletes session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const deleted = await client.trpc.session.delete.mutate({
        sessionId: created.sessionId,
      });
      expect(deleted.deleted).toBe(true);
    } finally {
      client.cleanup();
    }
  });

  test("client renames session", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const renamed = await client.trpc.session.rename.mutate({
        sessionId: created.sessionId,
        name: "Renamed Session",
      });
      expect(renamed.renamed).toBe(true);

      const sessions = await client.trpc.session.list.query();
      const found = sessions.sessions.find(
        (s) => s.sessionId === created.sessionId,
      );
      expect(found!.name).toBe("Renamed Session");
    } finally {
      client.cleanup();
    }
  });

  test("tool.list returns worker tools", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const created = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
      });
      const tools = await client.trpc.tool.list.query({
        sessionId: created.sessionId,
      });
      expect(tools.tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.tools.find((t) => t.name === "echo")).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });

  test("tool.approve with unknown approvalId returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.approve.mutate({
        sessionId: "any-session",
        approvalId: "any-tc",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("tool.deny returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.deny.mutate({
        sessionId: "any-session",
        approvalId: "any-tc",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });
});
