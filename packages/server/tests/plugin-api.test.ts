import { describe, test, expect, vi } from "vitest";
import { HookRegistry } from "@molf-ai/protocol";
import type { RouteMap, HookLogger } from "@molf-ai/protocol";
import { z } from "zod";

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { createServerPluginApi } from "../src/plugin-api.js";
import type {
  PluginService,
  PluginRouteEntry,
  PluginToolEntry,
  ServerPluginInternals,
} from "../src/plugin-api.js";

const noopLogger: HookLogger = { warn: () => {} };

function makeInternals(): ServerPluginInternals {
  return {
    sessionMgr: { fake: "sessionMgr" } as any,
    eventBus: { fake: "eventBus" } as any,
    agentRunner: { fake: "agentRunner" } as any,
    connectionRegistry: { fake: "connectionRegistry" } as any,
    workspaceStore: { fake: "workspaceStore" } as any,
    workspaceNotifier: { fake: "workspaceNotifier" } as any,
    dataDir: "/test/data",
  };
}

function makeApi(pluginName = "test-plugin", config: unknown = {}) {
  const hookRegistry = new HookRegistry();
  const tools: PluginToolEntry[] = [];
  const routes: PluginRouteEntry[] = [];
  const services: PluginService[] = [];
  const sessionToolFactories: any[] = [];
  const internals = makeInternals();

  const api = createServerPluginApi(
    pluginName, config, hookRegistry,
    internals, tools, routes, services, sessionToolFactories,
  );
  return { api, hookRegistry, tools, routes, services, internals };
}

describe("createServerPluginApi", () => {
  test("api.config returns the provided config", () => {
    const { api } = makeApi("my-plugin", { key: "value" });
    expect(api.config).toEqual({ key: "value" });
  });

  test("api.serverDataDir returns raw internals dataDir", () => {
    const { api } = makeApi();
    expect(api.serverDataDir).toBe("/test/data");
  });

  test("api.dataPath() returns scoped plugin directory", () => {
    const { api } = makeApi("my-plugin");
    expect(api.dataPath()).toBe("/test/data/plugins/my-plugin");
  });

  test("api.dataPath(workerId) returns scoped worker path", () => {
    const { api } = makeApi("my-plugin");
    expect(api.dataPath("w1")).toBe("/test/data/plugins/my-plugin/workers/w1");
  });

  test("api.dataPath(workerId, workspaceId) returns scoped workspace path", () => {
    const { api } = makeApi("my-plugin");
    expect(api.dataPath("w1", "ws1")).toBe("/test/data/plugins/my-plugin/workers/w1/workspaces/ws1");
  });

  test("api exposes all manager internals", () => {
    const { api, internals } = makeApi();
    expect(api.sessionMgr).toBe(internals.sessionMgr);
    expect(api.eventBus).toBe(internals.eventBus);
    expect(api.agentRunner).toBe(internals.agentRunner);
    expect(api.connectionRegistry).toBe(internals.connectionRegistry);
    expect(api.workspaceStore).toBe(internals.workspaceStore);
    expect(api.workspaceNotifier).toBe(internals.workspaceNotifier);
  });

});

describe("api.on — hook registration", () => {
  test("registers handler in HookRegistry with pluginName", async () => {
    const { api, hookRegistry } = makeApi("my-plugin");
    const handler = vi.fn(() => {});

    api.on("turn_start", handler);

    // dispatchObserving is fire-and-forget, give it time to settle
    hookRegistry.dispatchObserving("turn_start", {
      sessionId: "s1", prompt: "hi", model: "test",
    }, noopLogger);
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("passes priority option through", async () => {
    const { api, hookRegistry } = makeApi();
    const order: number[] = [];

    api.on("before_prompt", () => { order.push(0); });
    api.on("before_prompt", () => { order.push(10); }, { priority: 10 });

    await hookRegistry.dispatchModifying("before_prompt", {
      sessionId: "s1",
      systemPrompt: "",
      messages: [],
      model: "test",
      tools: [],
    }, noopLogger);
    expect(order).toEqual([10, 0]);
  });

  test("removePlugin removes handlers registered via api.on", async () => {
    const { api, hookRegistry } = makeApi("removable-plugin");
    const handler = vi.fn(() => {});

    api.on("turn_end", handler);
    hookRegistry.removePlugin("removable-plugin");

    hookRegistry.dispatchObserving("turn_end", {
      sessionId: "s1", message: {} as any, toolCallCount: 0, stepCount: 1, duration: 100,
    }, noopLogger);
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("api.addTool", () => {
  test("adds tool entry with plugin name", () => {
    const { api, tools } = makeApi("cron-plugin");
    const toolDef = { description: "my tool", execute: async () => ({}) };

    api.addTool("cron", toolDef);

    expect(tools).toHaveLength(1);
    expect(tools[0].pluginName).toBe("cron-plugin");
    expect(tools[0].name).toBe("cron");
    expect(tools[0].toolDef).toBe(toolDef);
  });

  test("multiple tools registered", () => {
    const { api, tools } = makeApi("multi-tool");
    api.addTool("tool_a", {} as any);
    api.addTool("tool_b", {} as any);
    expect(tools).toHaveLength(2);
  });
});

describe("api.addRoutes", () => {
  test("adds route entry with plugin name and context", () => {
    const { api, routes } = makeApi("route-plugin");
    const routeMap: RouteMap = {
      list: {
        type: "query",
        input: z.object({}),
        output: z.array(z.string()),
        handler: async () => [],
      },
    };
    const ctx = { store: "fake" };

    api.addRoutes(routeMap, ctx);

    expect(routes).toHaveLength(1);
    expect(routes[0].pluginName).toBe("route-plugin");
    expect(routes[0].routes).toBe(routeMap);
    expect(routes[0].context).toBe(ctx);
  });
});

describe("api.addService", () => {
  test("adds service to the services array", () => {
    const { api, services } = makeApi();
    const svc = {
      start: async () => {},
      stop: async () => {},
    };

    api.addService(svc);

    expect(services).toHaveLength(1);
    expect(services[0]).toBe(svc);
  });
});
