import { describe, test, expect } from "bun:test";
import { ToolExecutor } from "../src/tool-executor.js";
import { z } from "zod";

describe("ToolExecutor", () => {
  test("registerTool and execute", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "echo",
      description: "Echo input",
      execute: async (args) => args.text,
    });
    const result = await executor.execute("echo", { text: "hello" });
    expect(result.result).toBe("hello");
    expect(result.error).toBeUndefined();
  });

  test("registerTools batch", () => {
    const executor = new ToolExecutor();
    executor.registerTools([
      { name: "a", description: "Tool A" },
      { name: "b", description: "Tool B" },
    ]);
    expect(executor.getToolInfos()).toHaveLength(2);
  });

  test("registerToolSet from Vercel AI SDK format", () => {
    const executor = new ToolExecutor();
    executor.registerToolSet({
      echo: {
        description: "Echo tool",
        execute: async (args: any) => args.text,
      },
      calc: {
        description: "Calculator",
      },
    });
    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(2);
    expect(infos.map((i) => i.name).sort()).toEqual(["calc", "echo"]);
  });

  test("execute unknown tool", async () => {
    const executor = new ToolExecutor();
    const result = await executor.execute("unknown", {});
    expect(result.result).toBeNull();
    expect(result.error).toContain("not found");
  });

  test("execute tool without execute function", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({ name: "noop", description: "No-op" });
    const result = await executor.execute("noop", {});
    expect(result.result).toBeNull();
    expect(result.error).toContain("no execute");
  });

  test("execute tool that throws", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "fail",
      description: "Fails",
      execute: async () => {
        throw new Error("boom");
      },
    });
    const result = await executor.execute("fail", {});
    expect(result.result).toBeNull();
    expect(result.error).toBe("boom");
  });

  test("getToolInfos with Zod schema", () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "typed",
      description: "Typed tool",
      inputSchema: z.object({ text: z.string() }),
    });
    const infos = executor.getToolInfos();
    expect(infos[0].inputSchema).toBeDefined();
    expect((infos[0].inputSchema as any).type).toBe("object");
  });

  test("registerToolSet with Zod inputSchema converts to JSON Schema", () => {
    const executor = new ToolExecutor();
    executor.registerToolSet({
      greet: {
        description: "Greet",
        inputSchema: z.object({ name: z.string() }),
        execute: async (args: any) => `Hello ${args.name}`,
      },
    });
    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(1);
    expect((infos[0].inputSchema as any).type).toBe("object");
    expect((infos[0].inputSchema as any).properties).toBeDefined();
  });

  test("getToolInfos with no inputSchema returns empty object", () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "bare",
      description: "No schema",
    });
    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(1);
    expect(infos[0].inputSchema).toEqual({});
  });

  test("getToolInfos with plain JSON Schema", () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "plain",
      description: "Plain schema tool",
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
    });
    const infos = executor.getToolInfos();
    expect((infos[0].inputSchema as any).type).toBe("object");
  });
});
