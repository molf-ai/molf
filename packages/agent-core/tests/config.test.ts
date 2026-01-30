import { describe, expect, test } from "bun:test";
import { createConfig } from "../src/config.js";

describe("createConfig", () => {
  test("returns default config when no overrides", () => {
    const config = createConfig();
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-flash");
    expect(config.behavior.maxIterations).toBe(10);
  });

  test("merges LLM overrides", () => {
    const config = createConfig({
      llm: { model: "gemini-2.5-pro", temperature: 0.7 },
    });
    expect(config.llm.model).toBe("gemini-2.5-pro");
    expect(config.llm.temperature).toBe(0.7);
    expect(config.llm.provider).toBe("gemini");
  });

  test("merges behavior overrides", () => {
    const config = createConfig({
      behavior: { maxIterations: 5, systemPrompt: "Custom prompt" },
    });
    expect(config.behavior.maxIterations).toBe(5);
    expect(config.behavior.systemPrompt).toBe("Custom prompt");
  });

  test("merges both LLM and behavior overrides", () => {
    const config = createConfig({
      llm: { model: "gemini-2.5-pro" },
      behavior: { maxIterations: 3 },
    });
    expect(config.llm.model).toBe("gemini-2.5-pro");
    expect(config.behavior.maxIterations).toBe(3);
  });
});
