import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// ai — core LLM SDK mock
// ---------------------------------------------------------------------------

let streamTextImpl: (...args: any[]) => any = () => {
  throw new Error("streamTextImpl not set — assign it in beforeEach");
};

let generateTextImpl: (...args: any[]) => any = () =>
  Promise.resolve({ text: "" });

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  generateText: (...args: any[]) => generateTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
  wrapLanguageModel: ({ model }: { model: any }) => model,
}));

export function setStreamTextImpl(impl: (...args: any[]) => any): void {
  streamTextImpl = impl;
}

export function setGenerateTextImpl(impl: (...args: any[]) => any): void {
  generateTextImpl = impl;
}

// ---------------------------------------------------------------------------
// @ai-sdk/* — mock all bundled SDK provider packages.
// Each factory returns a minimal object with `languageModel` that exposes the
// constructor options (opts) for assertion in provider-sdk tests.
// ---------------------------------------------------------------------------

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
mock.module("@ai-sdk/provider", () => ({}));
