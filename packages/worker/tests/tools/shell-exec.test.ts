import { describe, test, expect, afterEach } from "vitest";
import { resolve } from "path";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { shellExecTool, executeShellCommand, resolveShell, resetShellCache } from "../../src/tools/shell-exec.js";
import type { ShellCommandResult } from "../../src/tools/shell-exec.js";
import { TRUNCATION_MAX_LINES } from "@molf-ai/protocol";

describe("shellExecTool", () => {
  test("has execute function, description, and inputSchema", () => {
    expect(shellExecTool.execute).toBeDefined();
    expect(shellExecTool.description).toBeDefined();
    expect(shellExecTool.inputSchema).toBeDefined();
  });
});

describe("executeShellCommand — basic", () => {
  test("execute echo hello", async () => {
    const result = await executeShellCommand({ command: "echo hello" });
    expect("output" in result && result.output.trim()).toBe("hello");
  });

  test("execute failing command", async () => {
    const result = await executeShellCommand({ command: "exit 1" });
    expect("exitCode" in result && result.exitCode).toBe(1);
  });

  test("timeout respected", async () => {
    const result = await executeShellCommand({ command: "sleep 10", timeout: 100 });
    expect("error" in result && result.error).toContain("timed out");
  }, 10_000);

  test("process tree killed on timeout", async () => {
    // Spawn a command that creates a child process (subshell with sleep)
    const result = await executeShellCommand({ command: "sh -c 'sleep 60' & sleep 60", timeout: 200 });
    expect("error" in result && result.error).toContain("timed out");
  }, 10_000);
});

describe("executeShellCommand", () => {
  const WORKDIR = resolve(import.meta.dirname, "../../.test-workdir-shellexec");

  afterEach(() => {
    rmSync(WORKDIR, { recursive: true, force: true });
  });

  test("basic execution returns structured result", async () => {
    const result = await executeShellCommand({ command: "echo hello" }) as Exclude<ShellCommandResult, { error: string }>;
    expect(result.output).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("uses line/byte-based truncation", async () => {
    // Generate output exceeding line limit
    const lineCount = TRUNCATION_MAX_LINES + 500;
    const cmd = `seq 1 ${lineCount}`;
    const result = await executeShellCommand({ command: cmd }) as Exclude<ShellCommandResult, { error: string }>;
    expect(result.truncated).toBe(true);
    // Truncated output should have fewer lines
    const lines = result.output.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(TRUNCATION_MAX_LINES);
  });

  test("saves full output to disk when truncated with context", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const lineCount = TRUNCATION_MAX_LINES + 100;
    const cmd = `seq 1 ${lineCount}`;

    const result = await executeShellCommand(
      { command: cmd },
      { toolCallId: "tc-shell-1", workdir: WORKDIR },
    ) as Exclude<ShellCommandResult, { error: string }>;

    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBeDefined();

    const savedPath = result.outputPath!;
    expect(existsSync(savedPath)).toBe(true);
    const savedContent = readFileSync(savedPath, "utf-8");
    const savedLines = savedContent.split("\n").filter(Boolean);
    expect(savedLines.length).toBe(lineCount);
  });

  test("saves full output to disk when stderr redirected and truncated", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const lineCount = TRUNCATION_MAX_LINES + 100;
    const cmd = `seq 1 ${lineCount} >&2`;

    const result = await executeShellCommand(
      { command: cmd },
      { toolCallId: "tc-shell-2", workdir: WORKDIR },
    ) as Exclude<ShellCommandResult, { error: string }>;

    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBeDefined();
    expect(existsSync(result.outputPath!)).toBe(true);
  });

  test("no outputPath when not truncated", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const result = await executeShellCommand(
      { command: "echo hi" },
      { toolCallId: "tc-shell-3", workdir: WORKDIR },
    ) as Exclude<ShellCommandResult, { error: string }>;

    expect(result.truncated).toBe(false);
    expect(result.outputPath).toBeUndefined();
  });

  test("no outputPath when context is missing", async () => {
    const lineCount = TRUNCATION_MAX_LINES + 100;
    const cmd = `seq 1 ${lineCount}`;

    const result = await executeShellCommand({ command: cmd }) as Exclude<ShellCommandResult, { error: string }>;
    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBeUndefined();
  });
});

describe("resolveShell", () => {
  afterEach(() => {
    resetShellCache();
  });

  test("returns a string", () => {
    const shell = resolveShell();
    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
  });

  test("caches result", () => {
    const first = resolveShell();
    const second = resolveShell();
    expect(first).toBe(second);
  });

  test("respects SHELL env var", () => {
    const original = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/bash";
      resetShellCache();
      expect(resolveShell()).toBe("/bin/bash");
    } finally {
      if (original !== undefined) {
        process.env.SHELL = original;
      } else {
        delete process.env.SHELL;
      }
    }
  });

  test("blacklists fish shell", () => {
    const original = process.env.SHELL;
    try {
      process.env.SHELL = "/usr/bin/fish";
      resetShellCache();
      const shell = resolveShell();
      expect(shell).not.toContain("fish");
    } finally {
      if (original !== undefined) {
        process.env.SHELL = original;
      } else {
        delete process.env.SHELL;
      }
    }
  });

  test("blacklists nu shell", () => {
    const original = process.env.SHELL;
    try {
      process.env.SHELL = "/usr/bin/nu";
      resetShellCache();
      const shell = resolveShell();
      expect(shell).not.toContain("nu");
    } finally {
      if (original !== undefined) {
        process.env.SHELL = original;
      } else {
        delete process.env.SHELL;
      }
    }
  });
});
