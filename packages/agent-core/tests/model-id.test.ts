import { describe, test, expect } from "bun:test";
import { parseModelId, formatModelId } from "../src/providers/model-id.js";

describe("parseModelId", () => {
  test("splits provider/model correctly", () => {
    const ref = parseModelId("anthropic/claude-sonnet-4-20250514");
    expect(ref.providerID).toBe("anthropic");
    expect(ref.modelID).toBe("claude-sonnet-4-20250514");
  });

  test("handles multiple slashes (keeps rest as modelID)", () => {
    const ref = parseModelId("openrouter/anthropic/claude-3.5-sonnet");
    expect(ref.providerID).toBe("openrouter");
    expect(ref.modelID).toBe("anthropic/claude-3.5-sonnet");
  });

  test("throws on missing slash", () => {
    expect(() => parseModelId("justmodel")).toThrow('Invalid model ID "justmodel"');
  });

  test("throws on empty string", () => {
    expect(() => parseModelId("")).toThrow('Invalid model ID ""');
  });

  test("throws on trailing slash with no model", () => {
    expect(() => parseModelId("anthropic/")).toThrow('Invalid model ID "anthropic/"');
  });

  test("throws on leading slash with no provider", () => {
    expect(() => parseModelId("/claude-sonnet")).toThrow('Invalid model ID "/claude-sonnet"');
  });

  test("handles dashes and underscores in both parts", () => {
    const ref = parseModelId("my-provider/my_model-v2");
    expect(ref.providerID).toBe("my-provider");
    expect(ref.modelID).toBe("my_model-v2");
  });
});

describe("formatModelId", () => {
  test("joins provider and model with slash", () => {
    const id = formatModelId({ providerID: "anthropic", modelID: "claude-sonnet-4-20250514" });
    expect(id).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("round-trip: parse then format", () => {
    const original = "google/gemini-2.5-flash";
    const ref = parseModelId(original);
    expect(formatModelId(ref)).toBe(original);
  });

  test("round-trip with multiple slashes", () => {
    const original = "openrouter/anthropic/claude-3.5-sonnet";
    const ref = parseModelId(original);
    expect(formatModelId(ref)).toBe(original);
  });
});
