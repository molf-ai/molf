import { describe, test, expect, vi } from "vitest";
import { makeModel, makeProvider, makeState } from "./_helpers.js";

const { makeMockFactory } = vi.hoisted(() => ({
  makeMockFactory: (name: string) => (opts: any) => ({
    languageModel: (id: string) => ({ type: name, modelId: id, opts }),
  }),
}));

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: makeMockFactory("anthropic") }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: makeMockFactory("google") }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: makeMockFactory("openai") }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: makeMockFactory("openai-compatible") }));
vi.mock("@ai-sdk/xai", () => ({ createXai: makeMockFactory("xai") }));
vi.mock("@ai-sdk/mistral", () => ({ createMistral: makeMockFactory("mistral") }));
vi.mock("@ai-sdk/groq", () => ({ createGroq: makeMockFactory("groq") }));
vi.mock("@ai-sdk/deepinfra", () => ({ createDeepInfra: makeMockFactory("deepinfra") }));
vi.mock("@ai-sdk/cerebras", () => ({ createCerebras: makeMockFactory("cerebras") }));
vi.mock("@ai-sdk/cohere", () => ({ createCohere: makeMockFactory("cohere") }));
vi.mock("@ai-sdk/togetherai", () => ({ createTogetherAI: makeMockFactory("togetherai") }));
vi.mock("@ai-sdk/perplexity", () => ({ createPerplexity: makeMockFactory("perplexity") }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: makeMockFactory("bedrock") }));
vi.mock("@ai-sdk/google-vertex", () => ({ createVertex: makeMockFactory("vertex") }));
vi.mock("@ai-sdk/azure", () => ({ createAzure: makeMockFactory("azure") }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: makeMockFactory("openrouter") }));
vi.mock("@ai-sdk/provider", () => ({}));

import { getSDK, getLanguageModel } from "../src/providers/sdk.js";
import { BUNDLED_PROVIDERS } from "../src/providers/bundled.js";

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
    expect(() => getSDK(state, model)).toThrow("No bundled SDK");
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
    const customLoader = vi.fn((sdk: any, modelID: string) => ({
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
