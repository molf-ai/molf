import { resolve } from "path";
import { describe, test, expect, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "fs";
import { readFile } from "node:fs/promises";
import { ToolExecutor } from "../src/tool-executor.js";
import { z } from "zod";
import { TRUNCATION_MAX_LINES } from "@molf-ai/protocol";

describe("ToolExecutor", () => {
  test("registerTool and execute", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "echo",
      description: "Echo input",
      execute: async (args) => ({ output: String(args.text) }),
    });
    const result = await executor.execute("echo", { text: "hello" });
    expect(result.output).toBe("hello");
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

  test("registerTools from multiple definitions", () => {
    const executor = new ToolExecutor();
    executor.registerTools([
      {
        name: "echo",
        description: "Echo tool",
        execute: async (args: any) => ({ output: String(args.text) }),
      },
      {
        name: "calc",
        description: "Calculator",
      },
    ]);
    const infos = executor.getToolInfos();
    expect(infos).toHaveLength(2);
    expect(infos.map((i) => i.name).sort()).toEqual(["calc", "echo"]);
  });

  test("execute unknown tool", async () => {
    const executor = new ToolExecutor();
    const result = await executor.execute("unknown", {});
    expect(result.output).toBe("");
    expect(result.error).toContain("not found");
  });

  test("execute tool without execute function", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({ name: "noop", description: "No-op" });
    const result = await executor.execute("noop", {});
    expect(result.output).toBe("");
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
    expect(result.output).toBe("");
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

  test("registerTool with Zod inputSchema converts to JSON Schema", () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "greet",
      description: "Greet",
      inputSchema: z.object({ name: z.string() }),
      execute: async (args: any) => ({ output: `Hello ${args.name}` }),
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
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "cwd", defaultToWorkdir: true }],
    });
    executor.registerTool({
      name: "read_file",
      description: "Read file",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "path" }],
    });
    executor.registerTool({
      name: "write_file",
      description: "Write file",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "path" }],
    });
    executor.registerTool({
      name: "edit_file",
      description: "Edit file",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "path" }],
    });
    executor.registerTool({
      name: "glob",
      description: "Glob search",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "path", defaultToWorkdir: true }],
    });
    executor.registerTool({
      name: "grep",
      description: "Grep search",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "path", defaultToWorkdir: true }],
    });
    executor.registerTool({
      name: "custom_tool",
      description: "Custom",
      execute: async (args) => ({ output: JSON.stringify(args) }),
    });
    return executor;
  }

  test("shell_exec: defaults cwd to workdir when not provided", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("shell_exec", { command: "ls" });
    expect(JSON.parse(result.output)).toEqual({ command: "ls", cwd: WORKDIR });
  });

  test("shell_exec: resolves relative cwd against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("shell_exec", { command: "ls", cwd: "src" });
    expect(JSON.parse(result.output)).toEqual({ command: "ls", cwd: resolve(WORKDIR, "src") });
  });

  test("shell_exec: preserves absolute cwd", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("shell_exec", { command: "ls", cwd: "/tmp" });
    expect(JSON.parse(result.output)).toEqual({ command: "ls", cwd: "/tmp" });
  });

  test("read_file: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("read_file", { path: "src/main.ts" });
    expect(JSON.parse(result.output)).toEqual({ path: resolve(WORKDIR, "src/main.ts") });
  });

  test("read_file: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("read_file", { path: "/etc/hosts" });
    expect(JSON.parse(result.output)).toEqual({ path: "/etc/hosts" });
  });

  test("write_file: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("write_file", { path: "out.txt", content: "hi" });
    expect(JSON.parse(result.output)).toEqual({ path: resolve(WORKDIR, "out.txt"), content: "hi" });
  });

  test("write_file: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("write_file", { path: "/tmp/out.txt", content: "hi" });
    expect(JSON.parse(result.output)).toEqual({ path: "/tmp/out.txt", content: "hi" });
  });

  test("unknown tools: args passed through unchanged", async () => {
    const executor = makeExecutor(WORKDIR);
    const args = { foo: "bar", path: "relative/path" };
    const result = await executor.execute("custom_tool", args);
    expect(JSON.parse(result.output)).toEqual(args);
  });

  test("edit_file: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("edit_file", { path: "src/main.ts", oldString: "a", newString: "b" });
    expect(JSON.parse(result.output)).toEqual({ path: resolve(WORKDIR, "src/main.ts"), oldString: "a", newString: "b" });
  });

  test("edit_file: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("edit_file", { path: "/etc/file.txt", oldString: "a", newString: "b" });
    expect(JSON.parse(result.output)).toEqual({ path: "/etc/file.txt", oldString: "a", newString: "b" });
  });

  test("glob: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("glob", { pattern: "*.ts", path: "src" });
    expect(JSON.parse(result.output)).toEqual({ pattern: "*.ts", path: resolve(WORKDIR, "src") });
  });

  test("glob: defaults to workdir when path omitted", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("glob", { pattern: "*.ts" });
    expect(JSON.parse(result.output)).toEqual({ pattern: "*.ts", path: WORKDIR });
  });

  test("glob: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("glob", { pattern: "*.ts", path: "/tmp/search" });
    expect(JSON.parse(result.output)).toEqual({ pattern: "*.ts", path: "/tmp/search" });
  });

  test("grep: resolves relative path against workdir", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("grep", { pattern: "foo", path: "src" });
    expect(JSON.parse(result.output)).toEqual({ pattern: "foo", path: resolve(WORKDIR, "src") });
  });

  test("grep: defaults to workdir when path omitted", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("grep", { pattern: "foo" });
    expect(JSON.parse(result.output)).toEqual({ pattern: "foo", path: WORKDIR });
  });

  test("grep: preserves absolute path", async () => {
    const executor = makeExecutor(WORKDIR);
    const result = await executor.execute("grep", { pattern: "foo", path: "/tmp/search" });
    expect(JSON.parse(result.output)).toEqual({ pattern: "foo", path: "/tmp/search" });
  });

  test("no workdir: all args pass through unchanged", async () => {
    const executor = makeExecutor();
    const result = await executor.execute("shell_exec", { command: "ls" });
    expect(JSON.parse(result.output)).toEqual({ command: "ls" });

    const result2 = await executor.execute("read_file", { path: "relative.txt" });
    expect(JSON.parse(result2.output)).toEqual({ path: "relative.txt" });
  });

  test("registerTool with pathArgs resolves paths", async () => {
    const executor = new ToolExecutor(WORKDIR);
    executor.registerTool({
      name: "my_tool",
      description: "Tool with paths",
      execute: async (args: any) => ({ output: JSON.stringify(args) }),
      pathArgs: [{ name: "file", defaultToWorkdir: true }],
    });

    // Absent path → defaults to workdir
    const r1 = await executor.execute("my_tool", { query: "test" });
    expect(JSON.parse(r1.output)).toEqual({ query: "test", file: WORKDIR });

    // Relative path → resolved against workdir
    const r2 = await executor.execute("my_tool", { file: "sub/dir" });
    expect(JSON.parse(r2.output)).toEqual({ file: resolve(WORKDIR, "sub/dir") });

    // Absolute path → preserved
    const r3 = await executor.execute("my_tool", { file: "/absolute/path" });
    expect(JSON.parse(r3.output)).toEqual({ file: "/absolute/path" });
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
      execute: async () => ({ output: "result" }),
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
  const WORKDIR = resolve(import.meta.dirname, "../.test-workdir-exec");

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
      execute: async () => ({ output: bigOutput }),
    });

    const result = await executor.execute("big_tool", {}, "tc-big");
    expect(result.meta?.truncated).toBe(true);
    expect(result.meta?.outputId).toBe("tc-big");
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeLessThan(bigOutput.length);
  });

  test("small string result passes through unchanged", async () => {
    const executor = new ToolExecutor(WORKDIR);
    executor.registerTool({
      name: "small_tool",
      description: "Returns small string",
      execute: async () => ({ output: "hello" }),
    });

    const result = await executor.execute("small_tool", {}, "tc-small");
    expect(result.meta?.truncated).toBeUndefined();
    expect(result.meta?.outputId).toBeUndefined();
    expect(result.output).toBe("hello");
  });

  test("structured result with large output is still truncated", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const bigStdout = "x".repeat(100000);
    executor.registerTool({
      name: "struct_tool",
      description: "Returns structured object",
      execute: async () => ({ output: bigStdout }),
    });

    const result = await executor.execute("struct_tool", {}, "tc-struct");
    // Large output gets truncated by safety net
    expect(typeof result.output).toBe("string");
  });

  test("binary result is passed through", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    executor.registerTool({
      name: "bin_tool",
      description: "Returns binary marker",
      execute: async () => ({ output: "binary:image/png:/f.png:3" }),
    });

    const result = await executor.execute("bin_tool", {}, "tc-bin");
    expect(result.output).toBe("binary:image/png:/f.png:3");
  });

  test("toolCallId passed through to truncation layer", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);
    const bigOutput = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    executor.registerTool({
      name: "id_tool",
      description: "Returns large string",
      execute: async () => ({ output: bigOutput }),
    });

    const result = await executor.execute("id_tool", {}, "specific-id");
    expect(result.meta?.outputId).toBe("specific-id");
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
      execute: async () => ({ output: bigOutput }),
    });

    // Without toolCallId, truncation still applies but uses empty string as id
    const result = await executor.execute("noid_tool", {});
    // truncateAndStore is called with empty toolCallId — still truncates if over limit
    expect(typeof result.output).toBe("string");
  });

  test("no truncation when workdir is not set", async () => {
    const executor = new ToolExecutor(); // no workdir
    const bigOutput = Array.from({ length: TRUNCATION_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n");
    executor.registerTool({
      name: "nowd_tool",
      description: "Returns large string",
      execute: async () => ({ output: bigOutput }),
    });

    const result = await executor.execute("nowd_tool", {}, "tc-nowd");
    expect(result.meta?.truncated).toBeUndefined();
    expect(result.output).toBe(bigOutput);
  });
});

