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
});
