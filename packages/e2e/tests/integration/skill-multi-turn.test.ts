import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  promptAndWait,
  waitForPersistence,
  getDefaultWsId,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

/**
 * Integration tests for skill content persistence in multi-turn conversations.
 *
 * When the LLM invokes the "skill" tool, the skill content is returned as a
 * tool result. This result should be persisted in the session history so that
 * subsequent turns can reference it.
 */
describe("Skill content in multi-turn conversation", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;

      // First prompt: LLM calls the skill tool
      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_skill_1",
              toolName: "skill",
              input: { name: "coding-style" },
            };
            let output: unknown = "no-skill";
            const skillTool = opts.tools?.["skill"];
            if (skillTool?.execute) {
              output = await skillTool.execute({ name: "coding-style" }, { toolCallId: "tc_skill_1" });
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_skill_1",
              toolName: "skill",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Second call (after skill result): LLM responds with text
      if (callCount === 2) {
        return mockTextResponse("I've loaded the coding style guide. I'll follow it.");
      }

      // Third prompt (second turn): LLM references skill content
      callCount = 0;
      return mockTextResponse("Based on the coding style guide, use camelCase.");
    });

    server = await startTestServer();
    worker = await connectTestWorker(
      server.url,
      server.token,
      "skill-multi-worker",
      {
        echo: { description: "Echo", execute: async (args: any) => ({ output: args.text }) },
      },
      [
        {
          name: "coding-style",
          description: "Load the coding style guide",
          content: "Always use camelCase for variables. Indent with 2 spaces. Use const over let.",
        },
      ],
    );
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("skill result persists in session and is available in subsequent turns", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // First prompt: triggers skill tool call
      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Load the coding style guide",
      });

      // Skill tool should have been called
      const tcStart = events.find((e) => e.type === "tool_call_start") as any;
      expect(tcStart).toBeTruthy();
      expect(tcStart.toolName).toBe("skill");

      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeTruthy();
      // Result should contain the skill content
      expect(tcEnd.result).toContain("camelCase");

      // First turn completes
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();

      // Wait for session to persist
      await waitForPersistence();

      // Second prompt: LLM references skill content from history
      await promptAndWait(client.trpc, {
        sessionId: session.sessionId,
        text: "What naming convention should I use?",
      });

      await waitForPersistence();

      // Verify session history contains skill result
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });

      // Should have skill tool result in history
      const toolMsg = loaded.messages.find(
        (m) => m.role === "tool" && m.toolName === "skill",
      );
      expect(toolMsg).toBeTruthy();
      expect(toolMsg!.content).toContain("camelCase");

      // Should have both user prompts
      const userMsgs = loaded.messages.filter((m) => m.role === "user");
      expect(userMsgs.length).toBe(2);
      expect(userMsgs[0].content).toBe("Load the coding style guide");
      expect(userMsgs[1].content).toBe("What naming convention should I use?");

      // Should have assistant responses for both turns
      const assistantMsgs = loaded.messages.filter(
        (m) => m.role === "assistant" && m.content,
      );
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
    } finally {
      client.cleanup();
    }
  });
});
