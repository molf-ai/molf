import { describe, test, expect } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, mockStreamText } from "@molf-ai/test-utils";

const { Agent } = await import("../src/agent.js");
const { Session } = await import("../src/session.js");

const BASE_LLM = { provider: "gemini", model: "test", apiKey: "test-key" };

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
      { llm: BASE_LLM, behavior: { contextPruning: true } },
      session,
    );
    const msg = await agent.prompt("follow-up question");

    expect(msg.content).toBe("Pruned response");
    // Session should have original messages + new user + new assistant
    expect(session.length).toBe(originalMessageCount + 2);

    // Original tool results should be intact in session (pruning is in-memory only)
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
      { llm: BASE_LLM, behavior: { contextPruning: false } },
      session,
    );

    // Should recover even with pruning disabled — error recovery is always on
    const msg = await agent.prompt("trigger retry");
    expect(msg.content).toBe("Recovered response");
    // Should have been called twice (first fail, second succeed)
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

    const agent = new Agent({ llm: BASE_LLM }, session);
    await agent.prompt("second");

    // streamText should have been called with the full message set
    expect(streamTextCalls.length).toBe(1);
    const opts = streamTextCalls[0][0];
    // Messages should include: first user + reply assistant + second user = 3 model messages
    expect(opts.messages.length).toBe(3);
  });

  test("contextWindow config override is used instead of provider default", async () => {
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

    // Use a very small contextWindow — the retry should still work
    const session = buildLargeSession(5_000, 4);
    const agent = new Agent(
      {
        llm: { ...BASE_LLM, contextWindow: 1000 },
        behavior: { contextPruning: true },
      },
      session,
    );

    const msg = await agent.prompt("test");
    expect(msg.content).toBe("ok");
    // Two calls: first fails, second succeeds with aggressive pruning
    expect(streamTextCalls.length).toBe(2);
  });
});

describe("Agent context with summaries", () => {
  test("agent with summary in session → context built from summary forward", async () => {
    let capturedMessages: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      capturedMessages = args[0].messages;
      return mockTextResponse("Summary response");
    });

    const session = new Session();
    // Old messages (before summary)
    session.addMessage({ role: "user", content: "old question" });
    session.addMessage({ role: "assistant", content: "old answer" });
    // Summary pair
    session.addMessage({ role: "user", content: "[Summary boundary]", summary: true });
    session.addMessage({ role: "assistant", content: "This is a summary of the conversation", summary: true });
    // New messages (after summary)
    session.addMessage({ role: "user", content: "recent question" });
    session.addMessage({ role: "assistant", content: "recent answer" });

    const agent = new Agent({ llm: BASE_LLM }, session);
    await agent.prompt("follow-up");

    // streamText should receive messages from summary boundary forward (4 pre-existing + 1 new user)
    // summary_user, summary_assistant, recent_user, recent_assistant, follow-up_user = 5
    expect(capturedMessages.length).toBe(5);
    // First message should be the summary boundary user
    expect(capturedMessages[0].content).toBe("[Summary boundary]");
    // Last should be the new prompt
    expect(capturedMessages[4].content).toBe("follow-up");
  });

  test("agent with summary + pruning → pruning operates on post-summary messages only", async () => {
    let capturedMessages: any[] = [];
    setStreamTextImpl((...args: any[]) => {
      capturedMessages = args[0].messages;
      return mockTextResponse("Pruned+summarized response");
    });

    const session = new Session();
    // Old messages (should be excluded by summary)
    session.addMessage({ role: "user", content: "ancient question" });
    session.addMessage({ role: "assistant", content: "ancient answer" });
    // Summary pair
    session.addMessage({ role: "user", content: "[Summary]", summary: true });
    session.addMessage({ role: "assistant", content: "Summary text", summary: true });
    // Post-summary tool calls with large results
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
    // Protected zone
    for (let i = 0; i < 3; i++) {
      session.addMessage({ role: "assistant", content: `recent-${i}` });
    }

    const agent = new Agent(
      { llm: BASE_LLM, behavior: { contextPruning: true } },
      session,
    );
    await agent.prompt("test pruning with summary");

    // Should NOT contain the ancient messages
    const ancientIdx = capturedMessages.findIndex(
      (m: any) => typeof m.content === "string" && m.content === "ancient question",
    );
    expect(ancientIdx).toBe(-1);

    // First message should be the summary boundary
    expect(capturedMessages[0].content).toBe("[Summary]");
  });
});
