import { resolve } from "path";
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { ToolExecutor } from "../src/tool-executor.js";
import { z } from "zod";
import { TRUNCATION_MAX_LINES } from "@molf-ai/protocol";

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
      pathArgs: [{ name: "cwd", defaultToWorkdir: true }],
    });
    executor.registerTool({
      name: "read_file",
      description: "Read file",
      execute: async (args) => args,
      pathArgs: [{ name: "path" }],
    });
    executor.registerTool({
      name: "write_file",
      description: "Write file",
      execute: async (args) => args,
      pathArgs: [{ name: "path" }],
    });
    executor.registerTool({
      name: "edit_file",
      description: "Edit file",
      execute: async (args) => args,
      pathArgs: [{ name: "path" }],
    });
    executor.registerTool({
      name: "glob",
      description: "Glob search",
      execute: async (args) => args,
      pathArgs: [{ name: "path", defaultToWorkdir: true }],
    });
    executor.registerTool({
      name: "grep",
      description: "Grep search",
      execute: async (args) => args,
      pathArgs: [{ name: "path", defaultToWorkdir: true }],
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

  test("edit_file: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("edit_file", { path: "src/main.ts", oldString: "a", newString: "b" });
    expect(result.result).toEqual({ path: resolve(WORKDIR, "src/main.ts"), oldString: "a", newString: "b" });
  });

  test("edit_file: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("edit_file", { path: "/etc/file.txt", oldString: "a", newString: "b" });
    expect(result.result).toEqual({ path: "/etc/file.txt", oldString: "a", newString: "b" });
  });

  test("glob: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("glob", { pattern: "*.ts", path: "src" });
    expect(result.result).toEqual({ pattern: "*.ts", path: resolve(WORKDIR, "src") });
  });

  test("glob: defaults to workdir when path omitted", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("glob", { pattern: "*.ts" });
    expect(result.result).toEqual({ pattern: "*.ts", path: WORKDIR });
  });

  test("glob: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("glob", { pattern: "*.ts", path: "/tmp/search" });
    expect(result.result).toEqual({ pattern: "*.ts", path: "/tmp/search" });
  });

  test("grep: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("grep", { pattern: "foo", path: "src" });
    expect(result.result).toEqual({ pattern: "foo", path: resolve(WORKDIR, "src") });
  });

  test("grep: defaults to workdir when path omitted", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("grep", { pattern: "foo" });
    expect(result.result).toEqual({ pattern: "foo", path: WORKDIR });
  });

  test("grep: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("grep", { pattern: "foo", path: "/tmp/search" });
    expect(result.result).toEqual({ pattern: "foo", path: "/tmp/search" });
  });

  test("no workdir: all args pass through unchanged", async () => {
    const executor = makeExecutor();
    const result = await executor.execute("shell_exec", { command: "ls" });
    expect(result.result).toEqual({ command: "ls" });

    const result2 = await executor.execute("read_file", { path: "relative.txt" });
    expect(result2.result).toEqual({ path: "relative.txt" });
  });

  test("registerToolSet with pathArgs resolves paths", async () => {
    const executor = new ToolExecutor(WORKDIR);
    executor.registerToolSet(
      {
        my_tool: {
          description: "Tool with paths",
          execute: async (args: any) => args,
        },
      },
      {
        my_tool: [{ name: "file", defaultToWorkdir: true }],
      },
    );

    // Absent path → defaults to workdir
    const r1 = await executor.execute("my_tool", { query: "test" });
    expect(r1.result).toEqual({ query: "test", file: WORKDIR });

    // Relative path → resolved against workdir
    const r2 = await executor.execute("my_tool", { file: "sub/dir" });
    expect(r2.result).toEqual({ file: resolve(WORKDIR, "sub/dir") });

    // Absolute path → preserved
    const r3 = await executor.execute("my_tool", { file: "/absolute/path" });
    expect(r3.result).toEqual({ file: "/absolute/path" });
  });
});

