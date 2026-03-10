import { describe, test, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "@molf-ai/protocol";

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { ToolExecutor } from "../src/tool-executor.js";

const noopLogger = { warn: () => {} };

describe("ToolExecutor hook integration", () => {
  let executor: InstanceType<typeof ToolExecutor>;
  let registry: InstanceType<typeof HookRegistry>;

  beforeEach(() => {
    executor = new ToolExecutor("/tmp");
    registry = new HookRegistry();
    executor.setHookRegistry(registry, noopLogger);

    executor.registerTool({
      name: "echo",
      description: "Echo args back",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args) => ({ output: `echo: ${args.text}` }),
    });
  });

  test("before_tool_execute can modify args", async () => {
    registry.on("before_tool_execute", "test-plugin", (data: any) => ({
      args: { ...data.args, text: "modified" },
    }));

    const result = await executor.execute("echo", { text: "original" });
    expect(result.output).toContain("modified");
  });

  test("before_tool_execute can block execution", async () => {
    const executeSpy = vi.fn(async () => ({ output: "should not run" }));
    executor.registerTool({
      name: "blocked_tool",
      description: "Will be blocked",
      inputSchema: {},
      execute: executeSpy,
    });

    registry.on("before_tool_execute", "test-plugin", () => ({
      block: "Not allowed by policy",
    }));

    const result = await executor.execute("blocked_tool", {});
    expect(result.error).toContain("Not allowed by policy");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test("after_tool_execute can modify result", async () => {
    registry.on("after_tool_execute", "test-plugin", (data: any) => ({
      result: { ...data.result, output: data.result.output + " [appended]" },
    }));

    const result = await executor.execute("echo", { text: "hello" });
    expect(result.output).toContain("echo: hello [appended]");
  });

  test("before_tool_execute error does not prevent execution", async () => {
    registry.on("before_tool_execute", "bad-plugin", () => {
      throw new Error("Plugin crashed!");
    });

    const result = await executor.execute("echo", { text: "works" });
    expect(result.output).toContain("echo: works");
  });

  test("after_tool_execute error preserves original result", async () => {
    registry.on("after_tool_execute", "bad-plugin", () => {
      throw new Error("Plugin crashed!");
    });

    const result = await executor.execute("echo", { text: "safe" });
    expect(result.output).toContain("echo: safe");
  });

  test("execution works without hookRegistry set", async () => {
    const plainExecutor = new ToolExecutor("/tmp");
    plainExecutor.registerTool({
      name: "echo",
      description: "Echo",
      inputSchema: {},
      execute: async (args) => ({ output: `echo: ${args.text}` }),
    });

    const result = await plainExecutor.execute("echo", { text: "no hooks" });
    expect(result.output).toContain("echo: no hooks");
  });

  test("before_tool_execute receives correct event data", async () => {
    let capturedData: any;
    registry.on("before_tool_execute", "spy-plugin", (data: any) => {
      capturedData = data;
    });

    await executor.execute("echo", { text: "hello" }, "tc-123");

    expect(capturedData).toBeDefined();
    expect(capturedData.toolName).toBe("echo");
    expect(capturedData.args.text).toBe("hello");
    expect(capturedData.workdir).toBe("/tmp");
  });

  test("after_tool_execute receives duration and result", async () => {
    let capturedData: any;
    registry.on("after_tool_execute", "spy-plugin", (data: any) => {
      capturedData = data;
    });

    await executor.execute("echo", { text: "timed" });

    expect(capturedData).toBeDefined();
    expect(capturedData.toolName).toBe("echo");
    expect(capturedData.result.output).toContain("echo: timed");
    expect(typeof capturedData.duration).toBe("number");
  });
});
