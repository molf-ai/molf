import { describe, test, expect, mock } from "bun:test";
import { makeModel, makeProvider, makeState } from "./_helpers.js";

const { getSDK, getLanguageModel } = await import("../src/providers/sdk.js");
const { BUNDLED_PROVIDERS } = await import("../src/providers/bundled.js");

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
