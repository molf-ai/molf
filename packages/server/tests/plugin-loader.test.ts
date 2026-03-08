import { describe, test, expect, mock, beforeEach } from "bun:test";
import { HookRegistry } from "@molf-ai/protocol";
import type { PluginDescriptor } from "@molf-ai/protocol";
import { z } from "zod";

// We test PluginLoader by mocking dynamic imports. Since PluginLoader uses
// `await import(specifier)` internally, we mock at the module level.

// Stub internals
function makeInternals() {
  return {
    sessionMgr: {} as any,
    eventBus: {} as any,
    agentRunner: {} as any,
    connectionRegistry: {} as any,
    dataDir: "/tmp/test-data",
  };
}

mock.module("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const { PluginLoader } = await import("../src/plugin-loader.js");
const { createServerPluginApi } = await import("../src/plugin-api.js");

describe("PluginLoader", () => {
  test("constructor creates a HookRegistry", () => {
    const loader = new PluginLoader();
    expect(loader.hookRegistry).toBeInstanceOf(HookRegistry);
  });

  test("getPluginList returns empty on fresh loader", () => {
    const loader = new PluginLoader();
    expect(loader.getPluginList()).toEqual([]);
  });

  test("shutdown on empty loader is a no-op", async () => {
    const loader = new PluginLoader();
    await loader.shutdown(); // should not throw
  });

  test("startServices on empty loader is a no-op", async () => {
    const loader = new PluginLoader();
    await loader.startServices(); // should not throw
  });
});

describe("PluginLoader.loadAll", () => {
  test("loads a plugin with server() function", async () => {
    const serverFn = mock(() => {});
    const descriptor: PluginDescriptor = {
      name: "test-server-plugin",
      server: serverFn,
    };

    // Mock the module import
    mock.module("/tmp/test-server-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/test-server-plugin" }],
      makeInternals(),
    );

    expect(serverFn).toHaveBeenCalledTimes(1);
    const list = loader.getPluginList();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("test-server-plugin");
  });

  test("loads a worker-only plugin (no server call)", async () => {
    const workerFn = mock(() => {});
    const descriptor: PluginDescriptor = {
      name: "worker-only-plugin",
      worker: workerFn,
    };

    mock.module("/tmp/worker-only-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/worker-only-plugin" }],
      makeInternals(),
    );

    // worker() should NOT be called on the server
    expect(workerFn).not.toHaveBeenCalled();
    // But it should be tracked in workerPluginSpecifiers
    expect(loader.workerPluginSpecifiers).toContain("/tmp/worker-only-plugin");
    const list = loader.getPluginList();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("worker-only-plugin");
  });

  test("plugin throwing during init is caught, others still load", async () => {
    const badDescriptor: PluginDescriptor = {
      name: "bad-plugin",
      server() { throw new Error("init boom"); },
    };
    const goodDescriptor: PluginDescriptor = {
      name: "good-plugin",
      server() {},
    };

    mock.module("/tmp/bad-plugin", () => ({ default: badDescriptor }));
    mock.module("/tmp/good-plugin", () => ({ default: goodDescriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/bad-plugin" }, { name: "/tmp/good-plugin" }],
      makeInternals(),
    );

    const list = loader.getPluginList();
    // bad-plugin should have failed, good-plugin should have loaded
    // The error is caught and logged; the plugin list only contains successfully loaded plugins
    expect(list.some((p) => p.name === "good-plugin")).toBe(true);
  });

  test("validates config with configSchema", async () => {
    const serverFn = mock((api: any) => {
      expect(api.config).toEqual({ port: 8080 });
    });
    const descriptor: PluginDescriptor = {
      name: "config-plugin",
      configSchema: z.object({ port: z.number() }),
      server: serverFn,
    };

    mock.module("/tmp/config-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/config-plugin", config: { port: 8080 } }],
      makeInternals(),
    );

    expect(serverFn).toHaveBeenCalledTimes(1);
  });

  test("invalid config causes plugin to fail to load", async () => {
    const serverFn = mock(() => {});
    const descriptor: PluginDescriptor = {
      name: "bad-config-plugin",
      configSchema: z.object({ port: z.number() }),
      server: serverFn,
    };

    mock.module("/tmp/bad-config-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/bad-config-plugin", config: { port: "not-a-number" } }],
      makeInternals(),
    );

    // server() should NOT have been called — config validation failed
    expect(serverFn).not.toHaveBeenCalled();
  });

  test("plugin without valid name throws", async () => {
    mock.module("/tmp/nameless-plugin", () => ({ default: {} }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/nameless-plugin" }],
      makeInternals(),
    );

    // Should not throw outward — error is logged, plugin skipped
    expect(loader.getPluginList()).toEqual([]);
  });

  test("tracks hybrid plugin in workerPluginSpecifiers", async () => {
    const descriptor: PluginDescriptor = {
      name: "hybrid-plugin",
      server() {},
      worker() {},
    };

    mock.module("/tmp/hybrid-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/hybrid-plugin" }],
      makeInternals(),
    );

    expect(loader.workerPluginSpecifiers).toContain("/tmp/hybrid-plugin");
  });
});

