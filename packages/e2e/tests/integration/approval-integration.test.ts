import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  clearWsIdCache,
  waitUntil,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// always:true approval auto-approves subsequent matching calls
// =============================================================================

describe("Tool Approval — always:true auto-approves subsequent calls", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Mock LLM: two turns, each calling shell_exec once.
    // Turn 1 (callCount 1): shell_exec tool call -> tool result -> finish with tool-calls
    // Turn 1 (callCount 2): final text after tool result
    // Turn 2 (callCount 3): shell_exec tool call -> tool result -> finish with tool-calls
    // Turn 2 (callCount 4): final text after tool result
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;

      if (callCount === 1 || callCount === 3) {
        const toolCallId = `tc_always_${callCount}`;
        const command = callCount === 1 ? "echo hello" : "echo world";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "shell_exec",
              input: { command },
            };

            let result: unknown = "fallback";
            const toolDef = opts.tools?.["shell_exec"];
            if (toolDef?.execute) {
              result = await toolDef.execute({ command }, { toolCallId });
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

      // After tool result, LLM produces final text
      if (callCount === 2) {
        return mockTextResponse("First command done");
      }
      if (callCount === 4) {
        callCount = 0;
        return mockTextResponse("Second command done");
      }

      // Fallback
      return mockTextResponse("ok");
    });

    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "always-approval-worker", {
      shell_exec: {
        description: "Execute a shell command",
        execute: async () => ({ output: "exit code: 0" }),
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("always:true approval auto-approves subsequent matching calls", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // --- Turn 1: should require approval ---
      const turn1Events: AgentEvent[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Turn 1 timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onStarted: () => {
              client.trpc.agent.prompt
                .mutate({ sessionId: session.sessionId, text: "Run echo hello" })
                .catch(reject);
            },
            onData: (event) => {
              turn1Events.push(event);

              if (event.type === "tool_approval_required") {
                const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
                // Approve with always:true
                client.trpc.tool.approve
                  .mutate({
                    sessionId: session.sessionId,
                    approvalId: ev.approvalId,
                    always: true,
                  })
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
                reject(new Error(`Agent error in turn 1: ${(event as any).message}`));
              }
            },
            onError: (err) => {
              clearTimeout(timer);
              sub.unsubscribe();
              reject(err);
            },
          },
        );
      });

      // Verify turn 1 required approval
      const approvalEvent = turn1Events.find((e) => e.type === "tool_approval_required");
      expect(approvalEvent).toBeDefined();

      const turn1Complete = turn1Events.find((e) => e.type === "turn_complete") as any;
      expect(turn1Complete).toBeDefined();
      expect(turn1Complete.message.content).toBe("First command done");

      // --- Turn 2: should NOT require approval (auto-approved by runtime layer) ---
      const turn2Events: AgentEvent[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Turn 2 timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onStarted: () => {
              client.trpc.agent.prompt
                .mutate({ sessionId: session.sessionId, text: "Run echo world" })
                .catch(reject);
            },
            onData: (event) => {
              turn2Events.push(event);

              if (event.type === "turn_complete") {
                clearTimeout(timer);
                sub.unsubscribe();
                resolve();
              }

              if (event.type === "error") {
                clearTimeout(timer);
                sub.unsubscribe();
                reject(new Error(`Agent error in turn 2: ${(event as any).message}`));
              }
            },
            onError: (err) => {
              clearTimeout(timer);
              sub.unsubscribe();
              reject(err);
            },
          },
        );
      });

      // Verify turn 2 did NOT require approval
      const turn2Approval = turn2Events.find((e) => e.type === "tool_approval_required");
      expect(turn2Approval).toBeUndefined();

      // Verify turn 2 completed successfully
      const turn2Complete = turn2Events.find((e) => e.type === "turn_complete") as any;
      expect(turn2Complete).toBeDefined();
      expect(turn2Complete.message.content).toBe("Second command done");

      // Tool call events should still be emitted (tool executed without approval gate)
      const tcStart = turn2Events.find((e) => e.type === "tool_call_start") as any;
      expect(tcStart).toBeDefined();
      expect(tcStart.toolName).toBe("shell_exec");

      // No pending approvals remain
      expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Approval cleared on session eviction
// =============================================================================

