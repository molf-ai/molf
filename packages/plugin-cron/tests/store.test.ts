import { describe, test, expect, afterEach } from "vitest";
import { createTmpDir } from "@molf-ai/test-utils";
import { CronStore } from "../src/store.js";
import type { CronJob } from "@molf-ai/protocol";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function makeStore(basePath: string): CronStore {
  return new CronStore(
    (wId, wsId) => join(basePath, "workers", wId, "workspaces", wsId),
    basePath,
  );
}

function makeSampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    schedule: { kind: "every" as const, interval_ms: 60000 },
    payload: { kind: "agent_turn" as const, message: "test message" },
    workerId: "worker-1",
    workspaceId: "ws-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    consecutiveErrors: 0,
    ...overrides,
  };
}

describe("CronStore", () => {
  const tmps: ReturnType<typeof createTmpDir>[] = [];

  function makeTmp() {
    const tmp = createTmpDir();
    tmps.push(tmp);
    return tmp;
  }

  afterEach(() => {
    for (const tmp of tmps) tmp.cleanup();
    tmps.length = 0;
  });

  // ============= CRUD Operations =============

  describe("add()", () => {
    test("creates a job and persists to disk", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob();
      await store.add(job);

      // Verify in memory
      const loaded = store.list("worker-1", "ws-1");
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("test-job-1");
      expect(loaded[0].name).toBe("Test Job");

      // Verify on disk
      const filePath = resolve(
        tmp.path,
        "workers",
        "worker-1",
        "workspaces",
        "ws-1",
        "jobs.json"
      );
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("test-job-1");
    });

    test("appends multiple jobs to same workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ id: "job-1", name: "Job 1" }));
      await store.add(makeSampleJob({ id: "job-2", name: "Job 2" }));

      const jobs = store.list("worker-1", "ws-1");
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    });

    test("supports different workspaces for same worker", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ workspaceId: "ws-1" }));
      await store.add(
        makeSampleJob({ id: "job-2", workspaceId: "ws-2" })
      );

      expect(store.list("worker-1", "ws-1")).toHaveLength(1);
      expect(store.list("worker-1", "ws-2")).toHaveLength(1);
    });
  });

  describe("load()", () => {
    test("reads jobs from disk for first call", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob();
      await store.add(job);

      // Create fresh store instance to test disk read
      const store2 = makeStore(tmp.path);
      const loaded = store2.load("worker-1", "ws-1");
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("test-job-1");
    });

    test("caches on second call without reading disk", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob();
      await store.add(job);

      // First load
      const first = store.load("worker-1", "ws-1");
      expect(first).toHaveLength(1);

      // Second load should return same array from cache
      const second = store.load("worker-1", "ws-1");
      expect(first).toBe(second); // Same reference
    });

    test("returns empty array when jobs file does not exist", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const jobs = store.load("nonexistent-worker", "nonexistent-ws");
      expect(jobs).toEqual([]);
    });

    test("returns empty array when directory does not exist", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const jobs = store.load("worker-1", "ws-1");
      expect(jobs).toEqual([]);
    });
  });

  describe("list()", () => {
    test("returns all jobs for a workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ id: "job-1" }));
      await store.add(makeSampleJob({ id: "job-2", name: "Job 2" }));
      await store.add(makeSampleJob({ id: "job-3", name: "Job 3" }));

      const jobs = store.list("worker-1", "ws-1");
      expect(jobs).toHaveLength(3);
      expect(jobs.map((j) => j.id).sort()).toEqual(["job-1", "job-2", "job-3"]);
    });

    test("returns empty array for workspace with no jobs", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const jobs = store.list("worker-1", "ws-1");
      expect(jobs).toEqual([]);
    });

    test("isolates jobs by workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ id: "job-1", workspaceId: "ws-1" }));
      await store.add(makeSampleJob({ id: "job-2", workspaceId: "ws-2" }));

      const jobs1 = store.list("worker-1", "ws-1");
      const jobs2 = store.list("worker-1", "ws-2");

      expect(jobs1).toHaveLength(1);
      expect(jobs1[0].id).toBe("job-1");
      expect(jobs2).toHaveLength(1);
      expect(jobs2[0].id).toBe("job-2");
    });
  });

  describe("get()", () => {
    test("returns specific job by ID", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(
        makeSampleJob({ id: "target-job", name: "Target Job" })
      );
      await store.add(makeSampleJob({ id: "other-job", name: "Other Job" }));

      const job = store.get("worker-1", "ws-1", "target-job");
      expect(job).toBeDefined();
      expect(job?.id).toBe("target-job");
      expect(job?.name).toBe("Target Job");
    });

    test("returns undefined for non-existent job", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob());

      const job = store.get("worker-1", "ws-1", "nonexistent-job");
      expect(job).toBeUndefined();
    });

    test("returns undefined for non-existent workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = store.get("worker-1", "nonexistent-ws", "any-job");
      expect(job).toBeUndefined();
    });
  });

  describe("remove()", () => {
    test("removes job and returns true", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ id: "job-1" }));
      await store.add(makeSampleJob({ id: "job-2", name: "Job 2" }));

      const removed = await store.remove("worker-1", "ws-1", "job-1");
      expect(removed).toBe(true);

      const jobs = store.list("worker-1", "ws-1");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe("job-2");
    });

    test("persists removal to disk", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob());
      await store.remove("worker-1", "ws-1", "test-job-1");

      // Create fresh store to verify persistence
      const store2 = makeStore(tmp.path);
      const jobs = store2.load("worker-1", "ws-1");
      expect(jobs).toHaveLength(0);
    });

    test("returns false for non-existent job", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob());

      const removed = await store.remove("worker-1", "ws-1", "nonexistent");
      expect(removed).toBe(false);

      // Original job still exists
      const jobs = store.list("worker-1", "ws-1");
      expect(jobs).toHaveLength(1);
    });

    test("returns false for non-existent workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const removed = await store.remove(
        "worker-1",
        "nonexistent",
        "any-job"
      );
      expect(removed).toBe(false);
    });

    test("handles removing last job from workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob());

      const removed = await store.remove("worker-1", "ws-1", "test-job-1");
      expect(removed).toBe(true);

      const jobs = store.list("worker-1", "ws-1");
      expect(jobs).toHaveLength(0);

      // File should still exist but be empty
      const filePath = resolve(
        tmp.path,
        "workers",
        "worker-1",
        "workspaces",
        "ws-1",
        "jobs.json"
      );
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual([]);
    });
  });

  describe("update()", () => {
    test("patches fields including caller-provided updatedAt", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob({ name: "Original Name" });
      const originalTime = job.createdAt;
      await store.add(job);

      const newTime = originalTime + 1000;
      const updated = await store.update("worker-1", "ws-1", "test-job-1", {
        name: "Updated Name",
        enabled: false,
        updatedAt: newTime,
      });
      expect(updated).toBe(true);

      const retrieved = store.get("worker-1", "ws-1", "test-job-1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("Updated Name");
      expect(retrieved?.enabled).toBe(false);
      expect(retrieved?.updatedAt).toBe(newTime);
    });

    test("preserves non-patched fields", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob({
        name: "Original Name",
        enabled: true,
        consecutiveErrors: 5,
      });
      await store.add(job);

      await store.update("worker-1", "ws-1", "test-job-1", {
        name: "Updated Name",
      });

      const retrieved = store.get("worker-1", "ws-1", "test-job-1");
      expect(retrieved?.name).toBe("Updated Name");
      expect(retrieved?.enabled).toBe(true);
      expect(retrieved?.consecutiveErrors).toBe(5);
    });

    test("persists update to disk", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ name: "Original" }));
      await store.update("worker-1", "ws-1", "test-job-1", {
        name: "Updated",
      });

      // Create fresh store to verify persistence
      const store2 = makeStore(tmp.path);
      const job = store2.get("worker-1", "ws-1", "test-job-1");
      expect(job?.name).toBe("Updated");
    });

    test("returns false for non-existent job", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const updated = await store.update("worker-1", "ws-1", "nonexistent", {
        name: "New Name",
      });
      expect(updated).toBe(false);
    });

    test("returns false for non-existent workspace", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const updated = await store.update(
        "worker-1",
        "nonexistent",
        "any-job",
        { name: "New Name" }
      );
      expect(updated).toBe(false);
    });

    test("can update complex fields like schedule and payload", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(
        makeSampleJob({
          schedule: { kind: "every", interval_ms: 60000 },
          payload: { kind: "agent_turn", message: "old message" },
        })
      );

      const newSchedule = { kind: "cron" as const, expr: "0 */6 * * *" };
      const newPayload = {
        kind: "agent_turn" as const,
        message: "new message",
      };

      await store.update("worker-1", "ws-1", "test-job-1", {
        schedule: newSchedule,
        payload: newPayload,
      });

      const job = store.get("worker-1", "ws-1", "test-job-1");
      expect(job?.schedule).toEqual(newSchedule);
      expect(job?.payload).toEqual(newPayload);
    });
  });

  // ============= Multiple Workspaces =============

  describe("loadAll()", () => {
    test("loads all jobs from all workers and workspaces", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      // Add jobs across multiple workers and workspaces
      await store.add(
        makeSampleJob({
          id: "job-w1-ws1",
          workerId: "worker-1",
          workspaceId: "ws-1",
        })
      );
      await store.add(
        makeSampleJob({
          id: "job-w1-ws2",
          workerId: "worker-1",
          workspaceId: "ws-2",
        })
      );
      await store.add(
        makeSampleJob({
          id: "job-w2-ws1",
          workerId: "worker-2",
          workspaceId: "ws-1",
        })
      );

      const all = store.loadAll();
      expect(all).toHaveLength(3);
      const ids = all.map((j) => j.id).sort();
      expect(ids).toEqual(["job-w1-ws1", "job-w1-ws2", "job-w2-ws1"]);
    });

    test("returns empty array when no workers directory exists", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const all = store.loadAll();
      expect(all).toEqual([]);
    });

    test("returns empty array when workers directory exists but is empty", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      // Create an empty workers directory
      mkdirSync(resolve(tmp.path, "workers"), { recursive: true });

      const all = store.loadAll();
      expect(all).toEqual([]);
    });

    test("skips workers without workspaces directory", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      // Add a real job
      await store.add(
        makeSampleJob({
          id: "valid-job",
          workerId: "worker-1",
          workspaceId: "ws-1",
        })
      );

      // Add a worker directory without workspaces
      const emptyWorkerDir = resolve(tmp.path, "workers", "empty-worker");
      mkdirSync(emptyWorkerDir, { recursive: true });

      const all = store.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("valid-job");
    });

    test("skips non-directory entries in workers", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(
        makeSampleJob({
          id: "job-1",
          workerId: "worker-1",
          workspaceId: "ws-1",
        })
      );

      // Create a file in workers directory
      writeFileSync(resolve(tmp.path, "workers", "somefile.txt"), "data");

      const all = store.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("job-1");
    });

    test("uses cache from load() in loadAll()", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(
        makeSampleJob({
          id: "job-1",
          workerId: "worker-1",
          workspaceId: "ws-1",
        })
      );

      // First load into cache
      const fromLoad = store.load("worker-1", "ws-1");
      expect(fromLoad).toHaveLength(1);

      // loadAll should use cached data
      const fromLoadAll = store.loadAll();
      expect(fromLoadAll).toHaveLength(1);
      expect(fromLoadAll[0]).toBe(fromLoad[0]); // Same reference
    });
  });

  // ============= Edge Cases & Disk I/O =============

  describe("save() - disk persistence", () => {
    test("creates directory structure if missing", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob();
      await store.add(job);

      const filePath = resolve(
        tmp.path,
        "workers",
        "worker-1",
        "workspaces",
        "ws-1",
        "jobs.json"
      );
      expect(() => readFileSync(filePath, "utf-8")).not.toThrow();
    });

    test("performs atomic write with temp file", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob());

      // After save completes, only the real file should exist (not .tmp)
      const filePath = resolve(
        tmp.path,
        "workers",
        "worker-1",
        "workspaces",
        "ws-1",
        "jobs.json"
      );
      const tmpPath = filePath + ".tmp";

      expect(() => readFileSync(filePath, "utf-8")).not.toThrow();
      expect(() => readFileSync(tmpPath, "utf-8")).toThrow(); // .tmp should not exist
    });

    test("does not save if no jobs in cache", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      // Manually call save without adding anything
      await store.save("worker-1", "ws-1");

      const filePath = resolve(
        tmp.path,
        "workers",
        "worker-1",
        "workspaces",
        "ws-1",
        "jobs.json"
      );
      expect(() => readFileSync(filePath, "utf-8")).toThrow(); // File should not exist
    });

    test("writes valid JSON to disk", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob({
        schedule: { kind: "every", interval_ms: 60000 },
        payload: { kind: "agent_turn", message: "test" },
      });
      await store.add(job);

      const filePath = resolve(
        tmp.path,
        "workers",
        "worker-1",
        "workspaces",
        "ws-1",
        "jobs.json"
      );
      const raw = readFileSync(filePath, "utf-8");

      // Should not throw
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].schedule.kind).toBe("every");
      expect(parsed[0].payload.message).toBe("test");
    });
  });

  describe("cache isolation", () => {
    test("separate caches for different workspaces", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ id: "job-ws1", workspaceId: "ws-1" }));
      await store.add(makeSampleJob({ id: "job-ws2", workspaceId: "ws-2" }));

      // Load each into cache
      const jobs1 = store.load("worker-1", "ws-1");
      const jobs2 = store.load("worker-1", "ws-2");

      // They should be different arrays
      expect(jobs1).not.toBe(jobs2);
      expect(jobs1[0].id).toBe("job-ws1");
      expect(jobs2[0].id).toBe("job-ws2");
    });

    test("separate caches for different workers", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      await store.add(makeSampleJob({ id: "job-w1", workerId: "worker-1" }));
      await store.add(makeSampleJob({ id: "job-w2", workerId: "worker-2" }));

      const jobs1 = store.load("worker-1", "ws-1");
      const jobs2 = store.load("worker-2", "ws-1");

      expect(jobs1).not.toBe(jobs2);
      expect(jobs1[0].id).toBe("job-w1");
      expect(jobs2[0].id).toBe("job-w2");
    });
  });

  describe("complex job attributes", () => {
    test("preserves all job fields through round-trip", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob({
        schedule: { kind: "cron", expr: "0 0 * * *" },
        payload: { kind: "agent_turn", message: "Daily sync" },
        nextRunAt: 1704067200000,
        lastRunAt: 1704067200000,
        lastStatus: "ok",
        lastError: undefined,
      });

      await store.add(job);

      const retrieved = store.get("worker-1", "ws-1", "test-job-1");
      expect(retrieved).toEqual(job);
    });

    test("handles optional fields correctly", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob({
        nextRunAt: undefined,
        lastRunAt: undefined,
        lastStatus: undefined,
        lastError: undefined,
      });

      await store.add(job);

      const retrieved = store.get("worker-1", "ws-1", "test-job-1");
      expect(retrieved?.nextRunAt).toBeUndefined();
      expect(retrieved?.lastRunAt).toBeUndefined();
      expect(retrieved?.lastStatus).toBeUndefined();
      expect(retrieved?.lastError).toBeUndefined();
    });

    test("can update optional fields", async () => {
      const tmp = makeTmp();
      const store = makeStore(tmp.path);

      const job = makeSampleJob();
      await store.add(job);

      await store.update("worker-1", "ws-1", "test-job-1", {
        lastRunAt: Date.now(),
        lastStatus: "error",
        lastError: "Connection timeout",
      });

      const retrieved = store.get("worker-1", "ws-1", "test-job-1");
      expect(retrieved?.lastStatus).toBe("error");
      expect(retrieved?.lastError).toBe("Connection timeout");
      expect(retrieved?.lastRunAt).toBeDefined();
    });
  });
});
