import { describe, test, expect } from "bun:test";

const SKIP = !process.env.MOLF_LIVE_TEST;

describe.skipIf(SKIP)("Agent live smoke", () => {
  test("simple prompt returns response", async () => {
    const { Agent } = await import("@molf-ai/agent-core");
    const agent = new Agent({
      llm: { apiKey: process.env.GEMINI_API_KEY! },
      behavior: { maxSteps: 3 },
    });

    const events: string[] = [];
    agent.onEvent((e) => events.push(e.type));

    const msg = await agent.prompt("Reply with exactly: HELLO");
    expect(msg.content).toContain("HELLO");
    expect(events).toContain("status_change");
    expect(events).toContain("turn_complete");
  }, 30_000);
});
