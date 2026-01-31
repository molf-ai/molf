import { describe, test, expect } from "bun:test";
import { shellExecTool } from "../../src/tools/shell-exec.js";

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
});
