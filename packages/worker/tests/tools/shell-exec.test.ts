import { describe, test, expect, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { shellExecTool, executeShellCommand, resolveShell, resetShellCache } from "../../src/tools/shell-exec.js";
import { TRUNCATION_MAX_LINES } from "@molf-ai/protocol";

describe("shellExecTool", () => {
  test("execute echo hello", async () => {
    const result = await shellExecTool.execute!({ command: "echo hello" } as any, {} as any);
    expect((result as any).stdout.trim()).toBe("hello");
  });

  test("execute failing command", async () => {
    const result = await shellExecTool.execute!({ command: "exit 1" } as any, {} as any);
    expect((result as any).exitCode).toBe(1);
  });

  test("timeout respected", async () => {
    const result = await shellExecTool.execute!(
      { command: "sleep 10", timeout: 100 } as any,
      {} as any,
    );
    expect((result as any).error).toContain("timed out");
  }, 10_000);

  test("process tree killed on timeout", async () => {
    // Spawn a command that creates a child process (subshell with sleep)
    const result = await shellExecTool.execute!(
      { command: "sh -c 'sleep 60' & sleep 60", timeout: 200 } as any,
      {} as any,
    );
    expect((result as any).error).toContain("timed out");
  }, 10_000);
});

describe("executeShellCommand", () => {
  const WORKDIR = resolve(import.meta.dir, "../../.test-workdir-shellexec");

  afterEach(() => {
    rmSync(WORKDIR, { recursive: true, force: true });
  });

  test("basic execution returns structured result", async () => {
    const result = await executeShellCommand({ command: "echo hello" });
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  test("uses line/byte-based truncation", async () => {
    // Generate output exceeding line limit
    const lineCount = TRUNCATION_MAX_LINES + 500;
    const cmd = `seq 1 ${lineCount}`;
    const result = await executeShellCommand({ command: cmd });
    expect(result.stdoutTruncated).toBe(true);
    // Truncated stdout should have fewer lines
    const lines = (result.stdout as string).split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(TRUNCATION_MAX_LINES);
  });

  test("saves full stdout to disk when truncated with context", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const lineCount = TRUNCATION_MAX_LINES + 100;
    const cmd = `seq 1 ${lineCount}`;

    const result = await executeShellCommand(
      { command: cmd },
      { toolCallId: "tc-shell-1", workdir: WORKDIR },
    );

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutOutputPath).toBeDefined();

    const savedPath = result.stdoutOutputPath as string;
    expect(existsSync(savedPath)).toBe(true);
    const savedContent = readFileSync(savedPath, "utf-8");
    const savedLines = savedContent.split("\n").filter(Boolean);
    expect(savedLines.length).toBe(lineCount);
  });

  test("saves full stderr to disk when truncated with context", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const lineCount = TRUNCATION_MAX_LINES + 100;
    const cmd = `seq 1 ${lineCount} >&2`;

    const result = await executeShellCommand(
      { command: cmd },
      { toolCallId: "tc-shell-2", workdir: WORKDIR },
    );

    expect(result.stderrTruncated).toBe(true);
    expect(result.stderrOutputPath).toBeDefined();

    const savedPath = result.stderrOutputPath as string;
    expect(existsSync(savedPath)).toBe(true);
  });

  test("no outputPath when not truncated", async () => {
    mkdirSync(WORKDIR, { recursive: true });
    const result = await executeShellCommand(
      { command: "echo hi" },
      { toolCallId: "tc-shell-3", workdir: WORKDIR },
    );

    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdoutOutputPath).toBeUndefined();
    expect(result.stderrOutputPath).toBeUndefined();
  });

  test("no outputPath when context is missing", async () => {
    const lineCount = TRUNCATION_MAX_LINES + 100;
    const cmd = `seq 1 ${lineCount}`;

    const result = await executeShellCommand({ command: cmd });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutOutputPath).toBeUndefined();
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
