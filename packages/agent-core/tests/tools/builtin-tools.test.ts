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
    expect(Object.keys(tools)).toHaveLength(3);
  });

  test("returns tools with expected names", () => {
    const tools = getBuiltinTools();
    const names = Object.keys(tools).sort();
    expect(names).toEqual(["read_file", "shell_exec", "write_file"]);
  });

  test("all tools have execute functions", () => {
    const tools = getBuiltinTools();
    for (const [name, toolDef] of Object.entries(tools)) {
      expect(typeof toolDef.execute).toBe("function");
    }
  });

  test("all tools have descriptions", () => {
    const tools = getBuiltinTools();
    for (const [name, toolDef] of Object.entries(tools)) {
      expect(toolDef.description).toBeTruthy();
      expect(toolDef.description!.length).toBeGreaterThan(10);
    }
  });

  test("all tools have input schemas", () => {
    const tools = getBuiltinTools();
    for (const [name, toolDef] of Object.entries(tools)) {
      expect(toolDef.inputSchema).toBeTruthy();
    }
  });

  test("individual exports match getBuiltinTools entries", () => {
    const tools = getBuiltinTools();

    expect(tools["shell_exec"]).toBe(shellExecTool);
    expect(tools["read_file"]).toBe(readFileTool);
    expect(tools["write_file"]).toBe(writeFileTool);
  });
});

describe("tools register with Agent", () => {
  test("Agent can register all built-in tools", async () => {
    const { Agent } = await import("../../src/agent.js");
    const agent = new Agent();

    agent.registerTools(getBuiltinTools());

    expect(agent.getStatus()).toBe("idle");
  });
});
