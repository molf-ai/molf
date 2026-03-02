import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
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

const {
  initProviders,
  getModel,
  listProviders,
  listModels,
  resolveLanguageModel,
} = await import("../src/providers/registry.js");

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

describe("initProviders", () => {
  test("initializes with catalog providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "test-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(state.providers.anthropic).toBeDefined();
    expect(state.providers.anthropic.name).toBe("Anthropic");
  });

  test("includes models from catalog", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const models = listModels(state, "anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("claude-sonnet-4-20250514");
  });
});

describe("getModel", () => {
  test("returns correct model", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const model = getModel(state, "anthropic", "claude-sonnet-4-20250514");
    expect(model.providerID).toBe("anthropic");
    expect(model.limit.context).toBe(200000);
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
  test("returns enabled providers", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const providers = listProviders(state);
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("anthropic");
  });

  test("returns multiple providers when enabled", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const providers = listProviders(state);
    expect(providers.length).toBe(2);
    const ids = providers.map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic", "google"]);
  });
});

describe("listModels", () => {
  test("returns all models without filter", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const models = listModels(state);
    expect(models.length).toBe(2);
  });

  test("filters by provider", async () => {
    Env.set("ANTHROPIC_API_KEY", "a-key");
    Env.set("GEMINI_API_KEY", "g-key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
      enabled_providers: ["google"],
    });

    const anthropicModels = listModels(state, "anthropic");
    expect(anthropicModels.length).toBe(1);
    expect(anthropicModels[0].providerID).toBe("anthropic");
  });
});

describe("resolveLanguageModel", () => {
  test("resolves a language model from provider state", async () => {
    Env.set("ANTHROPIC_API_KEY", "key");

    const state = await initProviders({
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const model = getModel(state, "anthropic", "claude-sonnet-4-20250514");
    const lm = await resolveLanguageModel(state, model);
    expect(lm).toBeDefined();
  });
});
