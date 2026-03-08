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
  server = await startTestServer({
    plugins: [{ name: "@molf-ai/plugin-cron" }],
  });
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

      // Add a job via plugin route
      const added: any = await client.trpc.plugin.mutate.mutate({
        plugin: "cron",
        method: "add",
        input: {
          workerId: worker.workerId,
          workspaceId: wsId,
          name: "test-job",
          schedule: { kind: "every", interval_ms: 60000 },
          payload: { kind: "agent_turn", message: "Do the thing" },
        },
      });
      expect(added.id).toBeTruthy();
      expect(added.name).toBe("test-job");

      // List jobs
      const listed: any = await client.trpc.plugin.query.query({
        plugin: "cron",
        method: "list",
        input: {
          workerId: worker.workerId,
          workspaceId: wsId,
        },
      });
      expect(listed.length).toBeGreaterThanOrEqual(1);
      const found = listed.find((j: any) => j.id === added.id);
      expect(found).toBeTruthy();

      // Update job
      const updated: any = await client.trpc.plugin.mutate.mutate({
        plugin: "cron",
        method: "update",
        input: {
          workerId: worker.workerId,
          workspaceId: wsId,
          jobId: added.id,
          name: "renamed-job",
        },
      });
      expect(updated.success).toBe(true);
      expect(updated.job!.name).toBe("renamed-job");

      // Remove job
      const removed: any = await client.trpc.plugin.mutate.mutate({
        plugin: "cron",
        method: "remove",
        input: {
          workerId: worker.workerId,
          workspaceId: wsId,
          jobId: added.id,
        },
      });
      expect(removed.success).toBe(true);

      // Verify removed
      const afterRemove: any = await client.trpc.plugin.query.query({
        plugin: "cron",
        method: "list",
        input: {
          workerId: worker.workerId,
          workspaceId: wsId,
        },
      });
      expect(afterRemove.find((j: any) => j.id === added.id)).toBeUndefined();
    } finally {
      client.cleanup();
    }
  });

  test("at job fires and auto-removes", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const wsId = await getDefaultWsId(client.trpc, worker.workerId);

      // Ensure there is a session in the workspace for the cron job to target
      await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: wsId,
      });

      // Add an "at" job via plugin route (fires 100ms from now)
      const added: any = await client.trpc.plugin.mutate.mutate({
        plugin: "cron",
        method: "add",
        input: {
          workerId: worker.workerId,
          workspaceId: wsId,
          name: "one-shot",
          schedule: { kind: "at", at: Date.now() + 100 },
          payload: { kind: "agent_turn", message: "One shot task" },
        },
      });
      expect(added.id).toBeTruthy();

      // Wait for the job to fire and auto-remove (poll via list)
      await waitUntil(
        async () => {
          const jobs: any = await client.trpc.plugin.query.query({
            plugin: "cron",
            method: "list",
            input: { workerId: worker.workerId, workspaceId: wsId },
          });
          return !jobs.find((j: any) => j.id === added.id);
        },
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

      const jobs = await client.trpc.plugin.query.query({
        plugin: "cron",
        method: "list",
        input: {
          workerId: worker.workerId,
          workspaceId: created.workspace.id,
        },
      });
      expect(jobs).toEqual([]);
    } finally {
      client.cleanup();
    }
  });
});
