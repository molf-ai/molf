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
