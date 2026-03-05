import { describe, test, expect } from "bun:test";
import { getDefaultSystemPrompt, buildSystemPrompt } from "../src/system-prompts.js";

describe("getDefaultSystemPrompt", () => {
  test("returns non-empty string", () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Molf");
  });

  test("snapshot: default prompt content", () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt).toBe(
      "You are Molf, a helpful and knowledgeable AI assistant. " +
      "You provide clear, accurate, and concise responses. " +
      "When you don't know something, you say so honestly.",
    );
  });

  test("returns same value on repeated calls", () => {
    expect(getDefaultSystemPrompt()).toBe(getDefaultSystemPrompt());
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

  test("joins parts with double newlines", () => {
    const result = buildSystemPrompt("part1", "part2");
    expect(result).toBe("part1\n\npart2");
  });

  test("with only first arg", () => {
    const result = buildSystemPrompt("only base");
    expect(result).toBe("only base");
  });

  test("with only second arg (first undefined)", () => {
    const result = buildSystemPrompt(undefined, "instructions only");
    expect(result).toBe("instructions only");
  });

  test("with only third arg", () => {
    const result = buildSystemPrompt(undefined, null, "skill hint only");
    expect(result).toBe("skill hint only");
  });

  test("all undefined/null returns empty string", () => {
    const result = buildSystemPrompt(undefined, null, undefined);
    expect(result).toBe("");
  });
});
