import { describe, test, expect, afterEach } from "bun:test";
import { createTmpDir } from "@molf-ai/test-utils";
import { ConnectionRegistry } from "../src/connection-registry.js";
import { WorkerStore } from "../src/worker-store.js";

describe("ConnectionRegistry", () => {
  test("registerWorker", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({
      id: "w1",
      name: "Worker 1",
      connectedAt: Date.now(),
      tools: [],
      skills: [],
    });
    expect(reg.getWorker("w1")).toBeTruthy();
  });

  test("registerWorker duplicate ID throws", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
    expect(() =>
      reg.registerWorker({ id: "w1", name: "W2", connectedAt: Date.now(), tools: [], skills: [] }),
    ).toThrow("already exists");
  });

  test("registerClient", () => {
    const reg = new ConnectionRegistry();
    reg.registerClient({ id: "c1", name: "Client 1", connectedAt: Date.now() });
    expect(reg.getClients()).toHaveLength(1);
  });

  test("unregister", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
    reg.unregister("w1");
    expect(reg.isConnected("w1")).toBe(false);
  });

  test("getWorkers filters by role", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
    reg.registerClient({ id: "c1", name: "C1", connectedAt: Date.now() });
    expect(reg.getWorkers()).toHaveLength(1);
    expect(reg.getWorkers()[0].id).toBe("w1");
  });

  test("getClients filters by role", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
    reg.registerClient({ id: "c1", name: "C1", connectedAt: Date.now() });
    expect(reg.getClients()).toHaveLength(1);
    expect(reg.getClients()[0].id).toBe("c1");
  });

  test("counts accuracy", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
    reg.registerWorker({ id: "w2", name: "W2", connectedAt: Date.now(), tools: [], skills: [] });
    reg.registerClient({ id: "c1", name: "C1", connectedAt: Date.now() });
    expect(reg.counts()).toEqual({ workers: 2, clients: 1 });
  });

  test("get returns registration by ID", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
    expect(reg.get("w1")!.name).toBe("W1");
  });

  test("get unknown ID", () => {
    const reg = new ConnectionRegistry();
    expect(reg.get("unknown")).toBeUndefined();
  });

  test("getWorker returns undefined for a client ID", () => {
    const reg = new ConnectionRegistry();
    reg.registerClient({ id: "c1", name: "Client 1", connectedAt: Date.now() });
    expect(reg.getWorker("c1")).toBeUndefined();
  });

  test("getWorker returns undefined for unknown ID", () => {
    const reg = new ConnectionRegistry();
    expect(reg.getWorker("unknown")).toBeUndefined();
  });

  // --- Offline worker state tests ---

  describe("offline worker state", () => {
    test("unregister marks worker offline in knownWorkers", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: Date.now(),
        tools: [{ name: "t1", description: "tool 1", inputSchema: {} }],
        skills: [{ name: "s1", description: "skill 1", content: "content" }],
      });

      reg.unregister("w1");

      // Not in live connections
      expect(reg.getWorker("w1")).toBeUndefined();
      expect(reg.isConnected("w1")).toBe(false);

      // Still in knownWorkers
      const known = reg.getKnownWorkers();
      expect(known).toHaveLength(1);
      expect(known[0].id).toBe("w1");
      expect(known[0].online).toBe(false);
      expect(known[0].tools).toHaveLength(1);
      expect(known[0].skills).toHaveLength(1);
      expect(known[0].lastSeenAt).toBeGreaterThan(0);
    });

    test("worker reconnects with fresh state", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: Date.now(),
        tools: [{ name: "t1", description: "tool 1", inputSchema: {} }],
        skills: [],
      });

      reg.unregister("w1");

      // Re-register with different state
      reg.registerWorker({
        id: "w1",
        name: "W1-updated",
        connectedAt: Date.now(),
        tools: [
          { name: "t1", description: "tool 1", inputSchema: {} },
          { name: "t2", description: "tool 2", inputSchema: {} },
        ],
        skills: [{ name: "s1", description: "skill 1", content: "content" }],
      });

      // Live connection has fresh state
      const worker = reg.getWorker("w1");
      expect(worker).toBeTruthy();
      expect(worker!.name).toBe("W1-updated");
      expect(worker!.tools).toHaveLength(2);

      // KnownWorkers also updated
      const known = reg.getKnownWorkers();
      expect(known).toHaveLength(1);
      expect(known[0].online).toBe(true);
      expect(known[0].name).toBe("W1-updated");
      expect(known[0].tools).toHaveLength(2);
    });

    test("getKnownWorkers returns both online and offline workers", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
      reg.registerWorker({ id: "w2", name: "W2", connectedAt: Date.now(), tools: [], skills: [] });

      reg.unregister("w1"); // w1 goes offline

      const known = reg.getKnownWorkers();
      expect(known).toHaveLength(2);

      const w1 = known.find((w) => w.id === "w1")!;
      const w2 = known.find((w) => w.id === "w2")!;
      expect(w1.online).toBe(false);
      expect(w2.online).toBe(true);

      // getWorkers() only returns online
      expect(reg.getWorkers()).toHaveLength(1);
      expect(reg.getWorkers()[0].id).toBe("w2");
    });

    test("client unregister does not create knownWorker entry", () => {
      const reg = new ConnectionRegistry();
      reg.registerClient({ id: "c1", name: "C1", connectedAt: Date.now() });
      reg.unregister("c1");

      expect(reg.getKnownWorkers()).toHaveLength(0);
    });
  });

  // --- updateWorkerState tests ---

  describe("updateWorkerState", () => {
    test("updates tools and skills for online worker", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: Date.now(),
        tools: [{ name: "t1", description: "old", inputSchema: {} }],
        skills: [],
      });

      const updated = reg.updateWorkerState("w1", {
        tools: [
          { name: "t1", description: "updated", inputSchema: {} },
          { name: "t2", description: "new tool", inputSchema: {} },
        ],
        skills: [{ name: "s1", description: "new skill", content: "content" }],
      });

      expect(updated).toBe(true);

      const worker = reg.getWorker("w1")!;
      expect(worker.tools).toHaveLength(2);
      expect(worker.tools[0].description).toBe("updated");
      expect(worker.skills).toHaveLength(1);

      // Also reflected in knownWorkers
      const known = reg.getKnownWorkers();
      expect(known[0].tools).toHaveLength(2);
      expect(known[0].skills).toHaveLength(1);
    });

    test("updates metadata (full replace)", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: Date.now(),
        tools: [],
        skills: [],
        metadata: { workdir: "/foo", agentsDoc: "old doc" },
      });

      reg.updateWorkerState("w1", {
        tools: [],
        skills: [],
        metadata: { workdir: "/foo", agentsDoc: "new doc" },
      });

      const worker = reg.getWorker("w1")!;
      expect(worker.metadata?.agentsDoc).toBe("new doc");
      expect(worker.metadata?.workdir).toBe("/foo");
    });

    test("clears agentsDoc when metadata omits it", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: Date.now(),
        tools: [],
        skills: [],
        metadata: { workdir: "/foo", agentsDoc: "old doc" },
      });

      // Worker sends metadata without agentsDoc (instruction file deleted)
      reg.updateWorkerState("w1", {
        tools: [],
        skills: [],
        metadata: { workdir: "/foo" },
      });

      const worker = reg.getWorker("w1")!;
      expect(worker.metadata?.agentsDoc).toBeUndefined();
      expect(worker.metadata?.workdir).toBe("/foo");
    });

    test("returns false for offline worker", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({ id: "w1", name: "W1", connectedAt: Date.now(), tools: [], skills: [] });
      reg.unregister("w1");

      const updated = reg.updateWorkerState("w1", { tools: [], skills: [] });
      expect(updated).toBe(false);
    });

    test("returns false for unknown worker", () => {
      const reg = new ConnectionRegistry();
      const updated = reg.updateWorkerState("unknown", { tools: [], skills: [] });
      expect(updated).toBe(false);
    });

    test("syncState replaces full state, not merge", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: Date.now(),
        tools: [
          { name: "t1", description: "tool1", inputSchema: {} },
          { name: "t2", description: "tool2", inputSchema: {} },
        ],
        skills: [
          { name: "s1", description: "skill1", content: "c1" },
          { name: "s2", description: "skill2", content: "c2" },
        ],
      });

      // Send fewer skills — old ones should be gone
      reg.updateWorkerState("w1", {
        tools: [{ name: "t1", description: "tool1", inputSchema: {} }],
        skills: [{ name: "s1", description: "skill1", content: "c1" }],
      });

      const worker = reg.getWorker("w1")!;
      expect(worker.tools).toHaveLength(1);
      expect(worker.skills).toHaveLength(1);
    });
  });

  // --- Persistence tests ---

  describe("persistence with WorkerStore", () => {
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

    test("init() loads persisted workers as offline", async () => {
      const tmp = makeTmp();
      const store = new WorkerStore(tmp.path);

      // Pre-populate store
      await store.save({
        id: "w1",
        name: "Worker 1",
        online: true,
        connectedAt: 1000,
        lastSeenAt: 2000,
        tools: [{ name: "t1", description: "tool 1", inputSchema: {} }],
        skills: [],
      });

      const reg = new ConnectionRegistry(store);
      reg.init();

      const known = reg.getKnownWorkers();
      expect(known).toHaveLength(1);
      expect(known[0].id).toBe("w1");
      expect(known[0].online).toBe(false);
      expect(known[0].tools).toHaveLength(1);

      // Not in live connections
      expect(reg.getWorker("w1")).toBeUndefined();
      expect(reg.isConnected("w1")).toBe(false);
    });

    test("init() without store is a no-op", () => {
      const reg = new ConnectionRegistry();
      reg.init(); // Should not throw
      expect(reg.getKnownWorkers()).toHaveLength(0);
    });

    test("registerWorker persists to store", async () => {
      const tmp = makeTmp();
      const store = new WorkerStore(tmp.path);
      const reg = new ConnectionRegistry(store);

      reg.registerWorker({
        id: "w1",
        name: "W1",
        connectedAt: 1000,
        tools: [{ name: "t1", description: "d1", inputSchema: {} }],
        skills: [],
      });

      // Wait for fire-and-forget save
      await Bun.sleep(50);

      // Verify persisted by loading from a fresh store
      const loaded = store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("w1");
      expect(loaded[0].name).toBe("W1");
    });

    test("unregister persists offline state", async () => {
      const tmp = makeTmp();
      const store = new WorkerStore(tmp.path);
      const reg = new ConnectionRegistry(store);

      reg.registerWorker({ id: "w1", name: "W1", connectedAt: 1000, tools: [], skills: [] });
      await Bun.sleep(50);

      reg.unregister("w1");
      await Bun.sleep(50);

      // Load from fresh store — should have lastSeenAt updated
      const loaded = store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].online).toBe(false);
    });

    test("updateWorkerState persists to store", async () => {
      const tmp = makeTmp();
      const store = new WorkerStore(tmp.path);
      const reg = new ConnectionRegistry(store);

      reg.registerWorker({ id: "w1", name: "W1", connectedAt: 1000, tools: [], skills: [] });
      await Bun.sleep(50);

      reg.updateWorkerState("w1", {
        tools: [{ name: "t1", description: "new", inputSchema: {} }],
        skills: [{ name: "s1", description: "skill", content: "c" }],
      });
      await Bun.sleep(50);

      const loaded = store.loadAll();
      expect(loaded[0].tools).toHaveLength(1);
      expect(loaded[0].skills).toHaveLength(1);
    });

    test("renameWorker updates both maps and persists", async () => {
      const tmp = makeTmp();
      const store = new WorkerStore(tmp.path);
      const reg = new ConnectionRegistry(store);

      reg.registerWorker({ id: "w1", name: "OldName", connectedAt: 1000, tools: [], skills: [] });
      await Bun.sleep(50);

      const renamed = reg.renameWorker("w1", "NewName");
      expect(renamed).toBe(true);

      // Live connection updated
      expect(reg.getWorker("w1")!.name).toBe("NewName");

      // KnownWorkers updated
      expect(reg.getKnownWorkers()[0].name).toBe("NewName");

      // Persisted
      await Bun.sleep(50);
      const loaded = store.loadAll();
      expect(loaded[0].name).toBe("NewName");
    });

    test("renameWorker returns false for unknown worker", () => {
      const reg = new ConnectionRegistry();
      expect(reg.renameWorker("unknown", "Name")).toBe(false);
    });

    test("reconnect overwrites persisted state", async () => {
      const tmp = makeTmp();
      const store = new WorkerStore(tmp.path);

      // First session: register and disconnect
      const reg1 = new ConnectionRegistry(store);
      reg1.registerWorker({ id: "w1", name: "V1", connectedAt: 1000, tools: [], skills: [] });
      reg1.unregister("w1");
      await Bun.sleep(50);

      // Second session: simulate server restart
      const reg2 = new ConnectionRegistry(store);
      reg2.init();

      // Worker reconnects with new state
      reg2.registerWorker({
        id: "w1",
        name: "V2",
        connectedAt: 2000,
        tools: [{ name: "t1", description: "new tool", inputSchema: {} }],
        skills: [],
      });
      await Bun.sleep(50);

      // Persisted state should be the new one
      const loaded = store.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe("V2");
      expect(loaded[0].connectedAt).toBe(2000);
      expect(loaded[0].tools).toHaveLength(1);
    });
  });

  // --- renameWorker tests ---

  describe("renameWorker", () => {
    test("renames online worker in both maps", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({ id: "w1", name: "Old", connectedAt: Date.now(), tools: [], skills: [] });

      const renamed = reg.renameWorker("w1", "New");
      expect(renamed).toBe(true);
      expect(reg.getWorker("w1")!.name).toBe("New");
      expect(reg.getKnownWorkers()[0].name).toBe("New");
    });

    test("renames offline worker in knownWorkers", () => {
      const reg = new ConnectionRegistry();
      reg.registerWorker({ id: "w1", name: "Old", connectedAt: Date.now(), tools: [], skills: [] });
      reg.unregister("w1");

      const renamed = reg.renameWorker("w1", "New");
      expect(renamed).toBe(true);
      expect(reg.getKnownWorkers()[0].name).toBe("New");
    });

    test("returns false for unknown worker", () => {
      const reg = new ConnectionRegistry();
      expect(reg.renameWorker("unknown", "Name")).toBe(false);
    });
  });
});