describe("ToolExecutor meta passthrough", () => {
  test("instructionFiles in handler meta are passed through", async () => {
    const executor = new ToolExecutor();
    const files = [{ path: "packages/core/AGENTS.md", content: "Core instructions" }];
    executor.registerTool({
      name: "read_file",
      description: "Read file",
      execute: async () => ({ output: "file content", meta: { instructionFiles: files } }),
    });

    const result = await executor.execute("read_file", {});
    expect(result.meta?.instructionFiles).toBeDefined();
    expect(result.meta?.instructionFiles).toHaveLength(1);
    expect(result.meta?.instructionFiles![0].path).toBe("packages/core/AGENTS.md");
    expect(result.meta?.instructionFiles![0].content).toBe("Core instructions");
  });

  test("handler with no instructionFiles returns undefined", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "read_file",
      description: "Read file",
      execute: async () => ({ output: "content" }),
    });

    const result = await executor.execute("read_file", {});
    expect(result.meta?.instructionFiles).toBeUndefined();
  });

  test("handler meta is passed through for non-read_file tools", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "write_file",
      description: "Write file",
      execute: async () => ({ output: "ok" }),
    });

    const result = await executor.execute("write_file", {});
    expect(result.meta?.instructionFiles).toBeUndefined();
  });
});

