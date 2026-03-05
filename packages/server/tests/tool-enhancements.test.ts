import { describe, test, expect } from "bun:test";
import { toolEnhancements, type EnhancementContext } from "../src/tool-enhancements.js";

function makeCtx(overrides?: Partial<EnhancementContext>): EnhancementContext {
  return {
    toolCallId: "tc1",
    toolName: "read_file",
    sessionId: "s1",
    loadedInstructions: new Set(),
    ...overrides,
  };
}

describe("toolEnhancements registry", () => {
  test("has read_file enhancement", () => {
    expect(toolEnhancements.has("read_file")).toBe(true);
  });

  test("non-existent tool returns undefined", () => {
    expect(toolEnhancements.get("nonexistent")).toBeUndefined();
  });
});

describe("read_file afterExecute", () => {
  const enhancement = toolEnhancements.get("read_file")!;

  test("returns output unchanged when no metadata", () => {
    const result = enhancement.afterExecute!("file content", undefined, makeCtx());
    expect(result).toBe("file content");
  });

  test("returns output unchanged when metadata has no instructionFiles", () => {
    const result = enhancement.afterExecute!("file content", {}, makeCtx());
    expect(result).toBe("file content");
  });

  test("returns output unchanged when instructionFiles is empty", () => {
    const result = enhancement.afterExecute!("file content", { instructionFiles: [] }, makeCtx());
    expect(result).toBe("file content");
  });

  test("appends instruction file as system-reminder block", () => {
    const meta = {
      instructionFiles: [{ path: "/proj/AGENTS.md", content: "Agent rules here" }],
    };
    const ctx = makeCtx();
    const result = enhancement.afterExecute!("file content", meta, ctx);

    expect(result).toContain("file content");
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("/proj/AGENTS.md");
    expect(result).toContain("Agent rules here");
  });

  test("adds instruction path to loadedInstructions set", () => {
    const meta = {
      instructionFiles: [{ path: "/proj/AGENTS.md", content: "rules" }],
    };
    const ctx = makeCtx();
    enhancement.afterExecute!("out", meta, ctx);

    expect(ctx.loadedInstructions.has("/proj/AGENTS.md")).toBe(true);
  });

  test("deduplicates already-loaded instructions", () => {
    const meta = {
      instructionFiles: [{ path: "/proj/AGENTS.md", content: "rules" }],
    };
    const ctx = makeCtx({ loadedInstructions: new Set(["/proj/AGENTS.md"]) });
    const result = enhancement.afterExecute!("out", meta, ctx);

    expect(result).toBe("out");
  });

  test("handles mix of new and already-loaded instructions", () => {
    const meta = {
      instructionFiles: [
        { path: "/a.md", content: "A" },
        { path: "/b.md", content: "B" },
      ],
    };
    const ctx = makeCtx({ loadedInstructions: new Set(["/a.md"]) });
    const result = enhancement.afterExecute!("out", meta, ctx);

    expect(result).toContain("/b.md");
    expect(result).not.toContain("Nested instructions discovered from /a.md");
    expect(ctx.loadedInstructions.has("/b.md")).toBe(true);
  });

  test("multiple new instruction files each get their own block", () => {
    const meta = {
      instructionFiles: [
        { path: "/x.md", content: "X content" },
        { path: "/y.md", content: "Y content" },
      ],
    };
    const ctx = makeCtx();
    const result = enhancement.afterExecute!("base", meta, ctx);

    const matches = result.match(/<system-reminder>/g);
    expect(matches).toHaveLength(2);
    expect(result).toContain("X content");
    expect(result).toContain("Y content");
  });
});
