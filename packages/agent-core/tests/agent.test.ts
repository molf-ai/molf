import { describe, test, expect, mock, beforeEach } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";

// Re-mock google/anthropic with config-capturing versions (overrides harness defaults)
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


describe("Agent", () => {
  test("simple text response", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello world" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const msg = await agent.prompt("Hi");
    expect(msg.content).toBe("Hello world");
    expect(msg.role).toBe("assistant");
  });

  test("status transitions: idle -> streaming -> idle", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]));
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
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    const deltas: string[] = [];
    agent.onEvent((e) => {
      if (e.type === "content_delta") deltas.push(e.delta);
    });
    await agent.prompt("Hi");
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  test("turn_complete event emitted", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    let turnComplete = false;
    agent.onEvent((e) => {
      if (e.type === "turn_complete") turnComplete = true;
    });
    await agent.prompt("Hi");
    expect(turnComplete).toBe(true);
  });

  test("user message persisted to session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Reply" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("My question");
    const msgs = agent.getSession().getMessages();
    expect(msgs.some((m) => m.role === "user" && m.content === "My question")).toBe(true);
  });

  test("assistant message persisted to session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Answer" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Question");
    const msgs = agent.getSession().getMessages();
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Answer")).toBe(true);
  });

  test("calling prompt while busy throws", async () => {
    let resolveStream: () => void;
    const streamPromise = new Promise<void>((r) => (resolveStream = r));
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        await streamPromise;
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));
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
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Context-aware" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } }, session);
    expect(agent.getSession().length).toBe(1);
    await agent.prompt("Continue");
    expect(agent.getSession().length).toBeGreaterThan(1);
  });

  test("resetSession clears history", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Hello");
    agent.resetSession();
    expect(agent.getSession().length).toBe(0);
    expect(agent.getStatus()).toBe("idle");
  });

  test("getLastPromptMessages returns messages from last turn", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Hi");
    const lastMsgs = agent.getLastPromptMessages();
    expect(lastMsgs.length).toBeGreaterThanOrEqual(1);
    expect(lastMsgs[0].role).toBe("assistant");
  });

  test("unknown provider throws", () => {
    expect(() => new Agent({ llm: { provider: "nonexistent", model: "test" } })).toThrow(
      'Unknown LLM provider "nonexistent"',
    );
  });

  test("config apiKey override used", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));
    lastGoogleConfig = undefined;
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "override-key" } });
    await agent.prompt("Hi");
    expect(lastGoogleConfig.apiKey).toBe("override-key");
  });

  test("provider selection via config", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));

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

    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" };
        await streamWait;
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      })(),
    }));

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
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]));
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
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "I see an image" },
        { type: "finish", finishReason: "stop" },
      ]));
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
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    await agent.prompt("Hello", []);

    const userMsg = agent.getSession().getMessages().find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    // Empty array should not be stored (spreaded only when length > 0)
    expect(userMsg!.attachments).toBeUndefined();
  });

  test("lastAssistantMessage tracks text from steps with tool calls", async () => {
    let callCount = 0;
    setStreamTextImpl(() => {
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
          { type: "text-delta", text: "Let me check" },
          {
            type: "tool-call",
            toolCallId: "tc_1",
            toolName: "echo",
            input: { text: "hi" },
          },
          {
            type: "tool-result",
            toolCallId: "tc_1",
            toolName: "echo",
            output: "hi",
          },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      }
      // Second call: model finishes without producing standalone text
      return mockStreamText([
        {
          type: "tool-call",
          toolCallId: "tc_2",
          toolName: "echo",
          input: { text: "done" },
        },
        {
          type: "tool-result",
          toolCallId: "tc_2",
          toolName: "echo",
          output: "done",
        },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { maxSteps: 5 },
    });
    agent.registerTool("echo", {
      parameters: {},
      execute: async (args: any) => args.text,
    });

    const result = await agent.prompt("Hi");

    // Should use the text from the first step (which had tool calls AND text)
    // instead of the synthetic "(Reached maximum steps)" fallback
    expect(result.content).toBe("Let me check");
    expect(result.content).not.toBe("(Reached maximum steps)");
  });

  test("returns tool-call assistant message when no text is produced", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "echo",
          input: { text: "hi" },
        },
        {
          type: "tool-result",
          toolCallId: "tc_1",
          toolName: "echo",
          output: "hi",
        },
        { type: "finish", finishReason: "stop" },
      ]));

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
    });
    agent.registerTool("echo", { parameters: {}, execute: async () => "hi" });

    const result = await agent.prompt("Hi");
    // Should return the assistant message (with tool calls, empty text), not the fallback
    expect(result.content).toBe("");
    expect(result.toolCalls).toBeTruthy();
    expect(result.content).not.toBe("(Reached maximum steps)");
    expect(result.content).not.toBe("(No text response)");
  });

  test("fallback message distinguishes max steps from natural completion", async () => {
    // LLM produces no text and no tool calls — empty step
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "finish", finishReason: "stop" },
      ]));

    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
    });

    const result = await agent.prompt("Hi");
    // No tool calls, no text, natural completion → "(No text response)"
    expect(result.content).toBe("(No text response)");
  });

  test("replaceTools clears existing and registers new tools", () => {
    const agent = new Agent({ llm: { provider: "gemini", model: "test", apiKey: "test-key" } });
    agent.registerTool("old_tool", { parameters: {}, execute: async () => "old" });

    agent.replaceTools({
      new_tool: { parameters: {}, execute: async () => "new" } as any,
    });

    // Old tool should be gone, new tool should exist
    const session = agent.getSession();
    // Use the agent's internal state: prompt to verify tools were replaced
    expect(agent["toolRegistry"].has("old_tool")).toBe(false);
    expect(agent["toolRegistry"].has("new_tool")).toBe(true);
    expect(agent["toolRegistry"].size).toBe(1);
  });

  test("setSystemPrompt updates the system prompt", () => {
    const agent = new Agent({
      llm: { provider: "gemini", model: "test", apiKey: "test-key" },
      behavior: { systemPrompt: "Original prompt" },
    });

    agent.setSystemPrompt("Updated prompt");

    expect(agent["config"].behavior.systemPrompt).toBe("Updated prompt");
  });
});
