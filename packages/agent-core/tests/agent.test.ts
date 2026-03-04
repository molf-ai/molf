import { describe, test, expect, mock, beforeEach } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockStreamText } from "@molf-ai/test-utils";
import type { ResolvedModel, ProviderModel } from "../src/providers/types.js";

// Import after mocking (harness mocks "ai" module)
const { Agent } = await import("../src/agent.js");
const { Session } = await import("../src/session.js");

/** Build a mock ResolvedModel for tests. */
function makeResolvedModel(overrides?: Partial<ProviderModel>): ResolvedModel {
  return {
    language: "mock-model" as any,
    info: {
      id: "test-model",
      providerID: "test",
      name: "Test Model",
      api: { id: "test-model", url: "", npm: "@ai-sdk/openai" },
      capabilities: {
        reasoning: false,
        toolcall: true,
        temperature: true,
        input: { text: true, image: false, pdf: false, audio: false, video: false },
        output: { text: true, image: false, pdf: false, audio: false, video: false },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200000, output: 8192 },
      status: "active",
      headers: {},
      options: {},
      variants: {},
      ...overrides,
    },
  };
}

const MODEL = makeResolvedModel();

describe("Agent", () => {
  test("simple text response", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hello world" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL, session);
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
    const agent = new Agent({}, MODEL);
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
    const agent = new Agent({}, MODEL);
    await agent.prompt("Hi");
    const lastMsgs = agent.getLastPromptMessages();
    expect(lastMsgs.length).toBeGreaterThanOrEqual(1);
    expect(lastMsgs[0].role).toBe("assistant");
  });

  test("unregisterTool removes registered tool", () => {
    const agent = new Agent({}, MODEL);
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

    const agent = new Agent({}, MODEL);
    const promptPromise = agent.prompt("abort test");
    await Bun.sleep(20);

    agent.abort();
    expect(agent.getStatus()).toBe("aborted");

    resolveStream();
    try {
      await promptPromise;
    } catch (err: any) {
      expect(err.name).toBe("AbortError");
    }
  });

  // --- Multimodal prompt tests ---

  test("prompt(text) without attachments works", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Response" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({}, MODEL);
    const msg = await agent.prompt("Hello");
    expect(msg.content).toBe("Response");
    expect(msg.role).toBe("assistant");

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
    const agent = new Agent({}, MODEL);
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const msg = await agent.prompt("Describe this", [
      { data: imageData, mimeType: "image/png", filename: "test.png" },
    ]);
    expect(msg.content).toBe("I see an image");

    const userMsg = agent.getSession().getMessages().find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.attachments).toHaveLength(1);
    expect(userMsg!.attachments![0].mimeType).toBe("image/png");
  });

  test("prompt(text, []) with empty attachments does not store", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({}, MODEL);
    await agent.prompt("Hello", []);

    const userMsg = agent.getSession().getMessages().find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
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

    const agent = new Agent(
      { behavior: { maxSteps: 5 } },
      MODEL,
    );
    agent.registerTool("echo", {
      parameters: {},
      execute: async (args: any) => args.text,
    });

    const result = await agent.prompt("Hi");
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

    const agent = new Agent({}, MODEL);
    agent.registerTool("echo", { parameters: {}, execute: async () => "hi" });

    const result = await agent.prompt("Hi");
    expect(result.content).toBe("");
    expect(result.toolCalls).toBeTruthy();
  });

  test("fallback message distinguishes max steps from natural completion", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "finish", finishReason: "stop" },
      ]));

    const agent = new Agent({}, MODEL);
    const result = await agent.prompt("Hi");
    expect(result.content).toBe("(No text response)");
  });

  test("replaceTools clears existing and registers new tools", () => {
    const agent = new Agent({}, MODEL);
    agent.registerTool("old_tool", { parameters: {}, execute: async () => "old" });

    agent.replaceTools({
      new_tool: { parameters: {}, execute: async () => "new" } as any,
    });

    expect(agent["toolRegistry"].has("old_tool")).toBe(false);
    expect(agent["toolRegistry"].has("new_tool")).toBe(true);
    expect(agent["toolRegistry"].size).toBe(1);
  });

  test("setSystemPrompt updates the system prompt", () => {
    const agent = new Agent(
      { behavior: { systemPrompt: "Original prompt" } },
      MODEL,
    );

    agent.setSystemPrompt("Updated prompt");
    expect(agent["config"].behavior.systemPrompt).toBe("Updated prompt");
  });

  test("setModel updates the current model", () => {
    const agent = new Agent({}, MODEL);
    const newModel = makeResolvedModel({ id: "new-model" });
    agent.setModel(newModel);
    expect(agent.getModel().info.id).toBe("new-model");
  });

  // --- Runtime context injection tests ---

  test("runtime context injected before last user message", async () => {
    let capturedMessages: any[] = [];
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]);
    });
    const agent = new Agent({}, MODEL);
    agent.setRuntimeContext("[Runtime Context]\nCurrent time: test");
    await agent.prompt("Hello");

    // The runtime context message should appear before the last user message
    const userIndices = capturedMessages
      .map((m: any, i: number) => (m.role === "user" ? i : -1))
      .filter((i: number) => i >= 0);
    expect(userIndices.length).toBeGreaterThanOrEqual(2);

    const contextMsg = capturedMessages[userIndices[userIndices.length - 2]];
    expect(contextMsg.role).toBe("user");
    expect(contextMsg.content).toContain("[Runtime Context]");
  });

  test("no injection when runtimeContext is null", async () => {
    let capturedMessages: any[] = [];
    setStreamTextImpl((opts: any) => {
      capturedMessages = opts.messages;
      return mockStreamText([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]);
    });
    const agent = new Agent({}, MODEL);
    // Don't set runtimeContext
    await agent.prompt("Hello");

    const userMessages = capturedMessages.filter((m: any) => m.role === "user");
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].content).not.toContain("[Runtime Context]");
  });

  test("runtime context not persisted to session", async () => {
    setStreamTextImpl(() =>
      mockStreamText([
        { type: "text-delta", text: "Hi" },
        { type: "finish", finishReason: "stop" },
      ]));
    const agent = new Agent({}, MODEL);
    agent.setRuntimeContext("[Runtime Context]\nCurrent time: test");
    await agent.prompt("Hello");

    const sessionMessages = agent.getSession().getMessages();
    const contextMessages = sessionMessages.filter(
      (m) => m.content.includes("[Runtime Context]"),
    );
    expect(contextMessages.length).toBe(0);
  });

  test("runtime context re-injected each step", async () => {
    const capturedCalls: any[][] = [];
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      capturedCalls.push([...opts.messages]);
      callCount++;
      if (callCount === 1) {
        return mockStreamText([
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
      return mockStreamText([
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    const agent = new Agent({ behavior: { maxSteps: 5 } }, MODEL);
    agent.registerTool("echo", {
      parameters: {},
      execute: async (args: any) => args.text,
    });
    agent.setRuntimeContext("[Runtime Context]\nCurrent time: test");
    await agent.prompt("Hello");

    expect(capturedCalls.length).toBe(2);
    for (const messages of capturedCalls) {
      const hasContext = messages.some(
        (m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("[Runtime Context]"),
      );
      expect(hasContext).toBe(true);
    }
  });
});
