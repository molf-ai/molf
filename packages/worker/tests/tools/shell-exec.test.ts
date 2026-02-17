import { describe, test, expect, afterEach } from "bun:test";
import { shellExecTool, resolveShell, resetShellCache } from "../../src/tools/shell-exec.js";

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
