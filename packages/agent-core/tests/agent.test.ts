import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock ai before importing Agent
let streamTextImpl: (...args: any[]) => any;

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

let lastGoogleConfig: any;
let lastAnthropicConfig: any;

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (config: any) => {
    lastGoogleConfig = config;
    return () => "mock-model";
  },
}));

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: (config: any) => {
    lastAnthropicConfig = config;
    return () => "mock-model";
  },
}));

// Import after mocking
const { Agent } = await import("../src/agent.js");
const { Session } = await import("../src/session.js");

function makeStream(events: any[]) {
  return {
    fullStream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

describe("Agent", () => {
  test("simple text response", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hello world" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const msg = await agent.prompt("Hi");
    expect(msg.content).toBe("Hello world");
    expect(msg.role).toBe("assistant");
  });

  test("status transitions: idle -> streaming -> idle", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const statuses: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "status_change") statuses.push(e.status);
    });
    await agent.prompt("Hello");
    expect(statuses[0]).toBe("streaming");
    expect(statuses[statuses.length - 1]).toBe("idle");
  });

  test("content_delta events emitted during streaming", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const deltas: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "content_delta") deltas.push(e.delta);
    });
    await agent.prompt("Hi");
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  test("turn_complete event emitted", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    let turnComplete = false;
    agent.onEvent((e) => {
      if (e.type === "turn_complete") turnComplete = true;
    });
    await agent.prompt("Hi");
    expect(turnComplete).toBe(true);
  });

  test("user message persisted to session", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Reply" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("My question");
    const msgs = agent.getSession().getMessages();
    expect(msgs.some((m) => m.role === "user" && m.content === "My question")).toBe(true);
  });

  test("assistant message persisted to session", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Answer" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Question");
    const msgs = agent.getSession().getMessages();
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Answer")).toBe(true);
  });

  test("calling prompt while busy throws", async () => {
    let resolveStream: () => void;
    const streamPromise = new Promise<void>((r) => (resolveStream = r));
    streamTextImpl = () => ({
      fullStream: (async function* () {
        await streamPromise;
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", finishReason: "stop" };
      })(),
    });
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const p1 = agent.prompt("First");
    await Bun.sleep(10);
    expect(() => agent.prompt("Second")).toThrow("Agent is busy");
    resolveStream!();
    await p1;
  });

  test("constructor with existing session", async () => {
    const session = new Session();
    session.addMessage({ role: "user", content: "Previous" });
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Context-aware" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } }, session);
    expect(agent.getSession().length).toBe(1);
    await agent.prompt("Continue");
    expect(agent.getSession().length).toBeGreaterThan(1);
  });

  test("resetSession clears history", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Hello");
    agent.resetSession();
    expect(agent.getSession().length).toBe(0);
    expect(agent.getStatus()).toBe("idle");
  });

  test("getLastPromptMessages returns messages from last turn", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Hi");
    const lastMsgs = agent.getLastPromptMessages();
    expect(lastMsgs.length).toBeGreaterThanOrEqual(1);
    expect(lastMsgs[0].role).toBe("assistant");
  });

  test("unknown provider throws", () => {
    const agent = new Agent({ llm: { provider: "nonexistent", model: "test" } });
    expect(agent.prompt("Hi")).rejects.toThrow('Unknown LLM provider "nonexistent"');
  });

  test("config apiKey override used", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    lastGoogleConfig = undefined;
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "override-key" } });
    await agent.prompt("Hi");
    expect(lastGoogleConfig.apiKey).toBe("override-key");
  });

  test("provider selection via config", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);

    lastAnthropicConfig = undefined;
    const agent = new Agent(
      { llm: { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "test-key" } },
    );
    await agent.prompt("Hi");
    expect(lastAnthropicConfig).toBeTruthy();
    expect(lastAnthropicConfig.apiKey).toBe("test-key");
  });

  test("unregisterTool removes registered tool", () => {
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.registerTool("dummy", {
      description: "dummy tool",
      execute: async () => "ok",
    } as any);
    expect(agent.unregisterTool("dummy")).toBe(true);
    expect(agent.unregisterTool("dummy")).toBe(false);
  });

  test("abort during streaming sets aborted status", async () => {
    let resolveStream!: () => void;
    const streamWait = new Promise<void>((r) => (resolveStream = r));

    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    });

    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const promptPromise = agent.prompt("abort test");
    await Bun.sleep(20);

    agent.abort();
    expect(agent.getStatus()).toBe("aborted");

    // Resolve so the generator finishes
    resolveStream();
    try {
      await promptPromise;
    } catch (err: any) {
      expect(err.name).toBe("AbortError");
    }
  });

  // --- Multimodal prompt tests (Phase 2) ---

  test("prompt(text) without attachments works (backward compat)", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const msg = await agent.prompt("Hello");
    expect(msg.content).toBe("Response");
    expect(msg.role).toBe("assistant");

    // User message should not have attachments
    const userMsg = agent.getSession().getMessages().find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toBe("Hello");
    expect(userMsg!.attachments).toBeUndefined();
  });

  test("prompt(text, attachments) stores attachments on user message", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "I see an image" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const msg = await agent.prompt("Describe this", [
      { data: imageData, mimeType: "image/png", filename: "test.png" },
    ]);
    expect(msg.content).toBe("I see an image");

    // User message should have attachments
    const userMsg = agent.getSession().getMessages().find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.attachments).toHaveLength(1);
    expect(userMsg!.attachments![0].mimeType).toBe("image/png");
    expect(userMsg!.attachments![0].data).toEqual(imageData);
  });

  test("prompt(text, []) with empty attachments array does not store attachments", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Hello", []);

    const userMsg = agent.getSession().getMessages().find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    // Empty array should not be stored (spreaded only when length > 0)
    expect(userMsg!.attachments).toBeUndefined();
  });
});
