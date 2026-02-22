import { describe, test, expect, afterEach } from "bun:test";
import { type LogRecord, configure, reset } from "@logtape/logtape";
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
  const buffer: LogRecord[] = [];

  afterEach(async () => {
    buffer.length = 0;
    await reset();
  });

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

  test("warns at threshold (30+ total)", async () => {
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    const tools = [createTool("a")];
    enforceToolLimit(30, tools);
    const warnRecord = buffer.find((r) => r.level === "warning" && r.message.some((m) => typeof m === "string" && m.includes("High tool count")));
    expect(warnRecord).toBeTruthy();
    expect(warnRecord!.properties.total).toBe(31);
  });

  test("no warning when under threshold", async () => {
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    const tools = [createTool("a")];
    enforceToolLimit(10, tools);
    const warnRecords = buffer.filter((r) => r.level === "warning");
    expect(warnRecords).toHaveLength(0);
  });
});
