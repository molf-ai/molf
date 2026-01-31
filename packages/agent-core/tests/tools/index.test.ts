import { describe, test, expect } from "bun:test";
import { getBuiltinTools } from "../../src/tools/index.js";

describe("getBuiltinTools", () => {
  test("returns shell_exec, read_file, write_file", () => {
    const tools = getBuiltinTools();
    expect(tools.shell_exec).toBeDefined();
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
  });

  test("returns exactly 3 tools", () => {
    const tools = getBuiltinTools();
    expect(Object.keys(tools)).toHaveLength(3);
  });
});