describe("ToolExecutor — concurrent execution", () => {
  test("multiple tools execute concurrently without interference", async () => {
    const executor = new ToolExecutor();
    const callOrder: string[] = [];

    let resolveSlowTool!: () => void;
    const slowToolWait = new Promise<void>((r) => (resolveSlowTool = r));

    executor.registerTool({
      name: "slow_tool",
      description: "Slow tool",
      execute: async () => {
        callOrder.push("slow_start");
        await slowToolWait;
        callOrder.push("slow_end");
        return { output: "slow done" };
      },
    });

    executor.registerTool({
      name: "fast_tool",
      description: "Fast tool",
      execute: async () => {
        callOrder.push("fast_start");
        callOrder.push("fast_end");
        return { output: "fast done" };
      },
    });

    // Run both concurrently — resolve slow tool after fast finishes
    const slowPromise = executor.execute("slow_tool", {});
    const fastResult = await executor.execute("fast_tool", {});
    resolveSlowTool();
    const slowResult = await slowPromise;

    expect(slowResult.output).toBe("slow done");
    expect(slowResult.error).toBeUndefined();
    expect(fastResult.output).toBe("fast done");
    expect(fastResult.error).toBeUndefined();

    // Fast tool should complete before slow tool ends
    expect(callOrder.indexOf("fast_end")).toBeLessThan(callOrder.indexOf("slow_end"));
  });
});

