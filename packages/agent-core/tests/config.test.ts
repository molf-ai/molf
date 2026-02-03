import { describe, test, expect } from "bun:test";
import { createConfig } from "../src/config.js";

describe("createConfig", () => {
  test("no args throws (provider and model required)", () => {
    expect(() => createConfig()).toThrow("LLM provider and model are required");
  });

  test("missing provider throws", () => {
    expect(() => createConfig({ llm: { model: "some-model" } })).toThrow(
      "LLM provider and model are required",
    );
  });

  test("missing model throws", () => {
    expect(() => createConfig({ llm: { provider: "gemini" } })).toThrow(
      "LLM provider and model are required",
    );
  });

  test("explicit provider and model succeeds", () => {
    const config = createConfig({ llm: { provider: "gemini", model: "gemini-2.5-flash" } });
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-flash");
    expect(config.behavior.maxSteps).toBe(10);
    expect(config.behavior.systemPrompt).toBeUndefined();
  });

  test("partial behavior overrides", () => {
    const config = createConfig({
      llm: { provider: "gemini", model: "gemini-2.5-flash" },
      behavior: { systemPrompt: "You are a test bot", maxSteps: 5 },
    });
    expect(config.behavior.systemPrompt).toBe("You are a test bot");
    expect(config.behavior.maxSteps).toBe(5);
  });

  test("full overrides", () => {
    const config = createConfig({
      llm: { provider: "anthropic", model: "custom-model", temperature: 0.5, maxTokens: 100, apiKey: "key" },
      behavior: { systemPrompt: "custom", maxSteps: 3 },
    });
    expect(config.llm.provider).toBe("anthropic");
    expect(config.llm.model).toBe("custom-model");
    expect(config.llm.temperature).toBe(0.5);
    expect(config.llm.maxTokens).toBe(100);
    expect(config.llm.apiKey).toBe("key");
    expect(config.behavior.systemPrompt).toBe("custom");
    expect(config.behavior.maxSteps).toBe(3);
  });

  test("configs are independent (no shared state)", () => {
    const config1 = createConfig({ llm: { provider: "gemini", model: "model-a" } });
    const config2 = createConfig({ llm: { provider: "gemini", model: "model-b" } });
    expect(config1.llm.model).toBe("model-a");
    expect(config2.llm.model).toBe("model-b");
  });
});
