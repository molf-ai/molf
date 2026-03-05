import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  waitUntil,
  getDefaultWsId,
  clearWsIdCache,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

/**
 * Cron system E2E integration tests.
 *
 * Tests the cron CRUD lifecycle through tRPC, one-shot "at" job auto-removal,
 * and empty-list edge case via a real server/worker stack.
 */

let server: TestServer;
let worker: TestWorker;

beforeAll(async () => {
  setStreamTextImpl(() => mockTextResponse("ok"));
  server = await startTestServer();
  worker = await connectTestWorker(
    server.url,
    server.token,
    "cron-integration-worker",
  );
});

afterAll(() => {
  clearWsIdCache();
  worker.cleanup();
  server.cleanup();
});

describe("Cron integration", () => {
  test("cron CRUD via tRPC", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsId = await getDefaultWsId(client.trpc, worker.workerId);

      // Add a job via tRPC
      const added = await client.trpc.cron.add.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
        name: "test-job",
        schedule: { kind: "every", interval_ms: 60000 },
        payload: { kind: "agent_turn", message: "Do the thing" },
      });
      expect(added.id).toBeTruthy();
      expect(added.name).toBe("test-job");

      // List jobs
      const listed = await client.trpc.cron.list.query({
        workerId: worker.workerId,
        workspaceId: wsId,
      });
      expect(listed.length).toBeGreaterThanOrEqual(1);
      const found = listed.find((j) => j.id === added.id);
      expect(found).toBeTruthy();

      // Update job
      const updated = await client.trpc.cron.update.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
        jobId: added.id,
        name: "renamed-job",
      });
      expect(updated.success).toBe(true);
      expect(updated.job!.name).toBe("renamed-job");

      // Remove job
      const removed = await client.trpc.cron.remove.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
        jobId: added.id,
      });
      expect(removed.success).toBe(true);

      // Verify removed
      const afterRemove = await client.trpc.cron.list.query({
        workerId: worker.workerId,
        workspaceId: wsId,
      });
      expect(afterRemove.find((j) => j.id === added.id)).toBeUndefined();
    } finally {
      client.cleanup();
    }
  });

  test("at job fires and auto-removes", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsId = await getDefaultWsId(client.trpc, worker.workerId);
      const cronService = server.instance._ctx.cronService;

      // Ensure there is a session in the workspace for the cron job to target
      await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
      });

      const job = await cronService.add({
        name: "one-shot",
        schedule: { kind: "at", at: Date.now() + 100 }, // 100ms from now
        payload: { message: "One shot task" },
        workerId: worker.workerId,
        workspaceId: wsId,
      });

      // Wait for the job to fire (it should fire within ~200ms and auto-remove)
      await waitUntil(
        () =>
          cronService.get(worker.workerId, wsId, job.id) === undefined,
        5000,
        "at job auto-removal",
      );
    } finally {
      client.cleanup();
    }
  });

  test("list with no jobs returns empty", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create a fresh workspace so it has no cron jobs
      const created = await client.trpc.workspace.create.mutate({
        workerId: worker.workerId,
        name: "empty-cron-ws",
      });

      const jobs = await client.trpc.cron.list.query({
        workerId: worker.workerId,
        workspaceId: created.workspace.id,
      });
      expect(jobs).toEqual([]);
    } finally {
      client.cleanup();
    }
  });
});
