import { describe, test, expect, mock } from "bun:test";
import { HookRegistry } from "@molf-ai/protocol";
import type { WorkerSkillInfo, WorkerAgentInfo, HookLogger } from "@molf-ai/protocol";

mock.module("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const { WorkerPluginApiImpl } = await import("../src/plugin-api.js");
const { ToolExecutor } = await import("../src/tool-executor.js");

const noopLogger: HookLogger = { warn: () => {} };

function makeApi(pluginName = "test-plugin", config: unknown = {}) {
  const hookRegistry = new HookRegistry();
  const toolExecutor = new ToolExecutor();
  const skills: WorkerSkillInfo[] = [];
  const agents: WorkerAgentInfo[] = [];
  const workdir = "/test/workdir";

  const api = new WorkerPluginApiImpl(
    pluginName, hookRegistry, toolExecutor,
    skills, agents, workdir, config,
  );
  return { api, hookRegistry, toolExecutor, skills, agents };
}

describe("WorkerPluginApiImpl", () => {
  test("exposes config", () => {
    const { api } = makeApi("p", { key: "val" });
    expect(api.config).toEqual({ key: "val" });
  });

  test("exposes workdir", () => {
    const { api } = makeApi();
    expect(api.workdir).toBe("/test/workdir");
  });

  test("log has debug/info/warn/error methods", () => {
    const { api } = makeApi();
    expect(typeof api.log.debug).toBe("function");
    expect(typeof api.log.info).toBe("function");
    expect(typeof api.log.warn).toBe("function");
    expect(typeof api.log.error).toBe("function");
  });
});

describe("api.on — hook registration", () => {
  test("registers handler in HookRegistry with pluginName", async () => {
    const { api, hookRegistry } = makeApi("my-worker-plugin");
    const handler = mock(() => {});

    api.on("worker_start", handler);

    hookRegistry.dispatchObserving("worker_start", {
      workerId: "w1", workdir: "/test",
    }, noopLogger);
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("supports priority option", async () => {
    const { api, hookRegistry } = makeApi();
    const order: number[] = [];

    api.on("before_tool_execute", () => { order.push(0); });
    api.on("before_tool_execute", () => { order.push(10); }, { priority: 10 });

    await hookRegistry.dispatchModifying("before_tool_execute", {
      toolName: "test", args: {}, workdir: "/test",
    }, noopLogger);
    expect(order).toEqual([10, 0]);
  });

  test("removePlugin removes handlers registered via api.on", async () => {
    const { api, hookRegistry } = makeApi("removable-worker");
    const handler = mock(() => {});

    api.on("worker_stop", handler);
    hookRegistry.removePlugin("removable-worker");

    hookRegistry.dispatchObserving("worker_stop", {}, noopLogger);
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("api.addTool", () => {
  test("registers tool in ToolExecutor", async () => {
    const { api, toolExecutor } = makeApi();

    api.addTool("my_tool", {
      description: "A test tool",
      execute: async () => ({ output: "result" }),
    });

    const infos = toolExecutor.getToolInfos();
    expect(infos).toHaveLength(1);
    expect(infos[0].name).toBe("my_tool");
  });

  test("registered tool is executable", async () => {
    const { api, toolExecutor } = makeApi();

    api.addTool("echo", {
      description: "Echo tool",
      execute: async (args: any) => ({ output: String(args.text) }),
    });

    const result = await toolExecutor.execute("echo", { text: "hello" });
    expect(result.output).toBe("hello");
  });
});

describe("api.addSkill", () => {
  test("adds skill to the skills array", () => {
    const { api, skills } = makeApi();

    api.addSkill({ name: "deploy", description: "Deploy app", content: "Run deploy script..." });

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("deploy");
    expect(skills[0].description).toBe("Deploy app");
  });

  test("multiple skills can be added", () => {
    const { api, skills } = makeApi();

    api.addSkill({ name: "skill-a", description: "A", content: "..." });
    api.addSkill({ name: "skill-b", description: "B", content: "..." });

    expect(skills).toHaveLength(2);
  });
});

describe("api.addAgent", () => {
  test("adds agent to the agents array", () => {
    const { api, agents } = makeApi();

    api.addAgent({
      name: "reviewer",
      description: "Code review agent",
      content: "Review code carefully.",
    });

    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("reviewer");
  });

  test("multiple agents can be added", () => {
    const { api, agents } = makeApi();

    api.addAgent({ name: "agent-a", description: "A", content: "..." });
    api.addAgent({ name: "agent-b", description: "B", content: "..." });

    expect(agents).toHaveLength(2);
  });
});
