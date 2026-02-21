/**
 * Shared LLM stream mocking for bun:test.
 */

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; error: unknown }
  | { type: "finish"; finishReason: string }
  | { type: "error"; error: unknown };

export function mockStreamText(
  events: StreamEvent[],
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
    usage: Promise.resolve(usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  };
}

export function mockTextResponse(
  text: string,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  return mockStreamText(
    [
      { type: "text-delta", text },
      { type: "finish", finishReason: "stop" },
    ],
    usage,
  );
}

export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  let callCount = 0;
  return () => {
    callCount++;
    if (callCount === 1) {
      return mockStreamText(
        [
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
        ],
        usage,
      );
    }
    return mockStreamText(
      [
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ],
      usage,
    );
  };
}
