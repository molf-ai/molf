import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { Env } from "../src/env.js";
import { resetCatalog } from "../src/providers/catalog.js";

// Mock all bundled SDK packages
const makeMockFactory = (name: string) => (opts: any) => ({
  languageModel: (id: string) => ({ type: name, modelId: id, opts }),
});
mock.module("@ai-sdk/anthropic", () => ({ createAnthropic: makeMockFactory("anthropic") }));
mock.module("@ai-sdk/google", () => ({ createGoogleGenerativeAI: makeMockFactory("google") }));
mock.module("@ai-sdk/openai", () => ({ createOpenAI: makeMockFactory("openai") }));
mock.module("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: makeMockFactory("openai-compatible") }));
mock.module("@ai-sdk/xai", () => ({ createXai: makeMockFactory("xai") }));
mock.module("@ai-sdk/mistral", () => ({ createMistral: makeMockFactory("mistral") }));
mock.module("@ai-sdk/groq", () => ({ createGroq: makeMockFactory("groq") }));
mock.module("@ai-sdk/deepinfra", () => ({ createDeepInfra: makeMockFactory("deepinfra") }));
mock.module("@ai-sdk/cerebras", () => ({ createCerebras: makeMockFactory("cerebras") }));
mock.module("@ai-sdk/cohere", () => ({ createCohere: makeMockFactory("cohere") }));
mock.module("@ai-sdk/togetherai", () => ({ createTogetherAI: makeMockFactory("togetherai") }));
mock.module("@ai-sdk/perplexity", () => ({ createPerplexity: makeMockFactory("perplexity") }));
mock.module("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: makeMockFactory("bedrock") }));
mock.module("@ai-sdk/google-vertex", () => ({ createVertex: makeMockFactory("vertex") }));
mock.module("@ai-sdk/azure", () => ({ createAzure: makeMockFactory("azure") }));
mock.module("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: makeMockFactory("openrouter") }));

const { initProviders, getModel, listProviders, listModels } = await import(
  "../src/providers/registry.js"
);

const FAKE_CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        release_date: "2025-05-14",
        reasoning: false,
        tool_call: true,
        temperature: true,
        attachment: true,
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: ["GEMINI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        release_date: "2025-03-01",
        reasoning: true,
        tool_call: true,
        temperature: true,
        attachment: true,
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 1048576, output: 65536 },
      },
    },
  },
};

const originalFetch = globalThis.fetch;
let env: EnvGuard;

beforeEach(() => {
  env = createEnvGuard();
  resetCatalog();

  // Mock fetch to return our fake catalog
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(FAKE_CATALOG), { status: 200 })),
  ) as any;
});

afterEach(() => {
  env.restore();
  globalThis.fetch = originalFetch;
  Env.reset();
  resetCatalog();
});

describe("initProviders: env detection", () => {
  test("detects provider when API key env var is set", async () => {
    Env.set("ANTHROPIC_API_KEY", "test-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.anthropic.key).toBe("test-key");
    expect(state.providers.anthropic.source).toBe("env");
  });

  test("excludes provider when API key is not set", async () => {
    Env.delete_("ANTHROPIC_API_KEY");
    Env.delete_("GEMINI_API_KEY");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    // Anthropic should be absent (no key and not custom source)
    expect(state.providers.anthropic).toBeUndefined();
  });
});

describe("initProviders: enablement filtering", () => {
  test("default model's provider is always enabled", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    // Anthropic enabled (default model), google NOT (not in enabled_providers)
    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.google).toBeUndefined();
  });

  test("enabled_providers adds extra providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.google).toBeDefined();
  });

  test("enable_all_providers enables everything with a key", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enable_all_providers: true,
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.google).toBeDefined();
  });

  test("config providers are implicitly enabled", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");
    Env.set("MOONSHOT_API_KEY", "moon-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      providers: {
        moonshot: {
          env: ["MOONSHOT_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "kimi-k2.5": {
              name: "Kimi K2.5",
              limit: { context: 256000, output: 8192 },
            },
          },
        },
      },
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.moonshot).toBeDefined();
    expect(state.providers.moonshot.models["kimi-k2.5"]).toBeDefined();
  });
});

describe("getModel", () => {
  test("returns model for valid provider and model ID", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const model = getModel(state, "anthropic", "claude-sonnet-4-20250514");
    expect(model.providerID).toBe("anthropic");
    expect(model.id).toBe("claude-sonnet-4-20250514");
  });

  test("throws for unknown provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(() => getModel(state, "nonexistent", "test")).toThrow(
      'Unknown provider "nonexistent"',
    );
  });

  test("throws for unknown model", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(() => getModel(state, "anthropic", "nonexistent")).toThrow(
      'Unknown model "nonexistent"',
    );
  });
});

describe("listProviders", () => {
  test("returns array of enabled providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const providers = listProviders(state);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.some((p) => p.id === "anthropic")).toBe(true);
  });
});

describe("listModels", () => {
  test("returns all models when no provider filter", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const models = listModels(state);
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  test("filters models by provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const anthropicModels = listModels(state, "anthropic");
    const googleModels = listModels(state, "google");
    expect(anthropicModels.every((m) => m.providerID === "anthropic")).toBe(true);
    expect(googleModels.every((m) => m.providerID === "google")).toBe(true);
  });

  test("returns empty array for unknown provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const models = listModels(state, "nonexistent");
    expect(models).toEqual([]);
  });
});
