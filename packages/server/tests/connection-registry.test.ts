import { describe, test, expect } from "bun:test";
import { ConnectionRegistry } from "../src/connection-registry.js";

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
});
