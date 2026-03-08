import { describe, test, expect, mock } from "bun:test";

mock.module("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const plugin = (await import("../src/index.js")).default;

describe("plugin-cron", () => {
  test("has name 'cron'", () => {
    expect(plugin.name).toBe("cron");
  });

  test("has server() but no worker()", () => {
    expect(plugin.server).toBeDefined();
    expect(plugin.worker).toBeUndefined();
  });

  test("server() registers routes, session tool, and service", () => {
    const registeredServices: any[] = [];
    const registeredRoutes: any[] = [];
    const registeredSessionTools: any[] = [];

    const fakeApi = {
      addTool() {},
      addRoutes(routes: any, ctx: any) {
        registeredRoutes.push({ routes, ctx });
      },
      addSessionTool(factory: any) {
        registeredSessionTools.push(factory);
      },
      addService(svc: any) {
        registeredServices.push(svc);
      },
      on() {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: undefined,
      dataPath: (wId?: string, wsId?: string) => {
        const base = "/tmp/test-cron-data/plugins/cron";
        if (wId == null) return base;
        if (wsId == null) return `${base}/workers/${wId}`;
        return `${base}/workers/${wId}/workspaces/${wsId}`;
      },
      serverDataDir: "/tmp/test-cron-data",
      sessionMgr: {
        load: () => null,
        create: async () => ({ sessionId: "s1" }),
        addMessage: () => {},
        save: async () => {},
      },
      eventBus: {},
      agentRunner: {
        prompt: async () => ({ messageId: "m1" }),
      },
      connectionRegistry: {
        getWorker: () => undefined,
      },
      workspaceStore: {
        get: async () => null,
        addSession: async () => {},
      },
      workspaceNotifier: {
        emit: () => {},
      },
    };

    plugin.server!(fakeApi as any);

    // Should register routes via addRoutes
    expect(registeredRoutes).toHaveLength(1);
    expect(registeredRoutes[0].ctx).toHaveProperty("service");
    const routeKeys = Object.keys(registeredRoutes[0].routes);
    expect(routeKeys).toContain("list");
    expect(routeKeys).toContain("add");
    expect(routeKeys).toContain("remove");
    expect(routeKeys).toContain("update");

    // Should register a session tool factory
    expect(registeredSessionTools).toHaveLength(1);
    expect(typeof registeredSessionTools[0]).toBe("function");

    // Should register a service (with start/stop)
    expect(registeredServices).toHaveLength(1);
    expect(typeof registeredServices[0].start).toBe("function");
    expect(typeof registeredServices[0].stop).toBe("function");
  });
});
