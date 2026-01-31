import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { tool } from "ai";
import { ToolRegistry } from "../src/tool-registry.js";

function makeToolDef(name: string) {
  return tool({
    description: `Tool: ${name}`,
    inputSchema: z.object({ input: z.string() }),
    execute: async (args) => `result from ${name}`,
  });
}

describe("ToolRegistry", () => {
  test("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const toolDef = makeToolDef("test_tool");
    registry.register("test_tool", toolDef);

    expect(registry.get("test_tool")).toBe(toolDef);
    expect(registry.has("test_tool")).toBe(true);
    expect(registry.size).toBe(1);
  });

  test("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register("dupe", makeToolDef("dupe"));

    expect(() => registry.register("dupe", makeToolDef("dupe"))).toThrow(
      'Tool "dupe" is already registered',
    );
  });

  test("unregisters a tool", () => {
    const registry = new ToolRegistry();
    registry.register("removable", makeToolDef("removable"));

    expect(registry.unregister("removable")).toBe(true);
    expect(registry.has("removable")).toBe(false);
    expect(registry.size).toBe(0);
  });

  test("unregister returns false for nonexistent tool", () => {
    const registry = new ToolRegistry();
    expect(registry.unregister("ghost")).toBe(false);
  });

  test("getAll returns all registered tools as a ToolSet", () => {
    const registry = new ToolRegistry();
    registry.register("a", makeToolDef("a"));
    registry.register("b", makeToolDef("b"));
    registry.register("c", makeToolDef("c"));

    const all = registry.getAll();
    expect(Object.keys(all).sort()).toEqual(["a", "b", "c"]);
  });

  test("clear removes all tools", () => {
    const registry = new ToolRegistry();
    registry.register("x", makeToolDef("x"));
    registry.register("y", makeToolDef("y"));
    registry.clear();

    expect(registry.size).toBe(0);
    expect(Object.keys(registry.getAll())).toEqual([]);
  });

  test("get returns undefined for missing tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });
});
