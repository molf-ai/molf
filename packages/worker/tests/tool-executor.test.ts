import { resolve } from "path";
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

describe("ToolExecutor with workdir", () => {
  const WORKDIR = "/home/user/project";

  function makeExecutor(workdir?: string) {
    const executor = new ToolExecutor(workdir);
    executor.registerTool({
      name: "shell_exec",
      description: "Run shell",
      execute: async (args) => args,
    });
    executor.registerTool({
      name: "read_file",
      description: "Read file",
      execute: async (args) => args,
    });
    executor.registerTool({
      name: "write_file",
      description: "Write file",
      execute: async (args) => args,
    });
    executor.registerTool({
      name: "custom_tool",
      description: "Custom",
      execute: async (args) => args,
    });
    return executor;
  }

  test("shell_exec: defaults cwd to workdir when not provided", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("shell_exec", { command: "ls" });
    expect(result.result).toEqual({ command: "ls", cwd: WORKDIR });
  });

  test("shell_exec: resolves relative cwd against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("shell_exec", { command: "ls", cwd: "src" });
    expect(result.result).toEqual({ command: "ls", cwd: resolve(WORKDIR, "src") });
  });

  test("shell_exec: preserves absolute cwd", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("shell_exec", { command: "ls", cwd: "/tmp" });
    expect(result.result).toEqual({ command: "ls", cwd: "/tmp" });
  });

  test("read_file: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("read_file", { path: "src/main.ts" });
    expect(result.result).toEqual({ path: resolve(WORKDIR, "src/main.ts") });
  });

  test("read_file: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("read_file", { path: "/etc/hosts" });
    expect(result.result).toEqual({ path: "/etc/hosts" });
  });

  test("write_file: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("write_file", { path: "out.txt", content: "hi" });
    expect(result.result).toEqual({ path: resolve(WORKDIR, "out.txt"), content: "hi" });
  });

  test("write_file: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("write_file", { path: "/tmp/out.txt", content: "hi" });
    expect(result.result).toEqual({ path: "/tmp/out.txt", content: "hi" });
  });

  test("unknown tools: args passed through unchanged", async () => {
    const executor = makeExecutor(WORKDIR);
    const args = { foo: "bar", path: "relative/path" };
    const result = await executor.execute("custom_tool", args);
    expect(result.result).toEqual(args);
  });

  test("no workdir: all args pass through unchanged", async () => {
    const executor = makeExecutor();
    const result = await executor.execute("shell_exec", { command: "ls" });
    expect(result.result).toEqual({ command: "ls" });

    const result2 = await executor.execute("read_file", { path: "relative.txt" });
    expect(result2.result).toEqual({ path: "relative.txt" });
  });
});
