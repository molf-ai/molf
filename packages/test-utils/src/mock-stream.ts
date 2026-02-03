/**
 * Shared LLM stream mocking for bun:test.
 *
 * Usage:
 *   mock.module("ai", () => mockAiModule(events));
 *   mock.module("@ai-sdk/google", () => mockGoogleModule());
 */

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; error: unknown }
  | { type: "finish"; finishReason: string }
  | { type: "error"; error: unknown };

export function mockStreamText(events: StreamEvent[]) {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

export function mockTextResponse(text: string) {
  return mockStreamText([
    { type: "text-delta", text },
    { type: "finish", finishReason: "stop" },
  ]);
}

export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
) {
  let callCount = 0;
  return () => {
    callCount++;
    if (callCount === 1) {
      return mockStreamText([
        {
          type: "tool-call",
          toolCallId: `tc_${callCount}`,
          toolName,
          input: args,
        },
        {
          type: "tool-result",
          toolCallId: `tc_${callCount}`,
          toolName,
          output: result,
        },
        { type: "finish", finishReason: "tool-calls" },
      ]);
    }
    return mockStreamText([
      { type: "text-delta", text: "Done" },
      { type: "finish", finishReason: "stop" },
    ]);
  };
}

/** Build a mock "ai" module with configurable streamText behavior */
export function mockAiModule(
  streamTextImpl: (opts: unknown) => unknown,
) {
  return {
    streamText: streamTextImpl,
    tool: (def: unknown) => def,
    jsonSchema: (s: unknown) => s,
  };
}

/** Build a mock "@ai-sdk/google" module */
export function mockGoogleModule() {
  return {
    createGoogleGenerativeAI: () => () => "mock-model",
  };
}

/** Build a mock "@ai-sdk/anthropic" module */
export function mockAnthropicModule() {
  return {
    createAnthropic: () => () => "mock-anthropic-model",
  };
}

/**
 * Build a mock provider registry module.
 * Mocks `@molf-ai/agent-core`'s `providers/index.js` so that
 * `createDefaultRegistry()` returns a registry whose providers
 * always return "mock-model" without needing a real API key.
 */
export function mockProviderRegistryModule() {
  class MockProvider {
    name: string;
    envKey: string;
    constructor(name: string, envKey: string) {
      this.name = name;
      this.envKey = envKey;
    }
    createModel() {
      return "mock-model";
    }
  }

  class MockProviderRegistry {
    private providers = new Map<string, MockProvider>();
    register(name: string, provider: MockProvider) {
      this.providers.set(name, provider);
    }
    get(name: string) {
      const p = this.providers.get(name);
      if (!p) {
        throw new Error(`Unknown LLM provider "${name}"`);
      }
      return p;
    }
    has(name: string) {
      return this.providers.has(name);
    }
    list() {
      return [...this.providers.keys()];
    }
  }

  function createDefaultRegistry() {
    const registry = new MockProviderRegistry();
    registry.register("gemini", new MockProvider("gemini", "GEMINI_API_KEY"));
    registry.register("anthropic", new MockProvider("anthropic", "ANTHROPIC_API_KEY"));
    return registry;
  }

  return {
    ProviderRegistry: MockProviderRegistry,
    GeminiProvider: MockProvider,
    AnthropicProvider: MockProvider,
    createDefaultRegistry,
  };
}
