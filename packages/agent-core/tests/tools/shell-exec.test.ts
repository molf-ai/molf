import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { shellExecTool } from "../../src/tools/shell-exec.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const execute = shellExecTool.execute! as (args: unknown) => Promise<any>;

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "shell-exec-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("shell_exec tool", () => {
  test("has correct description", () => {
    expect(shellExecTool.description).toContain("Execute a shell command");
  });

  test("runs a simple echo command", async () => {
    const result = await execute({ command: "echo hello" });

    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
  });

  test("captures stderr", async () => {
    const result = await execute({ command: "echo error >&2" });

    expect(result.stderr.trim()).toBe("error");
    expect(result.exitCode).toBe(0);
  });

  test("returns non-zero exit code", async () => {
    const result = await execute({ command: "exit 42" });

    expect(result.exitCode).toBe(42);
  });

  test("respects cwd parameter", async () => {
    const result = await execute({ command: "pwd", cwd: tempDir });

    // Resolve potential symlinks (e.g., /tmp -> /private/tmp on macOS)
    const realTempDir = await Bun.file(tempDir)
      .text()
      .catch(() => null);
    expect(result.stdout.trim()).toContain(tempDir.split("/").pop());
    expect(result.exitCode).toBe(0);
  });

  test("handles command with pipe", async () => {
    const result = await execute({
      command: "echo 'foo bar baz' | tr ' ' '\\n' | sort",
    });

    expect(result.stdout.trim()).toBe("bar\nbaz\nfoo");
    expect(result.exitCode).toBe(0);
  });

  test("handles multiline output", async () => {
    const result = await execute({
      command: "printf 'line1\\nline2\\nline3'",
    });

    expect(result.stdout).toBe("line1\nline2\nline3");
  });

  test("times out on long-running command", async () => {
    const result = await execute({
      command: "sleep 10",
      timeout: 500,
    });

    expect(result.error).toContain("timed out");
  }, 5000);

  test("runs command that produces both stdout and stderr", async () => {
    const result = await execute({
      command: "echo out && echo err >&2",
    });

    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(0);
  });
});
