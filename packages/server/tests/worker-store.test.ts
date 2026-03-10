import { describe, test, expect, afterEach } from "vitest";
import { createTmpDir } from "@molf-ai/test-utils";
import { WorkerStore } from "../src/worker-store.js";
import type { KnownWorker } from "../src/connection-registry.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function makeWorker(overrides: Partial<KnownWorker> = {}): KnownWorker {
  return {
    id: "w1",
    name: "Worker 1",
    online: true,
    connectedAt: 1000,
    lastSeenAt: 2000,
    tools: [{ name: "shell_exec", description: "Run shell commands", inputSchema: {} }],
    skills: [{ name: "s1", description: "Skill 1", content: "content" }],
    metadata: { workdir: "/home/user" },
    ...overrides,
  };
}

describe("WorkerStore", () => {
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

  test("save and loadAll round-trip", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    const worker = makeWorker();
    await store.save(worker);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("w1");
    expect(loaded[0].name).toBe("Worker 1");
    expect(loaded[0].connectedAt).toBe(1000);
    expect(loaded[0].lastSeenAt).toBe(2000);
    expect(loaded[0].tools).toHaveLength(1);
    expect(loaded[0].tools[0].name).toBe("shell_exec");
    expect(loaded[0].skills).toHaveLength(1);
    expect(loaded[0].metadata?.workdir).toBe("/home/user");
  });

  test("loadAll sets online to false", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    await store.save(makeWorker({ online: true }));

    const loaded = store.loadAll();
    expect(loaded[0].online).toBe(false);
  });

  test("save strips online field from disk", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    await store.save(makeWorker({ online: true }));

    const raw = readFileSync(resolve(tmp.path, "workers", "w1", "state.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.online).toBeUndefined();
    expect(data.id).toBe("w1");
  });

  test("save overwrites existing state", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    await store.save(makeWorker({ name: "Old" }));
    await store.save(makeWorker({ name: "New" }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("New");
  });

  test("multiple workers", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    await store.save(makeWorker({ id: "w1", name: "Worker 1" }));
    await store.save(makeWorker({ id: "w2", name: "Worker 2" }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(2);
    const ids = loaded.map((w) => w.id).sort();
    expect(ids).toEqual(["w1", "w2"]);
  });

  test("delete removes worker directory", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    await store.save(makeWorker({ id: "w1" }));
    await store.save(makeWorker({ id: "w2" }));

    await store.delete("w1");

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("w2");
  });

  test("delete non-existent worker does not throw", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    // Should not throw
    await store.delete("nonexistent");
  });

  test("loadAll skips corrupt state files", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    // Save a valid worker
    await store.save(makeWorker({ id: "good" }));

    // Write a corrupt file
    const corruptDir = resolve(tmp.path, "workers", "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(resolve(corruptDir, "state.json"), "not valid json{{{");

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("good");
  });

  test("loadAll skips directories without state.json", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    await store.save(makeWorker({ id: "good" }));

    // Create a directory without state.json
    const emptyDir = resolve(tmp.path, "workers", "empty");
    mkdirSync(emptyDir, { recursive: true });

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("good");
  });

  test("loadAll returns empty array when no workers exist", () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    const loaded = store.loadAll();
    expect(loaded).toEqual([]);
  });

  test("loadAll defaults tools and skills to empty arrays", async () => {
    const tmp = makeTmp();
    const store = new WorkerStore(tmp.path);

    // Write a state file without tools/skills
    const workerDir = resolve(tmp.path, "workers", "minimal");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      resolve(workerDir, "state.json"),
      JSON.stringify({ id: "minimal", name: "Minimal", connectedAt: 1, lastSeenAt: 2 }),
    );

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tools).toEqual([]);
    expect(loaded[0].skills).toEqual([]);
  });
});
