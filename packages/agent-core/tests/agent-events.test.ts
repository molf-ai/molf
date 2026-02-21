import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";

const { Agent } = await import("../src/agent.js");

describe("Agent events", () => {
  test("onEvent receives all event types", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const types: string[] = [];
    agent.onEvent((e) => types.push(e.type));
    await agent.prompt("Hi");
    expect(types).toContain("status_change");
    expect(types).toContain("content_delta");
    expect(types).toContain("turn_complete");
  });

  test("multiple handlers receive same events", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "X" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const events1: string[] = [];
    const events2: string[] = [];
    agent.onEvent((e) => events1.push(e.type));
    agent.onEvent((e) => events2.push(e.type));
    await agent.prompt("Hi");
    expect(events1.length).toBeGreaterThan(0);
    expect(events1).toEqual(events2);
  });

  test("unsubscribe removes handler", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "A" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const events: string[] = [];
    const unsub = agent.onEvent((e) => events.push(e.type));
    unsub();
    await agent.prompt("Hi");
    expect(events).toHaveLength(0);
  });

  test("throwing handler does not prevent other handlers from receiving events", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const events: string[] = [];
    agent.onEvent(() => {
      throw new Error("handler blew up");
    });
    agent.onEvent((e) => events.push(e.type));
    await agent.prompt("Hi");
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("content_delta");
  });

  test("throwing handler does not crash the agent prompt", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.onEvent(() => {
      throw new Error("boom");
    });
    const msg = await agent.prompt("Hi");
    expect(msg.content).toBe("ok");
  });

  test("error event emitted on in-stream error part", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "error", error: new Error("LLM failed") },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const errors: any[] = [];
    agent.onEvent((e) => {
      if (e.type === "error") errors.push(e);
    });
    // The agent still completes (it adds a "(Reached maximum steps)" message)
    await agent.prompt("Hi");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].error.message).toBe("LLM failed");
  });

  test("error event emitted and status set to error when LLM throws", async () => {
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        throw new Error("Connection refused");
      })(),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    }));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const events: any[] = [];
    agent.onEvent((e) => events.push(e));

    await expect(agent.prompt("Hi")).rejects.toThrow("Connection refused");

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents.some((e) => e.error.message === "Connection refused")).toBe(true);

    const statusEvents = events.filter((e) => e.type === "status_change");
    const lastStatus = statusEvents[statusEvents.length - 1];
    expect(lastStatus.status).toBe("error");
    expect(agent.getStatus()).toBe("error");
  });
});