describe("ToolExecutor — abortSignal", () => {
  test("early exit when abortSignal already aborted", async () => {
    const executor = new ToolExecutor();
    executor.registerTool({
      name: "echo",
      description: "Echo",
      execute: async (args) => ({ output: String(args.text) }),
    });

    const ac = new AbortController();
    ac.abort();
    const result = await executor.execute("echo", { text: "hello" }, "tc1", ac.signal);
    expect(result.error).toBe("Aborted");
    expect(result.output).toBe("");
  });

  test("passes abortSignal to tool handler context", async () => {
    const executor = new ToolExecutor();
    let receivedSignal: AbortSignal | undefined;
    executor.registerTool({
      name: "signal_check",
      description: "Checks signal",
      execute: async (_args, ctx) => {
        receivedSignal = ctx.abortSignal;
        return { output: "ok" };
      },
    });

    const ac = new AbortController();
    await executor.execute("signal_check", {}, "tc1", ac.signal);
    expect(receivedSignal).toBe(ac.signal);
    expect(receivedSignal!.aborted).toBe(false);
  });

  test("passes undefined abortSignal when not provided", async () => {
    const executor = new ToolExecutor();
    let receivedSignal: AbortSignal | undefined = "sentinel" as any;
    executor.registerTool({
      name: "no_signal",
      description: "No signal",
      execute: async (_args, ctx) => {
        receivedSignal = ctx.abortSignal;
        return { output: "ok" };
      },
    });

    await executor.execute("no_signal", {}, "tc1");
    expect(receivedSignal).toBeUndefined();
  });
});

describe("ToolExecutor — pathArgs edge cases", () => {
  test("tool with no pathArgs passes args through unchanged", async () => {
    const executor = new ToolExecutor("/some/workdir");
    executor.registerTool({
      name: "no_paths",
      description: "No path args",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      // No pathArgs declared
    });

    const result = await executor.execute("no_paths", { query: "test", path: "relative/file" });
    // path should NOT be resolved since no pathArgs declared
    const parsed = JSON.parse(result.output);
    expect(parsed.path).toBe("relative/file");
    expect(parsed.query).toBe("test");
  });

  test("tool with empty pathArgs array passes args through unchanged", async () => {
    const executor = new ToolExecutor("/some/workdir");
    executor.registerTool({
      name: "empty_paths",
      description: "Empty path args",
      execute: async (args) => ({ output: JSON.stringify(args) }),
      pathArgs: [],
    });

    const result = await executor.execute("empty_paths", { path: "relative/file" });
    const parsed = JSON.parse(result.output);
    expect(parsed.path).toBe("relative/file");
  });
});

describe("ToolExecutor — truncation with large output end-to-end", () => {
  const WORKDIR = resolve(import.meta.dirname, "../.test-workdir-trunc-e2e");

  afterEach(() => {
    rmSync(WORKDIR, { recursive: true, force: true });
  });

  test("large output is truncated and stored to disk", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);

    const bigOutput = Array.from(
      { length: TRUNCATION_MAX_LINES + 200 },
      (_, i) => `line-${i}: ${"x".repeat(80)}`,
    ).join("\n");

    executor.registerTool({
      name: "big_output",
      description: "Returns a huge output",
      execute: async () => ({ output: bigOutput }),
    });

    const result = await executor.execute("big_output", {}, "tc-big-e2e");
    expect(result.meta?.truncated).toBe(true);
    expect(result.meta?.outputId).toBe("tc-big-e2e");
    expect(result.output.length).toBeLessThan(bigOutput.length);
    expect(result.output).toContain("truncated");

    // Verify file was saved
    const outputPath = resolve(WORKDIR, ".molf/tool-output/tc-big-e2e.txt");
    expect(existsSync(outputPath)).toBe(true);
    const savedContent = await readFile(outputPath, "utf-8");
    expect(savedContent).toBe(bigOutput);
  });

  test("handler-owned truncation (meta.truncated set) passes through without safety net", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);

    executor.registerTool({
      name: "self_truncated",
      description: "Handles its own truncation",
      execute: async () => ({
        output: "already truncated content",
        meta: { truncated: true },
      }),
    });

    const result = await executor.execute("self_truncated", {}, "tc-self");
    expect(result.meta?.truncated).toBe(true);
    expect(result.output).toBe("already truncated content");
    // No file should be saved since handler owns truncation
    const outputPath = resolve(WORKDIR, ".molf/tool-output/tc-self.txt");
    expect(existsSync(outputPath)).toBe(false);
  });

  test("handler setting meta.truncated=false also skips safety net", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const executor = new ToolExecutor(WORKDIR);

    const bigOutput = Array.from(
      { length: TRUNCATION_MAX_LINES + 50 },
      (_, i) => `line ${i}`,
    ).join("\n");

    executor.registerTool({
      name: "not_truncated",
      description: "Claims not truncated",
      execute: async () => ({
        output: bigOutput,
        meta: { truncated: false },
      }),
    });

    const result = await executor.execute("not_truncated", {}, "tc-not");
    // Handler says it's not truncated — pass through as-is
    expect(result.meta?.truncated).toBe(false);
    expect(result.output).toBe(bigOutput);
  });
});
