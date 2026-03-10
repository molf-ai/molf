import { describe, test, expect, beforeAll } from "vitest";
import { generateText, streamText, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

const SKIP = !process.env.MOLF_LIVE_TEST;

describe.skipIf(SKIP)("Gemini live smoke", () => {
  let google: ReturnType<typeof createGoogleGenerativeAI>;

  beforeAll(() => {
    google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY! });
  });

  test("text response", async () => {
    const result = await generateText({
      model: google("gemini-2.5-flash"),
      prompt: "Reply with exactly: PONG",
    });
    expect(result.text).toContain("PONG");
  }, 30_000);

  test("tool call", async () => {
    const result = streamText({
      model: google("gemini-2.5-flash"),
      prompt: "What is 2 + 2? Use the calculator tool.",
      tools: {
        calculator: tool({
          description: "Add two numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => ({ result: a + b }),
        }),
      },
    });
    let sawToolCall = false;
    for await (const event of result.fullStream) {
      if (event.type === "tool-call") sawToolCall = true;
    }
    expect(sawToolCall).toBe(true);
  }, 30_000);
});
