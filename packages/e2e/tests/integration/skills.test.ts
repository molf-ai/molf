import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  promptAndCollect,
  sleep,
  waitUntil,
  getDefaultWsId,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// P1: Skill system end-to-end
// =============================================================================

describe("Skill system integration", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Mock that calls the skill tool on first invocation
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_skill_1",
              toolName: "skill",
              input: { name: "greeting" },
            };
            // Execute the skill tool (server-local, not dispatched to worker)
            let output: unknown = "no-skill";
            const skillTool = opts.tools?.["skill"];
            if (skillTool?.execute) {
              output = await skillTool.execute({ name: "greeting" }, { toolCallId: "tc_skill_1" });
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
      callCount = 0;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "Skill loaded!" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    });

    server = await startTestServer();
    worker = await connectTestWorker(
      server.url,
      server.token,
      "skilled-worker",
      { echo: { description: "Echo", execute: async (args: any) => ({ output: args.text }) } },
      [
        {
          name: "greeting",
          description: "A greeting skill",
          content: "Always greet the user warmly and enthusiastically.",
        },
      ],
    );
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("worker with skills shows skills in agent.list", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const list = await client.trpc.agent.list.query();
      const found = list.workers.find((w) => w.workerId === worker.workerId);
      expect(found).toBeTruthy();
      expect(found!.skills.length).toBe(1);
      expect(found!.skills[0].name).toBe("greeting");
    } finally {
      client.cleanup();
    }
  });

  test("skill tool is available and returns skill content", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Use greeting skill",
      });

      // Should have tool_call_start for "skill" tool
      const tcStart = events.find((e) => e.type === "tool_call_start") as any;
      expect(tcStart).toBeTruthy();
      expect(tcStart.toolName).toBe("skill");

      // Should have tool_call_end with skill content
      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeTruthy();
      expect(tcEnd.toolName).toBe("skill");
      expect(tcEnd.result).toContain("greet the user");

      // Should complete with final text
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toBe("Skill loaded!");
    } finally {
      client.cleanup();
    }
  });

  test("skill tool returns error for unknown skill name", async () => {
    // We need a mock that calls skill with an unknown name
    setStreamTextImpl((opts: any) => ({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "tc_bad",
          toolName: "skill",
          input: { name: "nonexistent" },
        };
        let output: unknown = "no-skill";
        const skillTool = opts.tools?.["skill"];
        if (skillTool?.execute) {
          output = await skillTool.execute({ name: "nonexistent" }, { toolCallId: "tc_bad" });
        }
        yield {
          type: "tool-result",
          toolCallId: "tc_bad",
          toolName: "skill",
          output,
        };
        yield { type: "finish", finishReason: "stop" };
      })(),
    }));

    const unknownServer = await startTestServer();
    const unknownWorker = await connectTestWorker(
      unknownServer.url,
      unknownServer.token,
      "skill-err-worker",
      {},
      [{ name: "only_skill", description: "Only skill", content: "content" }],
    );
    const client = createTestClient(unknownServer.url, unknownServer.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: unknownWorker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, unknownWorker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Try unknown skill",
      });

      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeTruthy();
      // Result should contain error about unknown skill
      expect(tcEnd.result).toContain("Unknown skill");
    } finally {
      client.cleanup();
      unknownWorker.cleanup();
      unknownServer.cleanup();
    }
  });
});
