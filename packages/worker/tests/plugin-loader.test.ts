import { describe, test, expect, vi } from "vitest";
import { HookRegistry } from "@molf-ai/protocol";
import type { PluginDescriptor, WorkerPluginApi } from "@molf-ai/protocol";
import { z } from "zod";

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { WorkerPluginLoader } from "../src/plugin-loader.js";
import { ToolExecutor } from "../src/tool-executor.js";

function makeLoader() {
  const hookRegistry = new HookRegistry();
  const toolExecutor = new ToolExecutor();
  const skills: any[] = [];
  const agents: any[] = [];
  const workdir = "/test/workdir";

  const loader = new WorkerPluginLoader(hookRegistry, toolExecutor, skills, agents, workdir);
  return { loader, hookRegistry, toolExecutor, skills, agents };
}

describe("WorkerPluginLoader", () => {
  test("starts with no loaded plugins", () => {
    const { loader } = makeLoader();
    expect(loader.getLoadedPluginNames()).toEqual([]);
  });

  test("loads a plugin with worker() function", async () => {
    const workerFn = vi.fn(() => {});
    const descriptor: PluginDescriptor = {
      name: "test-worker-plugin",
      worker: workerFn,
    };

    vi.doMock("/tmp/test-worker-plugin", () => ({ default: descriptor }));

    const { loader } = makeLoader();
    await loader.loadPlugins([{ specifier: "/tmp/test-worker-plugin" }]);

    expect(workerFn).toHaveBeenCalledTimes(1);
    expect(loader.getLoadedPluginNames()).toEqual(["test-worker-plugin"]);
  });

  test("skips plugin without worker() function", async () => {
    const descriptor: PluginDescriptor = {
      name: "server-only",
      server() {},
    };

    vi.doMock("/tmp/server-only-wp", () => ({ default: descriptor }));

    const { loader } = makeLoader();
    await loader.loadPlugins([{ specifier: "/tmp/server-only-wp" }]);

    expect(loader.getLoadedPluginNames()).toEqual([]);
  });

  test("plugin throwing during init is caught, others still load", async () => {
    const badDescriptor: PluginDescriptor = {
      name: "bad-worker",
      worker() { throw new Error("worker init boom"); },
    };
    const goodDescriptor: PluginDescriptor = {
      name: "good-worker",
      worker() {},
    };

    vi.doMock("/tmp/bad-worker", () => ({ default: badDescriptor }));
    vi.doMock("/tmp/good-worker", () => ({ default: goodDescriptor }));

    const { loader } = makeLoader();
    await loader.loadPlugins([
      { specifier: "/tmp/bad-worker" },
      { specifier: "/tmp/good-worker" },
    ]);

    // good-worker should still load
    expect(loader.getLoadedPluginNames()).toContain("good-worker");
  });

  test("validates config with configSchema", async () => {
    const workerFn = vi.fn((api: WorkerPluginApi) => {
      expect(api.config).toEqual({ timeout: 5000 });
    });
    const descriptor: PluginDescriptor = {
      name: "config-worker",
      configSchema: z.object({ timeout: z.number() }),
      worker: workerFn,
    };

    vi.doMock("/tmp/config-worker", () => ({ default: descriptor }));

    const { loader } = makeLoader();
    await loader.loadPlugins([
      { specifier: "/tmp/config-worker", config: { timeout: 5000 } },
    ]);

    expect(workerFn).toHaveBeenCalledTimes(1);
  });

  test("invalid config prevents plugin from loading", async () => {
    const workerFn = vi.fn(() => {});
    const descriptor: PluginDescriptor = {
      name: "bad-config-worker",
      configSchema: z.object({ timeout: z.number() }),
      worker: workerFn,
    };

    vi.doMock("/tmp/bad-config-worker", () => ({ default: descriptor }));

    const { loader } = makeLoader();
    await loader.loadPlugins([
      { specifier: "/tmp/bad-config-worker", config: { timeout: "bad" } },
    ]);

    expect(workerFn).not.toHaveBeenCalled();
    expect(loader.getLoadedPluginNames()).toEqual([]);
  });
});

describe("WorkerPluginLoader.setSyncStateFn", () => {
  test("fn set before loadPlugins applies to subsequently loaded plugins", async () => {
    const syncCalls: number[] = [];
    const descriptor: PluginDescriptor = {
      name: "sync-test-plugin",
      worker: async (api: WorkerPluginApi) => {
        // Plugin calls syncState during init
        await api.syncState();
      },
    };

    vi.doMock("/tmp/sync-test-plugin", () => ({ default: descriptor }));

    const { loader } = makeLoader();

    // Set fn BEFORE loading plugins
    loader.setSyncStateFn(() => { syncCalls.push(1); });

    await loader.loadPlugins([{ specifier: "/tmp/sync-test-plugin" }]);

    // The plugin called syncState during init — should have worked
    expect(syncCalls).toHaveLength(1);
  });
});

describe("WorkerPluginLoader.destroyAll", () => {
  test("calls destroy on all loaded plugins", async () => {
    const destroyed: string[] = [];
    const descriptorA: PluginDescriptor = {
      name: "destroy-a",
      worker: () => ({ destroy: () => { destroyed.push("a"); } }),
    };
    const descriptorB: PluginDescriptor = {
      name: "destroy-b",
      worker: () => ({ destroy: () => { destroyed.push("b"); } }),
    };

    vi.doMock("/tmp/destroy-a", () => ({ default: descriptorA }));
    vi.doMock("/tmp/destroy-b", () => ({ default: descriptorB }));

    const { loader } = makeLoader();
    await loader.loadPlugins([
      { specifier: "/tmp/destroy-a" },
      { specifier: "/tmp/destroy-b" },
    ]);

    expect(loader.getLoadedPluginNames()).toHaveLength(2);

    await loader.destroyAll();

    expect(destroyed).toContain("a");
    expect(destroyed).toContain("b");
    expect(loader.getLoadedPluginNames()).toEqual([]);
  });

  test("destroy error is caught, other plugins still destroyed", async () => {
    const destroyed: string[] = [];
    const descriptorA: PluginDescriptor = {
      name: "err-destroy-wa",
      worker: () => ({ destroy: () => { throw new Error("destroy error"); } }),
    };
    const descriptorB: PluginDescriptor = {
      name: "err-destroy-wb",
      worker: () => ({ destroy: () => { destroyed.push("b"); } }),
    };

    vi.doMock("/tmp/err-destroy-wa", () => ({ default: descriptorA }));
    vi.doMock("/tmp/err-destroy-wb", () => ({ default: descriptorB }));

    const { loader } = makeLoader();
    await loader.loadPlugins([
      { specifier: "/tmp/err-destroy-wa" },
      { specifier: "/tmp/err-destroy-wb" },
    ]);

    await loader.destroyAll();
    expect(destroyed).toContain("b");
  });

  test("destroyAll on empty loader is a no-op", async () => {
    const { loader } = makeLoader();
    await loader.destroyAll(); // should not throw
  });
});
