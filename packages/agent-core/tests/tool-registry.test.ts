import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../src/tool-registry.js";
import type { AgentToolDefinition } from "../src/types.js";

function makeTool(name: string): AgentToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    inputSchema: z.object({ input: z.string() }),
    execute: async (args) => `result from ${name}`,
  };
}

describe("ToolRegistry", () => {
  test("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("test_tool");
    registry.register(tool);

    expect(registry.get("test_tool")).toBe(tool);
    expect(registry.has("test_tool")).toBe(true);
    expect(registry.size).toBe(1);
  });

  test("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("dupe"));

    expect(() => registry.register(makeTool("dupe"))).toThrow(
      'Tool "dupe" is already registered',
    );
  });

  test("unregisters a tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("removable"));

    expect(registry.unregister("removable")).toBe(true);
    expect(registry.has("removable")).toBe(false);
    expect(registry.size).toBe(0);
  });

  test("unregister returns false for nonexistent tool", () => {
    const registry = new ToolRegistry();
    expect(registry.unregister("ghost")).toBe(false);
  });

  test("getAll returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("a"));
    registry.register(makeTool("b"));
    registry.register(makeTool("c"));

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b", "c"]);
  });

  test("clear removes all tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("x"));
    registry.register(makeTool("y"));
    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.getAll()).toEqual([]);
  });

  test("get returns undefined for missing tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });
});
