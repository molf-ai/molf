import { describe, test, expect, spyOn } from "bun:test";
import { enforceToolLimit } from "../../src/mcp/index.js";

function createTool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const },
    execute: async () => ({}),
  };
}

describe("enforceToolLimit", () => {
  test("returns all tools when under hard cap", () => {
    const tools = [createTool("a"), createTool("b")];
    const result = enforceToolLimit(5, tools);
    expect(result).toHaveLength(2);
  });

  test("drops excess tools when total exceeds hard cap (50)", () => {
    const tools = Array.from({ length: 10 }, (_, i) => createTool(`t${i}`));
    const result = enforceToolLimit(45, tools);
    // 45 + 10 = 55 > 50, so only 5 allowed
    expect(result).toHaveLength(5);
    expect(result.map((t) => t.name)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  test("returns empty when current count already at cap", () => {
    const tools = [createTool("a")];
    const result = enforceToolLimit(50, tools);
    expect(result).toHaveLength(0);
  });

  test("warns at threshold (30+ total)", () => {
    const warnSpy = spyOn(console, "warn");
    const tools = [createTool("a")];
    enforceToolLimit(30, tools);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("31 tools"));
    warnSpy.mockRestore();
  });

  test("no warning when under threshold", () => {
    const warnSpy = spyOn(console, "warn");
    const tools = [createTool("a")];
    enforceToolLimit(10, tools);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
