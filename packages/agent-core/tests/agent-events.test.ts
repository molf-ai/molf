import { describe, test, expect, mock, beforeEach } from "bun:test";

let streamTextImpl: (...args: any[]) => any;

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

const { Agent } = await import("../src/agent.js");
const { ProviderRegistry } = await import("../src/providers/index.js");

function makeStream(events: any[]) {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

function createMockRegistry() {
  const registry = new ProviderRegistry();
  registry.register("gemini", {
    name: "gemini",
    envKey: "GEMINI_API_KEY",
    createModel: () => "mock-model",
  });
  return registry;
}

let mockRegistry: InstanceType<typeof ProviderRegistry>;
beforeEach(() => {
  mockRegistry = createMockRegistry();
});

describe("Agent events", () => {
  test("onEvent receives all event types", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hello" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test" } }, undefined, mockRegistry);
    const types: string[] = [];
    agent.onEvent((e) => types.push(e.type));
    await agent.prompt("Hi");
    expect(types).toContain("status_change");
    expect(types).toContain("content_delta");
    expect(types).toContain("turn_complete");
  });

  test("multiple handlers receive same events", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "X" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test" } }, undefined, mockRegistry);
    const events1: string[] = [];
    const events2: string[] = [];
    agent.onEvent((e) => events1.push(e.type));
    agent.onEvent((e) => events2.push(e.type));
    await agent.prompt("Hi");
    expect(events1.length).toBeGreaterThan(0);
    expect(events1).toEqual(events2);
  });

  test("unsubscribe removes handler", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "A" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test" } }, undefined, mockRegistry);
    const events: string[] = [];
    const unsub = agent.onEvent((e) => events.push(e.type));
    unsub();
    await agent.prompt("Hi");
    expect(events).toHaveLength(0);
  });

  test("error event emitted on LLM error", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "error", error: new Error("LLM failed") },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test" } }, undefined, mockRegistry);
    const errors: any[] = [];
    agent.onEvent((e) => {
      if (e.type === "error") errors.push(e);
    });
    // The agent still completes (it adds a "(Reached maximum steps)" message)
    await agent.prompt("Hi");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].error.message).toBe("LLM failed");
  });
});
