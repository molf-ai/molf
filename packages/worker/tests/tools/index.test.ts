import { describe, test, expect } from "bun:test";
import { getBuiltinWorkerTools } from "../../src/tools/index.js";

describe("getBuiltinWorkerTools", () => {
  test("returns shell_exec, read_file, write_file, edit_file, glob, grep", () => {
    const tools = getBuiltinWorkerTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("shell_exec");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
  });

  test("returns exactly 6 tools", () => {
    const tools = getBuiltinWorkerTools();
    expect(tools).toHaveLength(6);
  });
});
