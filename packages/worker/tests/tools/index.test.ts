import { describe, test, expect } from "bun:test";
import { getBuiltinTools } from "../../src/tools/index.js";

describe("getBuiltinTools", () => {
  test("returns shell_exec, read_file, write_file, edit_file, glob, grep", () => {
    const tools = getBuiltinTools();
    expect(tools.shell_exec).toBeDefined();
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
    expect(tools.edit_file).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.grep).toBeDefined();
  });

  test("returns exactly 6 tools", () => {
    const tools = getBuiltinTools();
    expect(Object.keys(tools)).toHaveLength(6);
  });
});