describe("deregisterTools / getToolNames", () => {
  test("getToolNames returns all registered names", () => {
    const executor = new ToolExecutor();
    executor.registerTools([
      { name: "a", description: "A" },
      { name: "b", description: "B" },
      { name: "c", description: "C" },
    ]);
    expect(executor.getToolNames().sort()).toEqual(["a", "b", "c"]);
  });

  test("deregisterTools removes specified tools; others remain", () => {
    const executor = new ToolExecutor();
    executor.registerTools([
      { name: "a", description: "A" },
      { name: "b", description: "B" },
      { name: "c", description: "C" },
    ]);
    executor.deregisterTools(["a", "c"]);
    expect(executor.getToolNames()).toEqual(["b"]);
  });

  test("unknown names in deregisterTools are silently ignored", () => {
    const executor = new ToolExecutor();
    executor.registerTool({ name: "a", description: "A" });
    expect(() => executor.deregisterTools(["nonexistent"])).not.toThrow();
    expect(executor.getToolNames()).toEqual(["a"]);
  });

  test("deregistered tool returns 'not found' error on execute", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "a",
      description: "A",
      execute: async () => "result",
    });
    executor.deregisterTools(["a"]);
    const result = await executor.execute("a", {});
    expect(result.error).toContain("not found");
  });

  test("empty array deregister is a no-op", () => {
    const executor = new ToolExecutor();
    executor.registerTool({ name: "a", description: "A" });
    executor.deregisterTools([]);
    expect(executor.getToolNames()).toEqual(["a"]);
  });
});

describe("ToolExecutor truncation", () => {
  const WORKDIR = resolve(import.meta.dir, "../.test-workdir-exec");

  afterEach(() => {
    rmSync(WORKDIR, { recursive: true, force: true });
  });

  test("large string result is truncated with outputId", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const bigOutput = Array.from({ length: TRUNCATION_MAX_LINES + 100 }, (_, i) => `line ${i}`).join("\n");
    executor.registerTool({
      name: "big_tool",
      description: "Returns large string",
      execute: async () => bigOutput,
    });

    const result = await executor.execute("big_tool", {}, "tc-big");
    expect(result.truncated).toBe(true);
    expect(result.outputId).toBe("tc-big");
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBeLessThan(bigOutput.length);
  });

  test("small string result passes through unchanged", async () => {
    const executor = new ToolExecutor(WORKDIR);
    executor.registerTool({
      name: "small_tool",
      description: "Returns small string",
      execute: async () => "hello",
    });

    const result = await executor.execute("small_tool", {}, "tc-small");
    expect(result.truncated).toBeUndefined();
    expect(result.outputId).toBeUndefined();
    expect(result.result).toBe("hello");
  });

  test("structured result is NOT truncated by ToolExecutor", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const structured = { stdout: "x".repeat(100000), stderr: "", exitCode: 0 };
    executor.registerTool({
      name: "struct_tool",
      description: "Returns structured object",
      execute: async () => structured,
    });

    const result = await executor.execute("struct_tool", {}, "tc-struct");
    expect(result.truncated).toBeUndefined();
    expect(result.outputId).toBeUndefined();
    expect(result.result).toEqual(structured);
  });

  test("binary result is skipped entirely", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const binary = { type: "binary", data: "AAAA", mimeType: "image/png", path: "/f.png", size: 3 };
    executor.registerTool({
      name: "bin_tool",
      description: "Returns binary",
      execute: async () => binary,
    });

    const result = await executor.execute("bin_tool", {}, "tc-bin");
    expect(result.truncated).toBeUndefined();
    expect(result.result).toEqual(binary);
  });

  test("toolCallId passed through to truncation layer", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const bigOutput = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    executor.registerTool({
      name: "id_tool",
      description: "Returns large string",
      execute: async () => bigOutput,
    });

    const result = await executor.execute("id_tool", {}, "specific-id");
    expect(result.outputId).toBe("specific-id");
    // Verify file was saved with the correct name
    const outputPath = resolve(WORKDIR, ".molf/tool-output/specific-id.txt");
    expect(existsSync(outputPath)).toBe(true);
  });

  test("no truncation when toolCallId is not provided", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const bigOutput = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    executor.registerTool({
      name: "noid_tool",
      description: "Returns large string",
      execute: async () => bigOutput,
    });

    // Without toolCallId, no truncation
    const result = await executor.execute("noid_tool", {});
    expect(result.truncated).toBeUndefined();
    expect(result.result).toBe(bigOutput);
  });

  test("no truncation when workdir is not set", async () => {
    const executor = new ToolExecutor(); // no workdir
    const bigOutput = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    executor.registerTool({
      name: "nowd_tool",
      description: "Returns large string",
      execute: async () => bigOutput,
    });

    const result = await executor.execute("nowd_tool", {}, "tc-nowd");
    expect(result.truncated).toBeUndefined();
    expect(result.result).toBe(bigOutput);
  });
});