describe("PluginLoader.shutdown", () => {
  test("calls destroy on plugins in reverse order", async () => {
    const order: string[] = [];
    const descriptorA: PluginDescriptor = {
      name: "plugin-a",
      server: () => ({ destroy: () => { order.push("a"); } }),
    };
    const descriptorB: PluginDescriptor = {
      name: "plugin-b",
      server: () => ({ destroy: () => { order.push("b"); } }),
    };

    mock.module("/tmp/plugin-a", () => ({ default: descriptorA }));
    mock.module("/tmp/plugin-b", () => ({ default: descriptorB }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/plugin-a" }, { name: "/tmp/plugin-b" }],
      makeInternals(),
    );
    await loader.shutdown();

    expect(order).toEqual(["b", "a"]);
  });

  test("destroy error is caught, other plugins still destroyed", async () => {
    const order: string[] = [];
    const descriptorA: PluginDescriptor = {
      name: "err-destroy-a",
      server: () => ({ destroy: () => { throw new Error("destroy boom"); } }),
    };
    const descriptorB: PluginDescriptor = {
      name: "err-destroy-b",
      server: () => ({ destroy: () => { order.push("b-destroyed"); } }),
    };

    mock.module("/tmp/err-destroy-a", () => ({ default: descriptorA }));
    mock.module("/tmp/err-destroy-b", () => ({ default: descriptorB }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/err-destroy-a" }, { name: "/tmp/err-destroy-b" }],
      makeInternals(),
    );
    await loader.shutdown();

    // B should still be destroyed despite A's error (reverse order: B first)
    expect(order).toContain("b-destroyed");
  });
});

describe("PluginLoader.startServices / shutdown services", () => {
  test("starts and stops services", async () => {
    const events: string[] = [];
    const descriptor: PluginDescriptor = {
      name: "service-plugin",
      server(api) {
        api.addService({
          start: async () => { events.push("start"); },
          stop: async () => { events.push("stop"); },
        });
      },
    };

    mock.module("/tmp/service-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/service-plugin" }],
      makeInternals(),
    );
    await loader.startServices();
    expect(events).toEqual(["start"]);

    await loader.shutdown();
    expect(events).toEqual(["start", "stop"]);
  });

  test("services stop in reverse order", async () => {
    const order: string[] = [];
    const descriptor: PluginDescriptor = {
      name: "multi-service-plugin",
      server(api) {
        api.addService({
          start: async () => {},
          stop: async () => { order.push("svc1"); },
        });
        api.addService({
          start: async () => {},
          stop: async () => { order.push("svc2"); },
        });
      },
    };

    mock.module("/tmp/multi-service-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/multi-service-plugin" }],
      makeInternals(),
    );
    await loader.shutdown();

    expect(order).toEqual(["svc2", "svc1"]);
  });
});

describe("PluginLoader.getPluginList", () => {
  test("returns tools and routes per plugin", async () => {
    const descriptor: PluginDescriptor = {
      name: "full-plugin",
      server(api) {
        api.addTool("my_tool", {} as any);
        api.addRoutes({
          list: { type: "query", input: z.any(), output: z.any(), handler: async () => [] },
          create: { type: "mutation", input: z.any(), output: z.any(), handler: async () => ({}) },
        }, {});
      },
    };

    mock.module("/tmp/full-plugin", () => ({ default: descriptor }));

    const loader = new PluginLoader();
    await loader.loadAll(
      [{ name: "/tmp/full-plugin" }],
      makeInternals(),
    );

    const list = loader.getPluginList();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("full-plugin");
    expect(list[0].tools).toEqual(["my_tool"]);
    expect(list[0].routes.sort()).toEqual(["create", "list"]);
  });
});
