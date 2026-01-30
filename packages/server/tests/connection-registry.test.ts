import { describe, expect, test } from "bun:test";
import { ConnectionRegistry } from "../src/connection-registry.js";

describe("ConnectionRegistry", () => {
  test("registers and retrieves a worker", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({
      id: "worker-1",
      name: "code-worker",
      connectedAt: Date.now(),
      tools: [{ name: "shell_exec", description: "Run shell", inputSchema: {} }],
      skills: [],
    });

    const worker = reg.getWorker("worker-1");
    expect(worker).toBeDefined();
    expect(worker!.name).toBe("code-worker");
    expect(worker!.role).toBe("worker");
    expect(worker!.tools).toHaveLength(1);
  });

  test("registers and retrieves a client", () => {
    const reg = new ConnectionRegistry();
    reg.registerClient({
      id: "client-1",
      name: "tui",
      connectedAt: Date.now(),
    });

    const entry = reg.get("client-1");
    expect(entry).toBeDefined();
    expect(entry!.role).toBe("client");
    expect(entry!.name).toBe("tui");
  });

  test("throws on duplicate worker registration", () => {
    const reg = new ConnectionRegistry();
    const entry = { id: "w-1", name: "w", connectedAt: Date.now(), tools: [], skills: [] };
    reg.registerWorker(entry);

    expect(() => reg.registerWorker(entry)).toThrow("already exists");
  });

  test("client registration overwrites existing", () => {
    const reg = new ConnectionRegistry();
    reg.registerClient({ id: "c-1", name: "tui-1", connectedAt: 1000 });
    reg.registerClient({ id: "c-1", name: "tui-2", connectedAt: 2000 });

    expect(reg.get("c-1")!.name).toBe("tui-2");
  });

  test("unregister removes entry", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({
      id: "w-1", name: "w", connectedAt: Date.now(), tools: [], skills: [],
    });

    reg.unregister("w-1");
    expect(reg.isConnected("w-1")).toBe(false);
    expect(reg.getWorker("w-1")).toBeUndefined();
  });

  test("getWorkers returns only workers", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({
      id: "w-1", name: "worker", connectedAt: Date.now(), tools: [], skills: [],
    });
    reg.registerClient({ id: "c-1", name: "client", connectedAt: Date.now() });

    const workers = reg.getWorkers();
    expect(workers).toHaveLength(1);
    expect(workers[0].id).toBe("w-1");
  });

  test("getClients returns only clients", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({
      id: "w-1", name: "worker", connectedAt: Date.now(), tools: [], skills: [],
    });
    reg.registerClient({ id: "c-1", name: "client", connectedAt: Date.now() });

    const clients = reg.getClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("c-1");
  });

  test("counts returns correct worker and client counts", () => {
    const reg = new ConnectionRegistry();
    reg.registerWorker({
      id: "w-1", name: "w1", connectedAt: Date.now(), tools: [], skills: [],
    });
    reg.registerWorker({
      id: "w-2", name: "w2", connectedAt: Date.now(), tools: [], skills: [],
    });
    reg.registerClient({ id: "c-1", name: "c1", connectedAt: Date.now() });

    expect(reg.counts()).toEqual({ workers: 2, clients: 1 });
  });

  test("isConnected returns false for unknown id", () => {
    const reg = new ConnectionRegistry();
    expect(reg.isConnected("nonexistent")).toBe(false);
  });

  test("getWorker returns undefined for client id", () => {
    const reg = new ConnectionRegistry();
    reg.registerClient({ id: "c-1", name: "client", connectedAt: Date.now() });

    expect(reg.getWorker("c-1")).toBeUndefined();
  });
});
