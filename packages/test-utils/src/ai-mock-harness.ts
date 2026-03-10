import { vi } from "vitest";

// ---------------------------------------------------------------------------
// ai — core LLM SDK mock
//
// Unlike bun:test's mock.module(), vitest's vi.mock() in setupFiles does NOT
// carry over to test files. Instead, each test file that depends on "ai"
// (directly or transitively) must call vi.mock("ai") itself.
//
// To avoid repeating the factory in every test, test files should do:
//
//   vi.mock("ai", () => aiMockFactory());
//   vi.mock("@ai-sdk/google", () => sdkProviderMockFactory("google", "createGoogleGenerativeAI"));
//
// Or more conveniently, import and call `mockAiModules()` via vi.hoisted:
//
//   const { setStreamTextImpl } = vi.hoisted(() => {
//     const { mockAiModules, setStreamTextImpl } = require("@molf-ai/test-utils/ai-mock-harness");
//     mockAiModules(vi);
//     return { setStreamTextImpl };
//   });
//
// The simplest approach: each test file does:
//   import { setStreamTextImpl, setGenerateTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
//   vi.mock("ai", () => aiMockFactory());
// ---------------------------------------------------------------------------

let streamTextImpl: (...args: any[]) => any = () => {
  throw new Error("streamTextImpl not set — assign it in beforeEach");
};

let generateTextImpl: (...args: any[]) => any = () =>
  Promise.resolve({ text: "" });

export function setStreamTextImpl(impl: (...args: any[]) => any): void {
  streamTextImpl = impl;
}

export function setGenerateTextImpl(impl: (...args: any[]) => any): void {
  generateTextImpl = impl;
}

/**
 * Factory for vi.mock("ai", ...). Returns the mock module shape.
 * Usage: vi.mock("ai", () => aiMockFactory());
 */
export function aiMockFactory() {
  return {
    streamText: (...args: any[]) => streamTextImpl(...args),
    generateText: (...args: any[]) => generateTextImpl(...args),
    tool: (def: any) => def,
    jsonSchema: (s: any) => s,
    wrapLanguageModel: ({ model }: { model: any }) => model,
  };
}

// ---------------------------------------------------------------------------
// @ai-sdk/* — mock all bundled SDK provider packages.
// ---------------------------------------------------------------------------

const makeMockFactory = (name: string) => (opts: any) => ({
  languageModel: (id: string) => ({ type: name, modelId: id, opts }),
});

/**
 * Map of provider package name → mock factory return value.
 * Usage: vi.mock("@ai-sdk/google", () => sdkMocks["@ai-sdk/google"]);
 */
export const sdkMocks: Record<string, Record<string, unknown>> = {
  "@ai-sdk/anthropic": { createAnthropic: makeMockFactory("anthropic") },
  "@ai-sdk/google": { createGoogleGenerativeAI: makeMockFactory("google") },
  "@ai-sdk/openai": { createOpenAI: makeMockFactory("openai") },
  "@ai-sdk/openai-compatible": { createOpenAICompatible: makeMockFactory("openai-compatible") },
  "@ai-sdk/xai": { createXai: makeMockFactory("xai") },
  "@ai-sdk/mistral": { createMistral: makeMockFactory("mistral") },
  "@ai-sdk/groq": { createGroq: makeMockFactory("groq") },
  "@ai-sdk/deepinfra": { createDeepInfra: makeMockFactory("deepinfra") },
  "@ai-sdk/cerebras": { createCerebras: makeMockFactory("cerebras") },
  "@ai-sdk/cohere": { createCohere: makeMockFactory("cohere") },
  "@ai-sdk/togetherai": { createTogetherAI: makeMockFactory("togetherai") },
  "@ai-sdk/perplexity": { createPerplexity: makeMockFactory("perplexity") },
  "@ai-sdk/amazon-bedrock": { createAmazonBedrock: makeMockFactory("bedrock") },
  "@ai-sdk/google-vertex": { createVertex: makeMockFactory("vertex") },
  "@ai-sdk/azure": { createAzure: makeMockFactory("azure") },
  "@openrouter/ai-sdk-provider": { createOpenRouter: makeMockFactory("openrouter") },
  "@ai-sdk/provider": {},
};

/**
 * Register all ai + @ai-sdk/* mocks at once.
 * Call this at the top of each test file that depends on the ai module.
 *
 * Usage:
 *   import { mockAllAi } from "@molf-ai/test-utils/ai-mock-harness";
 *   mockAllAi(vi);
 */
export function mockAllAi(viInstance: typeof vi): void {
  viInstance.mock("ai", () => aiMockFactory());
  for (const [pkg, mock] of Object.entries(sdkMocks)) {
    viInstance.mock(pkg, () => mock);
  }
}
