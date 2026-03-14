import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import {
  definePlugin,
  defineRoutes,
  createPluginClient,
  HookRegistry,
  BLOCKABLE_HOOKS,
  HOOK_MODES,
  type HookHandlerFn,
  type HookLogger,
  type PluginDescriptor,
  type RouteMap,
  type PluginRpcClient,
  type ModifyResult,
} from "../src/plugin.js";

const noopLogger: HookLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// definePlugin
// ---------------------------------------------------------------------------

describe("definePlugin", () => {
  test("returns the descriptor unchanged", () => {
    const descriptor: PluginDescriptor = {
      name: "test-plugin",
      server(api) { api.on("turn_start", () => {}); },
      worker(api) { api.addTool("t", {}); },
    };
    const result = definePlugin(descriptor);
    expect(result).toBe(descriptor);
  });

  test("preserves configSchema on the descriptor", () => {
    const schema = z.object({ key: z.string() });
    const descriptor = definePlugin({
      name: "with-config",
      configSchema: schema,
      server() {},
    });
    expect(descriptor.configSchema).toBe(schema);
    expect(descriptor.name).toBe("with-config");
  });

  test("works with server-only plugin", () => {
    const d = definePlugin({ name: "server-only", server() {} });
    expect(d.server).toBeDefined();
    expect(d.worker).toBeUndefined();
  });

  test("works with worker-only plugin", () => {
    const d = definePlugin({ name: "worker-only", worker() {} });
    expect(d.worker).toBeDefined();
    expect(d.server).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HookRegistry — dispatchModifying
// ---------------------------------------------------------------------------

describe("HookRegistry.dispatchModifying", () => {
  test("empty registry returns original data with blocked=false", async () => {
    const registry = new HookRegistry();
    const data = { sessionId: "s1", prompt: "hello" };
    const result = await registry.dispatchModifying("turn_start", data, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data).toEqual(data);
  });

  test("handler returning void leaves data unchanged", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p1", () => {});
    const data = { value: 42 };
    const result = await registry.dispatchModifying("test", data, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data).toEqual({ value: 42 });
  });

  test("handler returning undefined leaves data unchanged", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p1", () => undefined);
    const data = { value: 42 };
    const result = await registry.dispatchModifying("test", data, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data).toEqual({ value: 42 });
  });

  test("handler returning partial object merges into data", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p1", () => ({ value: 99 }));
    const result = await registry.dispatchModifying("test", { value: 1, other: "keep" }, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.data).toEqual({ value: 99, other: "keep" });
    }
  });

  test("only merges keys present in original event", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p1", () => ({ value: 99, extraKey: "ignored" }));
    const result = await registry.dispatchModifying("test", { value: 1 }, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.data).toEqual({ value: 99 });
      expect((result.data as any).extraKey).toBeUndefined();
    }
  });

  test("handler returning { block } short-circuits on blockable hook", async () => {
    const registry = new HookRegistry();
    const secondHandler = vi.fn(() => ({ toolName: "modified" }));
    registry.on("before_tool_call", "p1", () => ({ block: "denied" }));
    registry.on("before_tool_call", "p2", secondHandler);

    const result = await registry.dispatchModifying("before_tool_call", {
      sessionId: "s1", toolCallId: "tc1", toolName: "t1", args: {}, workerId: "w1",
    }, noopLogger);
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toBe("denied");
    expect(secondHandler).not.toHaveBeenCalled();
  });

  test("handler returning { block } is ignored on non-blockable hook", async () => {
    const registry = new HookRegistry();
    const warnings: string[] = [];
    const warnLogger = { warn: (msg: string) => warnings.push(msg) };

    registry.on("test", "p1", () => ({ block: "should be ignored" }));

    const result = await registry.dispatchModifying("test", { value: 1 }, warnLogger);
    expect(result.blocked).toBe(false);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("non-blockable");
  });

  test("runs handlers sequentially by priority (higher first)", async () => {
    const registry = new HookRegistry();
    const order: number[] = [];

    registry.on("test", "p1", () => { order.push(0); }, { priority: 0 });
    registry.on("test", "p2", () => { order.push(10); }, { priority: 10 });
    registry.on("test", "p3", () => { order.push(5); }, { priority: 5 });

    await registry.dispatchModifying("test", { x: 1 }, noopLogger);
    expect(order).toEqual([10, 5, 0]);
  });

  test("each handler sees accumulated modifications", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p1", (event: any) => {
      expect(event.count).toBe(0);
      return { count: 1 };
    }, { priority: 10 });
    registry.on("test", "p2", (event: any) => {
      expect(event.count).toBe(1);
      return { count: 2 };
    }, { priority: 0 });

    const result = await registry.dispatchModifying("test", { count: 0 }, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data.count).toBe(2);
  });

  test("handler throwing is caught, logged, and skipped", async () => {
    const warnings: string[] = [];
    const logger: HookLogger = { warn: (msg) => warnings.push(msg) };
    const registry = new HookRegistry();

    registry.on("test", "bad-plugin", () => { throw new Error("boom"); }, { priority: 10 });
    registry.on("test", "good-plugin", () => ({ value: 42 }), { priority: 0 });

    const result = await registry.dispatchModifying("test", { value: 0 }, logger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data.value).toBe(42);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad-plugin");
    expect(warnings[0]).toContain("boom");
  });

  test("async handlers are awaited", async () => {
    const registry = new HookRegistry();
    registry.on("test", "p1", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { value: "async" };
    });
    const result = await registry.dispatchModifying("test", { value: "sync" }, noopLogger);
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.data.value).toBe("async");
  });

  test("block from high-priority handler prevents lower-priority handlers", async () => {
    const registry = new HookRegistry();
    const lowPriority = vi.fn(() => {});

    registry.on("before_tool_execute", "high", () => ({ block: "blocked by high" }), { priority: 100 });
    registry.on("before_tool_execute", "low", lowPriority, { priority: 0 });

    const result = await registry.dispatchModifying("before_tool_execute", {
      toolName: "t1", args: {}, workdir: "/tmp",
    }, noopLogger);
    expect(result.blocked).toBe(true);
    expect(lowPriority).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HookRegistry — dispatchObserving
// ---------------------------------------------------------------------------

describe("HookRegistry.dispatchObserving", () => {
  test("empty registry returns immediately", () => {
    const registry = new HookRegistry();
    // dispatchObserving is fire-and-forget (returns void)
    registry.dispatchObserving("test", { x: 1 }, noopLogger);
  });

  test("runs all handlers", async () => {
    const registry = new HookRegistry();
    const called: string[] = [];

    registry.on("test", "p1", () => { called.push("a"); });
    registry.on("test", "p2", () => { called.push("b"); });

    registry.dispatchObserving("test", {}, noopLogger);
    // Give time for fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(called).toHaveLength(2);
    expect(called).toContain("a");
    expect(called).toContain("b");
  });

  test("errors caught and logged, never propagated", async () => {
    const warnings: string[] = [];
    const logger: HookLogger = { warn: (msg) => warnings.push(msg) };
    const registry = new HookRegistry();
    const successCalled = vi.fn(() => {});

    registry.on("test", "bad", () => { throw new Error("fail"); });
    registry.on("test", "good", successCalled);

    // Should NOT throw
    registry.dispatchObserving("test", {}, logger);
    await new Promise((r) => setTimeout(r, 20));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad");
    expect(warnings[0]).toContain("fail");
    expect(successCalled).toHaveBeenCalledTimes(1);
  });

  test("async errors caught and logged", async () => {
    const warnings: string[] = [];
    const logger: HookLogger = { warn: (msg) => warnings.push(msg) };
    const registry = new HookRegistry();

    registry.on("test", "async-bad", async () => { throw new Error("async fail"); });

    registry.dispatchObserving("test", {}, logger);
    await new Promise((r) => setTimeout(r, 20));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("async fail");
  });
});

// ---------------------------------------------------------------------------
// HookRegistry — on() default priority
// ---------------------------------------------------------------------------

describe("HookRegistry.on", () => {
  test("default priority is 0", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];

    registry.on("test", "p1", () => { order.push("explicit-5"); }, { priority: 5 });
    registry.on("test", "p2", () => { order.push("default"); });
    registry.on("test", "p3", () => { order.push("explicit-neg"); }, { priority: -1 });

    await registry.dispatchModifying("test", {}, noopLogger);
    expect(order).toEqual(["explicit-5", "default", "explicit-neg"]);
  });
});

