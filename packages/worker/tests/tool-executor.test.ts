import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolExecutor } from "../src/tool-executor.js";
import type { WorkerTool } from "../src/tool-executor.js";

function makeTool(name: string, fn?: (args: unknown) => Promise<unknown>): WorkerTool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: z.object({ input: z.string() }),
    execute: fn ?? (async (args: unknown) => `result from ${name}`),
  };
}

describe("ToolExecutor", () => {
  test("registerTool and execute", async () => {
    const executor = new ToolExecutor();
    executor.registerTool(makeTool("my_tool"));

    const result = await executor.execute("my_tool", { input: "test" });

    expect(result.result).toBe("result from my_tool");
    expect(result.error).toBeUndefined();
  });

  test("registerTools registers multiple", () => {
    const executor = new ToolExecutor();
    executor.registerTools([makeTool("a"), makeTool("b"), makeTool("c")]);

    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(3);
  });

  test("getToolInfos returns name, description, and schema", () => {
    const executor = new ToolExecutor();
    executor.registerTool(makeTool("shell_exec"));

    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(1);
    expect(infos[0].name).toBe("shell_exec");
    expect(infos[0].description).toBe("Test tool: shell_exec");
    expect(infos[0].inputSchema).toBeDefined();
    expect(typeof infos[0].inputSchema).toBe("object");
  });

  test("execute returns error for unknown tool", async () => {
    const executor = new ToolExecutor();

    const result = await executor.execute("nonexistent", {});
    expect(result.error).toBe('Tool "nonexistent" not found');
    expect(result.result).toBeNull();
  });

  test("execute returns error for tool without execute function", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "no-exec",
      description: "No execute",
      inputSchema: z.object({}),
      // No execute function
    });

    const result = await executor.execute("no-exec", {});
    expect(result.error).toBe('Tool "no-exec" has no execute function');
  });

  test("execute catches tool errors", async () => {
    const executor = new ToolExecutor();
    executor.registerTool(
      makeTool("failing", async () => {
        throw new Error("Tool crashed");
      }),
    );

    const result = await executor.execute("failing", { input: "test" });
    expect(result.error).toBe("Tool crashed");
    expect(result.result).toBeNull();
  });

  test("execute passes arguments to tool", async () => {
    const executor = new ToolExecutor();
    let receivedArgs: unknown;

    executor.registerTool(
      makeTool("capture", async (args) => {
        receivedArgs = args;
        return "ok";
      }),
    );

    await executor.execute("capture", { input: "hello" });
    expect(receivedArgs).toEqual({ input: "hello" });
  });

  test("getToolInfos for tool without inputSchema", () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "simple",
      description: "Simple tool",
      // No inputSchema
      execute: async () => "ok",
    });

    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(1);
    expect(infos[0].inputSchema).toEqual({});
  });
});
