/**
 * Shared test factories for agent-core tests.
 * Import these instead of duplicating factory functions in each test file.
 */
import type { ResolvedModel, ProviderModel, ProviderInfo, ProviderState } from "../src/providers/types.js";

/** Build a mock ResolvedModel for agent tests. */
export function makeResolvedModel(overrides?: Partial<ProviderModel>): ResolvedModel {
  return {
    language: "mock-model" as any,
    info: {
      id: "test-model",
      providerID: "test",
      name: "Test Model",
      api: { id: "test-model", url: "", npm: "@ai-sdk/openai" },
      capabilities: {
        reasoning: false,
        toolcall: true,
        temperature: true,
        input: { text: true, image: false, pdf: false, audio: false, video: false },
        output: { text: true, image: false, pdf: false, audio: false, video: false },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200000, output: 8192 },
      status: "active",
      headers: {},
      options: {},
      ...overrides,
    },
  };
}

/** Build a mock ProviderModel for provider/SDK tests. */
export function makeModel(overrides?: Partial<ProviderModel>): ProviderModel {
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
    ...overrides,
  };
}

/** Build a mock ProviderInfo for provider/SDK tests. */
export function makeProvider(overrides?: Partial<ProviderInfo>): ProviderInfo {
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

/** Build a mock ProviderState for SDK tests. */
export function makeState(overrides?: Partial<ProviderState>): ProviderState {
  return {
    providers: { anthropic: makeProvider() },
    sdkCache: new Map(),
    languageCache: new Map(),
    modelLoaders: {},
    ...overrides,
  };
}

/** Create a mock SDK factory function for provider tests. */
export const makeMockFactory = (name: string) => (opts: any) => ({
  languageModel: (id: string) => ({ type: name, modelId: id, opts }),
});

/** Standard set of mock.module calls for all bundled SDK packages. */
export function mockAllBundledSDKs(mock: { module: (id: string, factory: () => any) => void }) {
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
}
