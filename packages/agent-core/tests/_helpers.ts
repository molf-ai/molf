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

