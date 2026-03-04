/**
 * Shared ProviderState factory for server tests.
 *
 * Separated from _helpers.ts so that test files that don't need
 * mock.module("ai", ...) (e.g. router.test.ts) can import it
 * without triggering the ai-mock-harness side-effect.
 */

import type { ProviderState } from "@molf-ai/agent-core";

export function makeProviderState(contextWindow = 200_000): ProviderState {
  const testModel = {
    id: "test",
    providerID: "gemini",
    name: "Test Model",
    api: { id: "test", url: "", npm: "@ai-sdk/google" },
    capabilities: {
      reasoning: false,
      toolcall: true,
      temperature: true,
      input: { text: true, image: false, pdf: false, audio: false, video: false },
      output: { text: true, image: false, pdf: false, audio: false, video: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: contextWindow, output: 8192 },
    status: "active" as const,
    headers: {},
    options: {},
  };
  const languageCache = new Map<string, any>();
  languageCache.set("gemini/test", "mock-language-model" as any);
  return {
    providers: {
      gemini: {
        id: "gemini",
        name: "Google Gemini",
        env: ["GEMINI_API_KEY"],
        npm: "@ai-sdk/google",
        source: "env",
        key: "test-key",
        options: {},
        models: { test: testModel },
      },
    },
    sdkCache: new Map(),
    languageCache,
    modelLoaders: {},
  };
}
