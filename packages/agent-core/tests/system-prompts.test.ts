import { describe, test, expect } from "bun:test";
import { getDefaultSystemPrompt, buildSystemPrompt } from "../src/system-prompts.js";

describe("getDefaultSystemPrompt", () => {
  test("returns non-empty string", () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Molf");
  });
});

describe("buildSystemPrompt", () => {
  test("with all args", () => {
    const result = buildSystemPrompt("base prompt", "instructions", "skill hint");
    expect(result).toContain("base prompt");
    expect(result).toContain("instructions");
    expect(result).toContain("skill hint");
  });

  test("with no optional args", () => {
    const result = buildSystemPrompt("base prompt", undefined, null);
    expect(result).toBe("base prompt");
  });
});
