import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { agentEventSchema } from "@molf-ai/protocol";
import type { AgentEvent } from "@molf-ai/protocol";

// Dynamic import AFTER the AI mock harness has registered its mock.module("ai", ...)
const {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  sleep,
} = await import("../../helpers/index.js");

import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Skeleton / schema tests (no real LLM needed)
// =============================================================================

describe("Tool Approval — Protocol", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    setStreamTextImpl(() => {
      throw new Error("LLM should not be called in protocol tests");
    });
    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "approval-proto-worker");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("tool.approve with unknown approvalId returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.approve.mutate({
        sessionId: "any",
        approvalId: "nonexistent",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("tool.deny with unknown approvalId returns applied=false", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.deny.mutate({
        sessionId: "any",
        approvalId: "nonexistent",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("tool.approve supports always field", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.approve.mutate({
        sessionId: "any",
        approvalId: "nonexistent",
        always: true,
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("tool.deny supports feedback field", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.tool.deny.mutate({
        sessionId: "any",
        approvalId: "nonexistent",
        feedback: "Don't do that",
      });
      expect(result.applied).toBe(false);
    } finally {
      client.cleanup();
    }
  });

  test("tool_approval_required event schema validates with approvalId", () => {
    const event = {
      type: "tool_approval_required" as const,
      approvalId: "session-1:abc12345",
      toolName: "dangerous-tool",
      arguments: '{"action":"delete"}',
      sessionId: "sess-1",
    };

    const result = agentEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  test("approval gate is accessible on server instance", () => {
    expect(server.instance._ctx.approvalGate).toBeDefined();
    expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
  });
});

// =============================================================================
// End-to-end approval workflow: real LLM mock + agent turn
// =============================================================================

describe("Tool Approval — End-to-End Workflow", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Mock LLM: first call yields shell_exec tool call and awaits real execute
    // (which blocks on approval gate). Second call returns final text.
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        const toolCallId = "tc_approval_1";
        return {
          fullStream: (async function* () {
            // LLM decides to call shell_exec with a command that triggers "ask"
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "shell_exec",
              input: { command: "python script.py" },
            };

            // Call through the real AgentRunner execute pipeline.
            // This will hit the approval gate (evaluates to "ask"), emit
            // tool_approval_required, and block until the client approves.
            let result: unknown = "fallback";
            const toolDef = opts.tools?.["shell_exec"];
            if (toolDef?.execute) {
              result = await toolDef.execute(
                { command: "python script.py" },
                { toolCallId },
              );
            }

            yield {
              type: "tool-result",
              toolCallId,
              toolName: "shell_exec",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      // Second invocation: LLM summarises after seeing the tool result
      callCount = 0;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "Script executed successfully" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    });

    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "approval-e2e-worker", {
      shell_exec: {
        description: "Execute a shell command",
        // Mock worker always returns success
        execute: async () => ({ output: "exit code: 0" }),
      },
    });
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("tool_approval_required → approve → tool executes → turn completes", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const events: AgentEvent[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Tool approval e2e test timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onData: (event) => {
              events.push(event);

              if (event.type === "tool_approval_required") {
                const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
                // Approve immediately — fire-and-forget so it doesn't block onData
                client.trpc.tool.approve
                  .mutate({ sessionId: session.sessionId, approvalId: ev.approvalId })
                  .catch(reject);
              }

              if (event.type === "turn_complete") {
                clearTimeout(timer);
                sub.unsubscribe();
                resolve();
              }

              if (event.type === "error") {
                clearTimeout(timer);
                sub.unsubscribe();
                reject(new Error(`Agent error: ${(event as any).message}`));
              }
            },
            onError: (err) => {
              clearTimeout(timer);
              sub.unsubscribe();
              reject(err);
            },
          },
        );

        // Give subscription time to establish, then start the agent turn
        sleep(100).then(() =>
          client.trpc.agent.prompt
            .mutate({ sessionId: session.sessionId, text: "Run the python script" })
            .catch(reject),
        );
      });

      // 1. tool_approval_required was emitted
      const approvalEvent = events.find((e) => e.type === "tool_approval_required");
      expect(approvalEvent).toBeDefined();
      const ev = approvalEvent as Extract<AgentEvent, { type: "tool_approval_required" }>;
      expect(ev.toolName).toBe("shell_exec");
      expect(ev.approvalId).toBeTruthy();
      expect(ev.sessionId).toBe(session.sessionId);
      expect(JSON.parse(ev.arguments)).toEqual({ command: "python script.py" });

      // 2. Tool executed after approval (tool_call_start + tool_call_end)
      const tcStart = events.find((e) => e.type === "tool_call_start") as any;
      expect(tcStart).toBeDefined();
      expect(tcStart.toolName).toBe("shell_exec");

      const tcEnd = events.find((e) => e.type === "tool_call_end") as any;
      expect(tcEnd).toBeDefined();
      expect(tcEnd.toolName).toBe("shell_exec");

      // 3. Turn completed
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeDefined();
      expect(turnComplete.message.content).toBe("Script executed successfully");

      // 4. No pending approvals remain
      expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
    } finally {
      client.cleanup();
    }
  });

  test("tool_approval_required → deny → agent emits error event", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const events: AgentEvent[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Tool approval deny e2e test timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onData: (event) => {
              events.push(event);

              if (event.type === "tool_approval_required") {
                const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
                // Deny with feedback
                client.trpc.tool.deny
                  .mutate({
                    sessionId: session.sessionId,
                    approvalId: ev.approvalId,
                    feedback: "Not safe to run",
                  })
                  .catch(reject);
              }

              // When a tool is rejected, the stream errors out and AgentRunner
              // emits an error event (the rejection propagates through the mock stream)
              if (event.type === "error" || event.type === "turn_complete") {
                clearTimeout(timer);
                sub.unsubscribe();
                resolve();
              }
            },
            onError: (err) => {
              clearTimeout(timer);
              sub.unsubscribe();
              reject(err);
            },
          },
        );

        sleep(100).then(() =>
          client.trpc.agent.prompt
            .mutate({ sessionId: session.sessionId, text: "Run the python script" })
            .catch(reject),
        );
      });

      // tool_approval_required was emitted
      expect(events.some((e) => e.type === "tool_approval_required")).toBe(true);

      // The agent turn ended (either error or turn_complete depending on LLM error handling)
      expect(
        events.some((e) => e.type === "error" || e.type === "turn_complete"),
      ).toBe(true);

      // No pending approvals remain
      expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// End-to-end approval workflow for skill tool