describe("Tool Approval — approval cleared on session eviction", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Mock LLM: calls shell_exec which will block on approval gate
    setStreamTextImpl((opts: any) => {
      const toolCallId = "tc_eviction_1";
      return {
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId,
            toolName: "shell_exec",
            input: { command: "rm -rf /" },
          };

          let result: unknown = "fallback";
          const toolDef = opts.tools?.["shell_exec"];
          if (toolDef?.execute) {
            result = await toolDef.execute(
              { command: "rm -rf /" },
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
    });

    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "eviction-approval-worker", {
      shell_exec: {
        description: "Execute a shell command",
        execute: async () => ({ output: "exit code: 0" }),
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("approval cleared on session eviction", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // Wait for tool_approval_required event (approval pending)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Waiting for approval event timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onStarted: () => {
              client.trpc.agent.prompt
                .mutate({ sessionId: session.sessionId, text: "Delete everything" })
                .catch(reject);
            },
            onData: (event) => {
              if (event.type === "tool_approval_required") {
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
      });

      // Verify there is a pending approval
      expect(server.instance._ctx.approvalGate.pendingCount).toBeGreaterThan(0);

      // Evict the session — should clear all pending approvals
      server.instance._ctx.agentRunner.evict(session.sessionId);

      // Wait for eviction to take effect
      await waitUntil(
        () => server.instance._ctx.approvalGate.pendingCount === 0,
        5000,
        "pending approvals to be cleared after eviction",
      );

      // Verify no pending approvals remain
      expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});

// =============================================================================
// Deny with feedback provides feedback to LLM
// =============================================================================

describe("Tool Approval — deny with feedback", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        const toolCallId = "tc_deny_fb_1";
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId,
              toolName: "shell_exec",
              input: { command: "dangerous-command" },
            };

            let result: unknown = "fallback";
            const toolDef = opts.tools?.["shell_exec"];
            if (toolDef?.execute) {
              result = await toolDef.execute(
                { command: "dangerous-command" },
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
      // Fallback for subsequent calls
      callCount = 0;
      return mockTextResponse("Understood, I won't run that.");
    });

    server = await startTestServer({ approval: true });
    worker = await connectTestWorker(server.url, server.token, "deny-feedback-worker", {
      shell_exec: {
        description: "Execute a shell command",
        execute: async () => ({ output: "exit code: 0" }),
      },
    });
  });

  afterAll(() => {
    clearWsIdCache();
    worker.cleanup();
    server.cleanup();
  });

  test("deny with feedback provides feedback to LLM", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const events: AgentEvent[] = [];
      const feedbackText = "This command is too dangerous, use a safer alternative";

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error("Deny with feedback test timed out after 15s"));
        }, 15_000);

        const sub = client.trpc.agent.onEvents.subscribe(
          { sessionId: session.sessionId },
          {
            onStarted: () => {
              client.trpc.agent.prompt
                .mutate({ sessionId: session.sessionId, text: "Run dangerous-command" })
                .catch(reject);
            },
            onData: (event) => {
              events.push(event);

              if (event.type === "tool_approval_required") {
                const ev = event as Extract<AgentEvent, { type: "tool_approval_required" }>;
                // Deny with feedback
                client.trpc.tool.deny
                  .mutate({
                    sessionId: session.sessionId,
                    approvalId: ev.approvalId,
                    feedback: feedbackText,
                  })
                  .catch(reject);
              }

              // The agent turn ends with error or turn_complete after denial
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
      });

      // tool_approval_required was emitted
      const approvalEvent = events.find((e) => e.type === "tool_approval_required");
      expect(approvalEvent).toBeDefined();

      // The turn ended — either error (rejection propagated) or turn_complete
      const errorEvent = events.find((e) => e.type === "error") as any;
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;

      // At least one must exist
      expect(errorEvent || turnComplete).toBeTruthy();

      // If error event was emitted, the feedback should be in the message
      if (errorEvent) {
        expect(errorEvent.message).toContain(feedbackText);
      }

      // If turn_complete (LLM handled rejection gracefully), verify the turn ended
      if (turnComplete) {
        expect(turnComplete.message).toBeDefined();
      }

      // No pending approvals remain
      expect(server.instance._ctx.approvalGate.pendingCount).toBe(0);
    } finally {
      client.cleanup();
    }
  });
});
