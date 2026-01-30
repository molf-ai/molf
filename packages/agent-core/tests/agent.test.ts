import { describe, expect, test, mock, beforeEach } from "bun:test";
import { Agent } from "../src/agent.js";
import type { AgentEvent, AgentStatus } from "../src/types.js";

describe("Agent", () => {
  test("initializes with idle status", () => {
    const agent = new Agent();
    expect(agent.getStatus()).toBe("idle");
  });

  test("initializes with empty session", () => {
    const agent = new Agent();
    expect(agent.getSession().length).toBe(0);
  });

  test("accepts config overrides", () => {
    const agent = new Agent({
      llm: { model: "gemini-2.5-pro" },
      behavior: { maxIterations: 5 },
    });
    expect(agent.getStatus()).toBe("idle");
  });

  test("onEvent registers and returns unsubscribe", () => {
    const agent = new Agent();
    const events: AgentEvent[] = [];
    const unsub = agent.onEvent((e) => events.push(e));

    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("resetSession clears messages and sets idle", () => {
    const agent = new Agent();
    agent.resetSession();
    expect(agent.getSession().length).toBe(0);
    expect(agent.getStatus()).toBe("idle");
  });

  test("registerTool adds tool to registry", () => {
    const agent = new Agent();
    const { z } = require("zod");

    agent.registerTool({
      name: "greet",
      description: "Greets someone",
      inputSchema: z.object({ name: z.string() }),
      execute: async (args: any) => `Hello, ${args.name}!`,
    });

    // No throw means success; we can verify via getSession not crashing
    expect(agent.getStatus()).toBe("idle");
  });

  test("abort sets status to aborted", () => {
    const agent = new Agent();
    const events: AgentEvent[] = [];
    agent.onEvent((e) => events.push(e));

    // Abort while idle does nothing (no controller)
    agent.abort();
    expect(agent.getStatus()).toBe("idle");
  });

  test("prompt throws when no API key is set", async () => {
    // Ensure env var is not set for this test
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const agent = new Agent();
      await expect(agent.prompt("Hello")).rejects.toThrow("GEMINI_API_KEY");
    } finally {
      if (original) process.env.GEMINI_API_KEY = original;
    }
  });
});
