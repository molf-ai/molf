import { describe, expect, test } from "bun:test";
import {
  getBuiltinTools,
  shellExecTool,
  readFileTool,
  writeFileTool,
} from "../../src/tools/index.js";

describe("getBuiltinTools", () => {
  test("returns all 3 built-in tools", () => {
    const tools = getBuiltinTools();
    expect(tools).toHaveLength(3);
  });

  test("returns tools with expected names", () => {
    const tools = getBuiltinTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["read_file", "shell_exec", "write_file"]);
  });

  test("all tools have execute functions", () => {
    const tools = getBuiltinTools();
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("all tools have descriptions", () => {
    const tools = getBuiltinTools();
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  test("all tools have input schemas", () => {
    const tools = getBuiltinTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test("individual exports match getBuiltinTools entries", () => {
    const tools = getBuiltinTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName["shell_exec"]).toBe(shellExecTool);
    expect(byName["read_file"]).toBe(readFileTool);
    expect(byName["write_file"]).toBe(writeFileTool);
  });
});

describe("tools register with Agent", () => {
  test("Agent can register all built-in tools", async () => {
    const { Agent } = await import("../../src/agent.js");
    const agent = new Agent();

    for (const tool of getBuiltinTools()) {
      agent.registerTool(tool);
    }

    expect(agent.getStatus()).toBe("idle");
  });
});
