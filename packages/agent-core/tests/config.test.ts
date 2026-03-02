import { describe, test, expect } from "bun:test";
import { createConfig } from "../src/config.js";

describe("createConfig", () => {
  test("no args returns default behavior", () => {
    const config = createConfig();
    expect(config.behavior.maxSteps).toBe(10);
    expect(config.behavior.systemPrompt).toBeUndefined();
  });

  test("partial behavior overrides", () => {
    const config = createConfig({
      behavior: { systemPrompt: "You are a test bot", maxSteps: 5 },
    });
    expect(config.behavior.systemPrompt).toBe("You are a test bot");
    expect(config.behavior.maxSteps).toBe(5);
  });

  test("temperature in behavior config", () => {
    const config = createConfig({
      behavior: { temperature: 0.7 },
    });
    expect(config.behavior.temperature).toBe(0.7);
  });

  test("configs are independent (no shared state)", () => {
    const config1 = createConfig({ behavior: { maxSteps: 3 } });
    const config2 = createConfig({ behavior: { maxSteps: 7 } });
    expect(config1.behavior.maxSteps).toBe(3);
    expect(config2.behavior.maxSteps).toBe(7);
  });

  test("contextPruning behavior flag", () => {
    const config = createConfig({
      behavior: { contextPruning: true },
    });
    expect(config.behavior.contextPruning).toBe(true);
  });
});
