import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";

// Mock ai and @ai-sdk/google before importing Agent
let streamTextImpl: (...args: any[]) => any;

mock.module("ai", () => ({
  streamText: (...args: any[]) => streamTextImpl(...args),
  tool: (def: any) => def,
  jsonSchema: (s: any) => s,
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => "mock-model",
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

let env: EnvGuard;
beforeEach(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");
});
afterEach(() => {
  env.restore();
});

describe("Agent", () => {
  test("simple text response", async () => {
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "Hello world" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent();
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
    const agent = new Agent();
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
    const agent = new Agent();
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
    const agent = new Agent();
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
    const agent = new Agent();
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
    const agent = new Agent();
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
    const agent = new Agent();
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
    const agent = new Agent({}, session);
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
    const agent = new Agent();
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
    const agent = new Agent();
    await agent.prompt("Hi");
    const lastMsgs = agent.getLastPromptMessages();
    expect(lastMsgs.length).toBeGreaterThanOrEqual(1);
    expect(lastMsgs[0].role).toBe("assistant");
  });

  test("missing API key throws", () => {
    env.delete("GEMINI_API_KEY");
    const agent = new Agent();
    expect(agent.prompt("Hi")).rejects.toThrow("GEMINI_API_KEY is required");
  });

  test("config apiKey override used", async () => {
    env.delete("GEMINI_API_KEY");
    streamTextImpl = () =>
      makeStream([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]);
    const agent = new Agent({ llm: { apiKey: "override-key" } });
    const msg = await agent.prompt("Hi");
    expect(msg.content).toBe("ok");
  });

  test("unregisterTool removes registered tool", () => {
    const agent = new Agent();
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

    const agent = new Agent();
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
});
