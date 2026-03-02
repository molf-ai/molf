import { describe, test, expect, mock } from "bun:test";
import type { ProviderModel, ProviderInfo } from "../src/providers/types.js";
import type { SDKState } from "../src/providers/sdk.js";

// Mock ALL bundled SDK packages before importing bundled.ts
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

const { getSDK, getLanguageModel } = await import("../src/providers/sdk.js");
const { BUNDLED_PROVIDERS } = await import("../src/providers/bundled.js");

function makeModel(overrides?: Partial<ProviderModel>): ProviderModel {
  return {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    api: {
      id: "claude-sonnet-4-20250514",
      url: "",
      npm: "@ai-sdk/anthropic",
    },
    capabilities: {
      reasoning: false,
      toolcall: true,
      temperature: true,
      input: { text: true, image: true, pdf: true, audio: false, video: false },
      output: { text: true, image: false, pdf: false, audio: false, video: false },
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    headers: {},
    options: {},
    variants: {},
    ...overrides,
  };
}

function makeProvider(overrides?: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    source: "env",
    key: "test-key",
    options: {},
    models: {},
    ...overrides,
  };
}

function makeState(overrides?: Partial<SDKState>): SDKState {
  return {
    providers: { anthropic: makeProvider() },
    sdkCache: new Map(),
    languageCache: new Map(),
    modelLoaders: {},
    ...overrides,
  };
}

describe("BUNDLED_PROVIDERS", () => {
  test("contains expected provider packages", () => {
    expect(BUNDLED_PROVIDERS["@ai-sdk/anthropic"]).toBeDefined();
    expect(BUNDLED_PROVIDERS["@ai-sdk/google"]).toBeDefined();
    expect(BUNDLED_PROVIDERS["@ai-sdk/openai"]).toBeDefined();
    expect(BUNDLED_PROVIDERS["@ai-sdk/openai-compatible"]).toBeDefined();
    expect(BUNDLED_PROVIDERS["@openrouter/ai-sdk-provider"]).toBeDefined();
  });

  test("all entries are functions", () => {
    for (const [, factory] of Object.entries(BUNDLED_PROVIDERS)) {
      expect(typeof factory).toBe("function");
    }
  });
});

describe("getSDK", () => {
  test("returns an SDK instance for a known provider", async () => {
    const state = makeState();
    const model = makeModel();
    const sdk = await getSDK(state, model);
    expect(sdk).toBeDefined();
    expect(typeof sdk.languageModel).toBe("function");
  });

  test("caches SDK instances by provider+npm+baseURL", async () => {
    const state = makeState();
    const model = makeModel();
    const first = await getSDK(state, model);
    const second = await getSDK(state, model);
    expect(second).toBe(first);
  });

  test("different baseURL creates separate SDK instance", async () => {
    const state = makeState();
    const model1 = makeModel();
    const model2 = makeModel({
      api: { id: "claude-sonnet-4-20250514", url: "https://custom.api.com", npm: "@ai-sdk/anthropic" },
    });
    const sdk1 = await getSDK(state, model1);
    const sdk2 = await getSDK(state, model2);
    expect(sdk2).not.toBe(sdk1);
  });

  test("throws for non-bundled npm package", async () => {
    const state = makeState();
    const model = makeModel({
      api: { id: "test", url: "", npm: "@ai-sdk/nonexistent" },
    });
    expect(getSDK(state, model)).rejects.toThrow("No bundled SDK");
  });

  test("injects API key from provider", async () => {
    const state = makeState({
      providers: { anthropic: makeProvider({ key: "my-api-key" }) },
    });
    const model = makeModel();
    const sdk = await getSDK(state, model) as any;
    const lm = sdk.languageModel("test");
    expect(lm.opts.apiKey).toBe("my-api-key");
  });

  test("merges model-level headers", async () => {
    const state = makeState();
    const model = makeModel({
      headers: { "X-Custom": "value" },
    });
    const sdk = await getSDK(state, model) as any;
    const lm = sdk.languageModel("test");
    expect(lm.opts.headers["X-Custom"]).toBe("value");
  });
});

describe("getLanguageModel", () => {
  test("returns a LanguageModel for a known model", async () => {
    const state = makeState();
    const model = makeModel();
    const lm = await getLanguageModel(state, model) as any;
    expect(lm).toBeDefined();
    expect(lm.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("caches language models", async () => {
    const state = makeState();
    const model = makeModel();
    const first = await getLanguageModel(state, model);
    const second = await getLanguageModel(state, model);
    expect(second).toBe(first);
  });

  test("uses custom model loader when provided", async () => {
    const customLoader = mock((sdk: any, modelID: string) => ({
      type: "custom",
      modelId: modelID,
    }));

    const state = makeState({
      modelLoaders: { anthropic: customLoader as any },
    });
    const model = makeModel();
    const lm = await getLanguageModel(state, model) as any;
    expect(customLoader).toHaveBeenCalled();
    expect(lm.type).toBe("custom");
  });
});
