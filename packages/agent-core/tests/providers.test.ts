import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";

// Mock the SDK packages so tests don't require real API calls
mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (opts: any) => (model: string) => ({
    type: "mock-gemini",
    model,
    apiKey: opts.apiKey,
  }),
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: (opts: any) => (model: string) => ({
    type: "mock-anthropic",
    model,
    apiKey: opts.apiKey,
  }),
}));

const { ProviderRegistry } = await import("../src/providers/registry.js");
const { GeminiProvider } = await import("../src/providers/gemini.js");
const { AnthropicProvider } = await import("../src/providers/anthropic.js");
const { createDefaultRegistry } = await import("../src/providers/index.js");

let env: EnvGuard;
beforeEach(() => {
  env = createEnvGuard();
});
afterEach(() => {
  env.restore();
});

describe("ProviderRegistry", () => {
  test("register and get a provider", () => {
    const registry = new ProviderRegistry();
    const provider = { name: "test", envKey: "TEST_KEY", createModel: () => "model" };
    registry.register("test", provider);
    expect(registry.get("test")).toBe(provider);
  });

  test("get unknown provider throws", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get("nonexistent")).toThrow('Unknown LLM provider "nonexistent"');
  });

  test("has returns true for registered provider", () => {
    const registry = new ProviderRegistry();
    registry.register("test", { name: "test", envKey: "K", createModel: () => "m" });
    expect(registry.has("test")).toBe(true);
    expect(registry.has("other")).toBe(false);
  });

  test("list returns registered names", () => {
    const registry = new ProviderRegistry();
    registry.register("a", { name: "a", envKey: "A", createModel: () => "m" });
    registry.register("b", { name: "b", envKey: "B", createModel: () => "m" });
    expect(registry.list()).toEqual(["a", "b"]);
  });

  test("register overwrites existing provider", () => {
    const registry = new ProviderRegistry();
    const first = { name: "test", envKey: "K", createModel: () => "first" };
    const second = { name: "test", envKey: "K", createModel: () => "second" };
    registry.register("test", first);
    registry.register("test", second);
    expect(registry.get("test")).toBe(second);
  });
});

describe("GeminiProvider", () => {
  test("creates model with config apiKey", () => {
    const provider = new GeminiProvider();
    const model = provider.createModel({ model: "gemini-2.5-flash", apiKey: "test-key" }) as any;
    expect(model.type).toBe("mock-gemini");
    expect(model.model).toBe("gemini-2.5-flash");
    expect(model.apiKey).toBe("test-key");
  });

  test("falls back to GEMINI_API_KEY env var", () => {
    env.set("GEMINI_API_KEY", "env-key");
    const provider = new GeminiProvider();
    const model = provider.createModel({ model: "gemini-2.5-flash" }) as any;
    expect(model.apiKey).toBe("env-key");
  });

  test("throws when no API key is available", () => {
    env.delete("GEMINI_API_KEY");
    const provider = new GeminiProvider();
    expect(() => provider.createModel({ model: "gemini-2.5-flash" })).toThrow(
      "GEMINI_API_KEY is required",
    );
  });

  test("has correct name and envKey", () => {
    const provider = new GeminiProvider();
    expect(provider.name).toBe("gemini");
    expect(provider.envKey).toBe("GEMINI_API_KEY");
  });
});

describe("AnthropicProvider", () => {
  test("creates model with config apiKey", () => {
    const provider = new AnthropicProvider();
    const model = provider.createModel({
      model: "claude-sonnet-4-20250514",
      apiKey: "test-key",
    }) as any;
    expect(model.type).toBe("mock-anthropic");
    expect(model.model).toBe("claude-sonnet-4-20250514");
    expect(model.apiKey).toBe("test-key");
  });

  test("falls back to ANTHROPIC_API_KEY env var", () => {
    env.set("ANTHROPIC_API_KEY", "env-key");
    const provider = new AnthropicProvider();
    const model = provider.createModel({ model: "claude-sonnet-4-20250514" }) as any;
    expect(model.apiKey).toBe("env-key");
  });

  test("throws when no API key is available", () => {
    env.delete("ANTHROPIC_API_KEY");
    const provider = new AnthropicProvider();
    expect(() =>
      provider.createModel({ model: "claude-sonnet-4-20250514" }),
    ).toThrow("ANTHROPIC_API_KEY is required");
  });

  test("has correct name and envKey", () => {
    const provider = new AnthropicProvider();
    expect(provider.name).toBe("anthropic");
    expect(provider.envKey).toBe("ANTHROPIC_API_KEY");
  });
});

describe("createDefaultRegistry", () => {
  test("includes gemini and anthropic providers", () => {
    const registry = createDefaultRegistry();
    expect(registry.has("gemini")).toBe(true);
    expect(registry.has("anthropic")).toBe(true);
  });

  test("gemini provider creates models", () => {
    env.set("GEMINI_API_KEY", "test");
    const registry = createDefaultRegistry();
    const provider = registry.get("gemini");
    const model = provider.createModel({ model: "gemini-2.5-flash" });
    expect(model).toBeDefined();
  });

  test("anthropic provider creates models", () => {
    env.set("ANTHROPIC_API_KEY", "test");
    const registry = createDefaultRegistry();
    const provider = registry.get("anthropic");
    const model = provider.createModel({ model: "claude-sonnet-4-20250514" });
    expect(model).toBeDefined();
  });
});
