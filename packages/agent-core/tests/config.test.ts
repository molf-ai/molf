import { describe, test, expect } from "bun:test";
import { createConfig } from "../src/config.js";

describe("createConfig", () => {
  test("no args returns defaults", () => {
    const config = createConfig();
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.5-flash");
    expect(config.behavior.maxSteps).toBe(10);
    expect(config.behavior.systemPrompt).toBeUndefined();
  });

  test("partial llm overrides", () => {
    const config = createConfig({ llm: { model: "gemini-2.0-flash" } });
    expect(config.llm.model).toBe("gemini-2.0-flash");
    expect(config.llm.provider).toBe("gemini");
  });

  test("partial behavior overrides", () => {
    const config = createConfig({
      behavior: { systemPrompt: "You are a test bot", maxSteps: 5 },
    });
    expect(config.behavior.systemPrompt).toBe("You are a test bot");
    expect(config.behavior.maxSteps).toBe(5);
  });

  test("full overrides", () => {
    const config = createConfig({
      llm: { provider: "gemini", model: "custom-model", temperature: 0.5, maxTokens: 100, apiKey: "key" },
      behavior: { systemPrompt: "custom", maxSteps: 3 },
    });
    expect(config.llm.model).toBe("custom-model");
    expect(config.llm.temperature).toBe(0.5);
    expect(config.llm.maxTokens).toBe(100);
    expect(config.llm.apiKey).toBe("key");
    expect(config.behavior.systemPrompt).toBe("custom");
    expect(config.behavior.maxSteps).toBe(3);
  });

  test("overrides don't mutate default config", () => {
    const config1 = createConfig({ llm: { model: "model-a" } });
    const config2 = createConfig();
    expect(config1.llm.model).toBe("model-a");
    expect(config2.llm.model).toBe("gemini-2.5-flash");
  });
});
