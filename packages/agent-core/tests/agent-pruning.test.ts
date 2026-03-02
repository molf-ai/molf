import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, mockStreamText } from "@molf-ai/test-utils";
import type { ResolvedModel, ProviderModel } from "../src/providers/types.js";

const { Agent } = await import("../src/agent.js");
const { Session } = await import("../src/session.js");

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

/** Build a session pre-loaded with tool call round-trips. */
function buildLargeSession(toolResultSize: number, count: number): InstanceType<typeof Session> {
  const session = new Session();
  session.addMessage({ role: "user", content: "initial question" });
  for (let i = 0; i < count; i++) {
    session.addMessage({
      role: "assistant",
      content: `step ${i}`,
      toolCalls: [{ toolCallId: `tc-${i}`, toolName: "search", args: { q: `query-${i}` } }],
    });
    session.addMessage({
      role: "tool",
      content: "X".repeat(toolResultSize),
      toolCallId: `tc-${i}`,
      toolName: "search",
    });
  }
  // Add recent assistants (protected zone)
  for (let i = 0; i < 3; i++) {
    session.addMessage({ role: "assistant", content: `recent-${i}` });
  }
  return session;
}

describe("Agent context pruning", () => {
  test("pruning enabled with large context: prompt completes and session intact", async () => {
    let streamTextCalls: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      streamTextCalls.push(args);
      return mockTextResponse("Pruned response");
    });

    const session = buildLargeSession(10_000, 5);
    const originalMessageCount = session.length;

    const agent = new Agent(
      { behavior: { contextPruning: true } },
      MODEL,
      session,
    );
    const msg = await agent.prompt("follow-up question");

    expect(msg.content).toBe("Pruned response");
    expect(session.length).toBe(originalMessageCount + 2);

    const toolMsgs = session.getMessages().filter((m) => m.role === "tool");
    for (const tm of toolMsgs) {
      expect(tm.content.length).toBe(10_000);
    }
  });

  test("error recovery retries with aggressive pruning", async () => {
    let streamTextCalls: any[] = [];
    let callCount = 0;
    setStreamTextImpl((...args: any[]) => {
      streamTextCalls.push(args);
      callCount++;
      if (callCount === 1) {
        throw new Error("context_length_exceeded: too many tokens");
      }
      return mockTextResponse("Recovered response");
    });

    const session = buildLargeSession(10_000, 5);
    const agent = new Agent(
      { behavior: { contextPruning: false } },
      MODEL,
      session,
    );

    const msg = await agent.prompt("trigger retry");
    expect(msg.content).toBe("Recovered response");
    expect(streamTextCalls.length).toBe(2);
  });

  test("pruning disabled by default: streamText receives unmodified messages", async () => {
    let streamTextCalls: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      streamTextCalls.push(args);
      return mockTextResponse("Normal response");
    });

    const session = new Session();
    session.addMessage({ role: "user", content: "first" });
    session.addMessage({ role: "assistant", content: "reply" });

    const agent = new Agent({}, MODEL, session);
    await agent.prompt("second");

    expect(streamTextCalls.length).toBe(1);
    const opts = streamTextCalls[0][0];
    expect(opts.messages.length).toBe(3);
  });

  test("context window derived from model.info.limit.context", async () => {
    let streamTextCalls: any[] = [];
    let callCount = 0;
    setStreamTextImpl((...args: any[]) => {
      streamTextCalls.push(args);
      callCount++;
      if (callCount === 1) {
        throw new Error("context_length_exceeded");
      }
      return mockTextResponse("ok");
    });

    // Use a model with small context window
    const smallModel = makeResolvedModel({ limit: { context: 1000, output: 8192 } });
    const session = buildLargeSession(5_000, 4);
    const agent = new Agent(
      { behavior: { contextPruning: true } },
      smallModel,
      session,
    );

    const msg = await agent.prompt("test");
    expect(msg.content).toBe("ok");
    expect(streamTextCalls.length).toBe(2);
  });
});

describe("Agent context with summaries", () => {
  test("agent with summary in session builds context from summary forward", async () => {
    let capturedMessages: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      capturedMessages = args[0].messages;
      return mockTextResponse("Summary response");
    });

    const session = new Session();
    session.addMessage({ role: "user", content: "old question" });
    session.addMessage({ role: "assistant", content: "old answer" });
    session.addMessage({ role: "user", content: "[Summary boundary]", summary: true });
    session.addMessage({ role: "assistant", content: "This is a summary of the conversation", summary: true });
    session.addMessage({ role: "user", content: "recent question" });
    session.addMessage({ role: "assistant", content: "recent answer" });

    const agent = new Agent({}, MODEL, session);
    await agent.prompt("follow-up");

    expect(capturedMessages.length).toBe(5);
    expect(capturedMessages[0].content).toBe("[Summary boundary]");
    expect(capturedMessages[4].content).toBe("follow-up");
  });

  test("agent with summary + pruning: pruning operates on post-summary messages only", async () => {
    let capturedMessages: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      capturedMessages = args[0].messages;
      return mockTextResponse("Pruned+summarized response");
    });

    const session = new Session();
    session.addMessage({ role: "user", content: "ancient question" });
    session.addMessage({ role: "assistant", content: "ancient answer" });
    session.addMessage({ role: "user", content: "[Summary]", summary: true });
    session.addMessage({ role: "assistant", content: "Summary text", summary: true });
    for (let i = 0; i < 5; i++) {
      session.addMessage({
        role: "assistant",
        content: `step ${i}`,
        toolCalls: [{ toolCallId: `tc-s-${i}`, toolName: "search", args: { q: `q-${i}` } }],
      });
      session.addMessage({
        role: "tool",
        content: "X".repeat(10_000),
        toolCallId: `tc-s-${i}`,
        toolName: "search",
      });
    }
    for (let i = 0; i < 3; i++) {
      session.addMessage({ role: "assistant", content: `recent-${i}` });
    }

    const agent = new Agent(
      { behavior: { contextPruning: true } },
      MODEL,
      session,
    );
    await agent.prompt("test pruning with summary");

    const ancientIdx = capturedMessages.findIndex(
      (m: any) => typeof m.content === "string" && m.content === "ancient question",
    );
    expect(ancientIdx).toBe(-1);
    expect(capturedMessages[0].content).toBe("[Summary]");
  });
});