// ---------------------------------------------------------------------------
// HookRegistry — removePlugin
// ---------------------------------------------------------------------------

describe("HookRegistry.removePlugin", () => {
  test("removes all handlers for a plugin", async () => {
    const registry = new HookRegistry();
    const handler = vi.fn(() => {});

    registry.on("test", "removable", handler);
    registry.on("test", "keeper", () => {});

    registry.removePlugin("removable");

    await registry.dispatchModifying("test", {}, noopLogger);
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not affect other plugins", async () => {
    const registry = new HookRegistry();
    const kept = vi.fn(() => {});

    registry.on("hook_a", "remove-me", () => {});
    registry.on("hook_a", "keep-me", kept);

    registry.removePlugin("remove-me");

    await registry.dispatchModifying("hook_a", {}, noopLogger);
    expect(kept).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BLOCKABLE_HOOKS
// ---------------------------------------------------------------------------

describe("BLOCKABLE_HOOKS", () => {
  test("all blockable hooks are modifying", () => {
    for (const hook of BLOCKABLE_HOOKS) {
      expect(HOOK_MODES[hook]).toBe("modifying");
    }
  });
});

// ---------------------------------------------------------------------------
// defineRoutes
// ---------------------------------------------------------------------------

describe("defineRoutes", () => {
  test("returns the routes unchanged", () => {
    const routes = {
      list: {
        type: "query" as const,
        input: z.object({ id: z.string() }),
        output: z.array(z.string()),
        handler: async ({ input }: any) => [input.id],
      },
    };
    const result = defineRoutes(routes);
    expect(result).toBe(routes);
  });

  test("preserves multiple routes", () => {
    const routes = defineRoutes({
      get: { type: "query" as const, input: z.string(), output: z.string(), handler: async ({ input }: { input: string }) => input },
      set: { type: "mutation" as const, input: z.string(), output: z.boolean(), handler: async () => true },
    });
    expect(Object.keys(routes)).toEqual(["get", "set"]);
    expect(routes.get.type).toBe("query");
    expect(routes.set.type).toBe("mutation");
  });
});

// ---------------------------------------------------------------------------
// createPluginClient
// ---------------------------------------------------------------------------

describe("createPluginClient", () => {
  function makeMockClient() {
    const queryCalls: any[] = [];
    const mutateCalls: any[] = [];
    const client: PluginRpcClient = {
      plugin: {
        async query(input) {
          queryCalls.push(input);
          return { result: `query:${input.method}` };
        },
        async mutate(input) {
          mutateCalls.push(input);
          return { result: `mutate:${input.method}` };
        },
      },
    };
    return { client, queryCalls, mutateCalls };
  }

  const routes = defineRoutes({
    list: { type: "query" as const, input: z.any(), output: z.any(), handler: async () => [] },
    get: { type: "query" as const, input: z.any(), output: z.any(), handler: async () => null },
    create: { type: "mutation" as const, input: z.any(), output: z.any(), handler: async () => ({}) },
  });

  test("proxy maps query method to plugin.query", async () => {
    const { client: rpc, queryCalls } = makeMockClient();
    const proxy = createPluginClient("my-plugin", rpc, routes);

    const result = await proxy.list({ page: 1 });
    expect(result).toBe("query:list");
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toEqual({ plugin: "my-plugin", method: "list", input: { page: 1 } });
  });

  test("proxy maps mutation method to plugin.mutate", async () => {
    const { client: rpc, mutateCalls } = makeMockClient();
    const proxy = createPluginClient("my-plugin", rpc, routes);

    const result = await proxy.create({ name: "test" });
    expect(result).toBe("mutate:create");
    expect(mutateCalls).toHaveLength(1);
    expect(mutateCalls[0].method).toBe("create");
  });

  test("different method names produce different calls", async () => {
    const { client: rpc, queryCalls } = makeMockClient();
    const proxy = createPluginClient("cron", rpc, routes);

    await proxy.list({});
    await proxy.get({ id: "abc" });
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].method).toBe("list");
    expect(queryCalls[1].method).toBe("get");
  });

  test("unknown method rejects with error", async () => {
    const { client: rpc } = makeMockClient();
    const proxy = createPluginClient("cron", rpc, routes) as any;

    expect(proxy.nonexistent({})).rejects.toThrow("Unknown route");
  });
});