// =============================================================================

describe("Tool Approval — Skill Workflow", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        const toolCallId = "tc_skill_1";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "skill",
              input: { name: "deploy" },
            };

            let result: unknown = "fallback";
            const toolDef = opts.tools?.["skill"];
            if (toolDef?.execute) {
              result = await toolDef.execute(
                { name: "deploy" },
                { toolCallId },
              );
            }

            yield {
              type: "tool-result",
              toolCallId,
              toolName: "skill",
              output: result,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      callCount = 0;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "Skill loaded successfully" };
          yield { type: "finish", finishReason: "stop" };
        })(),
      };
    });

    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "approval-skill-worker", undefined, [
      { name: "deploy", description: "Deploy the application", content: "Deploy instructions here" },
    ]);
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("skill tool_approval_required → approve → skill content returned", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const events: AgentEvent[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Skill approval e2e test timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onData: (event) => {
              events.push(event);

              if (event.type === "tool_approval_required") {
                const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
                client.trpc.tool.approve
                  .mutate({ sessionId: session.sessionId, approvalId: ev.approvalId })
                  .catch(reject);
              }

              if (event.type === "turn_complete") {
                clearTimeout(timer);
                sub.unsubscribe();
                resolve();
              }

              if (event.type === "error") {
                clearTimeout(timer);
                sub.unsubscribe();
                reject(new Error(`Agent error: ${(event as any).message}`));
              }
            },
            onError: (err) => {
              clearTimeout(timer);
              sub.unsubscribe();
              reject(err);
            },
          },
        );

        sleep(100).then(() =>
          client.trpc.agent.prompt
            .mutate({ sessionId: session.sessionId, text: "Load the deploy skill" })
            .catch(reject),
        );
      });

      // tool_approval_required was emitted for the skill tool
      const approvalEvent = events.find((e) => e.type === "tool_approval_required");
      expect(approvalEvent).toBeDefined();
      const ev = approvalEvent as Extract<AgentEvent, { type: "tool_approval_required" }>;
      expect(ev.toolName).toBe("skill");
      expect(JSON.parse(ev.arguments)).toEqual({ name: "deploy" });

      // Turn completed
      expect(events.some((e) => e.type === "turn_complete")).toBe(true);

      // No pending approvals remain
      expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});
