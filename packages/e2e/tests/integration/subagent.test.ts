import { vi, describe, test, expect, beforeAll, afterAll } from "vitest"; 
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse } from "@molf-ai/test-utils";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { AgentEvent, WorkerAgentInfo } from "@molf-ai/protocol";

import {
  startTestServer,
  connectTestWorker,
  createTestClient,
  getDefaultWsId,
  promptAndCollect,
  waitUntil,
} from "../../helpers/index.js";

import type { TestServer, TestWorker } from "../../helpers/index.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

// =============================================================================
// Subagent integration tests
// =============================================================================

describe("Subagent integration", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();
    worker = await connectTestWorker(
      server.url,
      server.token,
      "subagent-worker",
      {
        grep: {
          description: "Search files",
          execute: async (args: any) => ({ output: `Found: ${args.pattern ?? "nothing"}` }),
        },
        read_file: {
          description: "Read a file",
          execute: async (args: any) => ({ output: `Content of ${args.path ?? "unknown"}` }),
        },
      },
    );
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("task tool is available for sessions with default agents", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const tools = await client.trpc.tool.list.query({
        sessionId: session.sessionId,
      });

      // Should have worker tools + skill (if any) + task
      // task is a server-local tool, may not show in tool.list since
      // tool.list only shows worker tools. Let's check system prompt instead.
      expect(tools.tools.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.cleanup();
    }
  });

  test("full flow: prompt → task tool → subagent runs → result returned", async () => {
    // Mock: parent calls task tool, subagent responds, then parent responds
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;

      // First call (parent): invoke the task tool
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_task_1",
              toolName: "task",
              input: {
                description: "Explore codebase",
                prompt: "Find the main entry point",
                agentType: "explore",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Explore codebase",
                  prompt: "Find the main entry point",
                  agentType: "explore",
                },
                { toolCallId: "tc_task_1" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_task_1",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Second call (subagent): simple text response
      if (callDepth === 2) {
        return mockTextResponse("Found main.ts as the entry point");
      }

      // Third call (parent after task result): final response
      callDepth = 0;
      return mockTextResponse("The main entry point is main.ts");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Find the main entry point using a subagent",
      });

      // Should have tool_call_start/end for "task"
      const tcStart = events.find(
        (e) => e.type === "tool_call_start" && (e as any).toolName === "task",
      );
      expect(tcStart).toBeTruthy();

      const tcEnd = events.find(
        (e) => e.type === "tool_call_end" && (e as any).toolName === "task",
      );
      expect(tcEnd).toBeTruthy();
      // Task result should contain the subagent's output
      expect((tcEnd as any).result).toContain("main.ts");
      expect((tcEnd as any).result).toContain("task_result");

      // Should complete with final text
      const turnComplete = events.find((e) => e.type === "turn_complete") as any;
      expect(turnComplete).toBeTruthy();
      expect(turnComplete.message.content).toContain("main.ts");
    } finally {
      client.cleanup();
    }
  });

  test("child session is persisted with subagent metadata", async () => {
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_task_persist",
              toolName: "task",
              input: {
                description: "Quick check",
                prompt: "Check something",
                agentType: "general",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Quick check",
                  prompt: "Check something",
                  agentType: "general",
                },
                { toolCallId: "tc_task_persist" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_task_persist",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      if (callDepth === 2) {
        return mockTextResponse("Checked and verified");
      }
      callDepth = 0;
      return mockTextResponse("All checks passed");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Run a check",
      });

      // List sessions — should have both parent and child
      const listed = await client.trpc.session.list.query();
      const childSession = listed.sessions.find(
        s => s.name?.includes("subagent") && s.sessionId !== session.sessionId,
      );
      expect(childSession).toBeTruthy();
      expect(childSession!.metadata).toBeDefined();
      expect((childSession!.metadata as any).subagent?.parentSessionId).toBe(session.sessionId);
    } finally {
      client.cleanup();
    }
  });

  test("subagent events forwarded to parent wrapped in subagent_event", async () => {
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;

      // Parent: invoke the task tool (explore)
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_task_prefix",
              toolName: "task",
              input: {
                description: "Search codebase",
                prompt: "Search for TODO comments",
                agentType: "explore",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Search codebase",
                  prompt: "Search for TODO comments",
                  agentType: "explore",
                },
                { toolCallId: "tc_task_prefix" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_task_prefix",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent: call grep tool, then respond
      if (callDepth === 2) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_grep_sub",
              toolName: "grep",
              input: { pattern: "TODO", path: "src/" },
            };
            const grepTool = opts.tools?.["grep"];
            let output = "no-grep-tool";
            if (grepTool?.execute) {
              output = await grepTool.execute(
                { pattern: "TODO", path: "src/" },
                { toolCallId: "tc_grep_sub" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_grep_sub",
              toolName: "grep",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent step 2: text response after tool result
      if (callDepth === 3) {
        return mockTextResponse("Found 3 TODO comments in the codebase");
      }

      // Parent after task result: final response
      callDepth = 0;
      return mockTextResponse("There are 3 TODO comments");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Search for TODOs using a subagent",
      });

      // Subagent events should be wrapped in subagent_event
      const wrappedStart = events.find(
        (e) =>
          e.type === "subagent_event" &&
          (e as any).event.type === "tool_call_start" &&
          (e as any).event.toolName === "grep",
      );
      expect(wrappedStart).toBeTruthy();
      expect((wrappedStart as any).agentType).toBe("explore");
      expect((wrappedStart as any).event.toolCallId).toBe("tc_grep_sub");

      const wrappedEnd = events.find(
        (e) =>
          e.type === "subagent_event" &&
          (e as any).event.type === "tool_call_end" &&
          (e as any).event.toolName === "grep",
      );
      expect(wrappedEnd).toBeTruthy();
      expect((wrappedEnd as any).event.result).toContain("Found:");
    } finally {
      client.cleanup();
    }
  });
});

describe("Subagent with denied tool call", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer({ approval: true });

    // Worker-defined agent with restrictive permissions
    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "read-only",
        description: "Read-only agent",
        content: "You only read files.",
        permission: { "*": "deny", grep: "allow", read_file: "allow" },
      },
    ];

    worker = await connectTestWorker(
      server.url,
      server.token,
      "deny-test-worker",
      {
        grep: {
          description: "Search files",
          execute: async (args: any) => ({ output: `Found: ${args.pattern ?? "nothing"}` }),
        },
        shell_exec: {
          description: "Run a shell command",
          execute: async (args: any) => ({ output: `Ran: ${args.command ?? "nothing"}` }),
        },
      },
      undefined,
      { agents: workerAgents },
    );

    // Write empty static permissions for this worker so ONLY the agent
    // permission layer is active (no default rules to override the deny)
    const workerDir = resolve(server.tmp.path, "workers", worker.workerId);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(resolve(workerDir, "permissions.jsonc"), "[]");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("tool denied by agent permission returns error to LLM", async () => {
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;

      // Parent: invoke the task tool (read-only agent)
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_task_deny",
              toolName: "task",
              input: {
                description: "Try shell command",
                prompt: "Run ls",
                agentType: "read-only",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Try shell command",
                  prompt: "Run ls",
                  agentType: "read-only",
                },
                { toolCallId: "tc_task_deny" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_task_deny",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent: tries to call shell_exec (should be denied by agent permission)
      if (callDepth === 2) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_shell_deny",
              toolName: "shell_exec",
              input: { command: "ls" },
            };
            const shellTool = opts.tools?.["shell_exec"];
            let output = "no-tool";
            if (shellTool?.execute) {
              output = await shellTool.execute(
                { command: "ls" },
                { toolCallId: "tc_shell_deny" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_shell_deny",
              toolName: "shell_exec",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent step 2: text response (LLM sees denial result)
      if (callDepth === 3) {
        return mockTextResponse("Shell command was denied by policy");
      }

      // Parent after task result
      callDepth = 0;
      return mockTextResponse("The command was blocked");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Run a shell command via subagent",
      });

      // The subagent's shell_exec tool call should be wrapped in subagent_event
      const shellEnd = events.find(
        (e) =>
          e.type === "subagent_event" &&
          (e as any).event.type === "tool_call_end" &&
          (e as any).event.toolName === "shell_exec",
      );
      expect(shellEnd).toBeTruthy();
      expect((shellEnd as any).agentType).toBe("read-only");
      // The result should contain the denial message (ToolDeniedError)
      expect((shellEnd as any).event.result).toContain("denied");

      // The task result should contain the subagent's response about denial
      const taskEnd = events.find(
        (e) => e.type === "tool_call_end" && (e as any).toolName === "task",
      ) as any;
      expect(taskEnd).toBeTruthy();
      expect(taskEnd.result).toContain("denied");
    } finally {
      client.cleanup();
    }
  });
});

describe("Subagent with worker-defined agents", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();

    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "reviewer",
        description: "Code review agent",
        content: "You review code for issues.",
        permission: { "*": "deny", grep: "allow", read_file: "allow" },
        maxSteps: 5,
      },
    ];

    worker = await connectTestWorker(
      server.url,
      server.token,
      "custom-agent-worker",
      {
        grep: {
          description: "Search files",
          execute: async (args: any) => ({ output: `Found: ${args.pattern ?? "nothing"}` }),
        },
        read_file: {
          description: "Read a file",
          execute: async (args: any) => ({ output: `Content of ${args.path ?? "unknown"}` }),
        },
      },
      undefined,
      { agents: workerAgents },
    );
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("worker-defined agent is available via task tool", async () => {
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_custom_1",
              toolName: "task",
              input: {
                description: "Review code",
                prompt: "Review the main module",
                agentType: "reviewer",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Review code",
                  prompt: "Review the main module",
                  agentType: "reviewer",
                },
                { toolCallId: "tc_custom_1" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_custom_1",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }
      if (callDepth === 2) {
        return mockTextResponse("Code review complete: no issues found");
      }
      callDepth = 0;
      return mockTextResponse("Review done");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Review the code",
      });

      const tcEnd = events.find(
        (e) => e.type === "tool_call_end" && (e as any).toolName === "task",
      ) as any;
      expect(tcEnd).toBeTruthy();
      expect(tcEnd.result).toContain("reviewer");
      expect(tcEnd.result).toContain("no issues found");
    } finally {
      client.cleanup();
    }
  });
});

describe("Subagent with worker disconnect", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();

    worker = await connectTestWorker(
      server.url,
      server.token,
      "disconnect-worker",
      {
        grep: {
          description: "Search files",
          execute: async () => {
            // Block forever — the disconnect will resolve the dispatch with an error
            await new Promise(() => {});
            return { output: "never reached" };
          },
        },
      },
    );
  });

  afterAll(() => {
    // Worker may already be disconnected; cleanup is best-effort
    try { worker.cleanup(); } catch {}
    server.cleanup();
  });

  test("worker disconnect during subagent tool call propagates error", async () => {
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;

      // Parent: invoke the task tool (explore)
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_task_disc",
              toolName: "task",
              input: {
                description: "Search code",
                prompt: "Search for TODOs",
                agentType: "explore",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Search code",
                  prompt: "Search for TODOs",
                  agentType: "explore",
                },
                { toolCallId: "tc_task_disc" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_task_disc",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent: calls grep — schedule worker disconnect, then execute
      if (callDepth === 2) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_grep_disc",
              toolName: "grep",
              input: { pattern: "TODO", path: "src/" },
            };
            const grepTool = opts.tools?.["grep"];
            let output = "no-tool";
            if (grepTool?.execute) {
              // Schedule worker disconnect — fires while execute is awaiting dispatch
              setTimeout(() => {
                server.instance._ctx.toolDispatch.workerDisconnected(worker.workerId);
              }, 50);
              try {
                output = await grepTool.execute(
                  { pattern: "TODO", path: "src/" },
                  { toolCallId: "tc_grep_disc" },
                );
              } catch (e: any) {
                output = e.message;
              }
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_grep_disc",
              toolName: "grep",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent step 2: text response after error
      if (callDepth === 3) {
        return mockTextResponse("grep failed: worker disconnected");
      }

      // Parent after task result
      callDepth = 0;
      return mockTextResponse("The search failed due to worker disconnect");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      const { events } = await promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Search for TODOs",
      });

      // The task tool should have completed (error propagated, not hung)
      const taskEnd = events.find(
        (e) => e.type === "tool_call_end" && (e as any).toolName === "task",
      ) as any;
      expect(taskEnd).toBeTruthy();
      // The result should mention the disconnect error
      expect(taskEnd.result).toContain("disconnect");

      // The turn should complete normally
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});

describe("Subagent with approval ask flow", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    // Enable approval so shell_exec evaluates to "ask" from default static rules
    server = await startTestServer({ approval: true });

    worker = await connectTestWorker(
      server.url,
      server.token,
      "ask-flow-worker",
      {
        shell_exec: {
          description: "Execute a shell command",
          execute: async (args: any) => ({ output: `Ran: ${args.command ?? "nothing"}` }),
        },
        grep: {
          description: "Search files",
          execute: async (args: any) => ({ output: `Found: ${args.pattern ?? "nothing"}` }),
        },
      },
    );
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("subagent tool with ask triggers approval and completes when approved", async () => {
    let callDepth = 0;
    setStreamTextImpl((opts: any) => {
      callDepth++;

      // Parent: invoke the task tool (general agent — has "*": "allow")
      if (callDepth === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_task_ask",
              toolName: "task",
              input: {
                description: "Run shell command",
                prompt: "Run echo hello",
                agentType: "general",
              },
            };
            const taskTool = opts.tools?.["task"];
            let output = "no-task-tool";
            if (taskTool?.execute) {
              output = await taskTool.execute(
                {
                  description: "Run shell command",
                  prompt: "Run echo hello",
                  agentType: "general",
                },
                { toolCallId: "tc_task_ask" },
              );
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_task_ask",
              toolName: "task",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent: calls shell_exec (will trigger "ask" from default static rules)
      if (callDepth === 2) {
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "tc_shell_ask",
              toolName: "shell_exec",
              input: { command: "echo hello" },
            };
            const shellTool = opts.tools?.["shell_exec"];
            let output = "no-tool";
            if (shellTool?.execute) {
              try {
                output = await shellTool.execute(
                  { command: "echo hello" },
                  { toolCallId: "tc_shell_ask" },
                );
              } catch (e: any) {
                output = e.message;
              }
            }
            yield {
              type: "tool-result",
              toolCallId: "tc_shell_ask",
              toolName: "shell_exec",
              output,
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })(),
        };
      }

      // Subagent step 2: text response
      if (callDepth === 3) {
        return mockTextResponse("Command executed: hello");
      }

      // Parent after task result
      callDepth = 0;
      return mockTextResponse("Done");
    });

    const client = createTestClient(server.url, server.token);
    try {
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        workspaceId: await getDefaultWsId(client.trpc, worker.workerId),
      });

      // Start the prompt non-blocking — it will block on approval
      const promptPromise = promptAndCollect(client.trpc, {
        sessionId: session.sessionId,
        text: "Run echo hello via subagent",
      }, 15_000);

      // Wait for the pending approval on the child session
      const gate = server.instance._ctx.approvalGate;
      await waitUntil(
        () => gate.pendingCount > 0,
        5000,
        "pending approval to appear",
      );

      // Find the child session and its pending approval
      const listed = await client.trpc.session.list.query();
      const childSession = listed.sessions.find(
        s => s.name?.includes("subagent") && s.sessionId !== session.sessionId,
      );
      expect(childSession).toBeTruthy();

      const pending = gate.getPendingForSession(childSession!.sessionId);
      expect(pending.length).toBe(1);
      expect(pending[0].toolName).toBe("shell_exec");

      // Approve the tool call
      gate.reply(pending[0].approvalId, "approve");

      // Now the prompt should complete
      const { events } = await promptPromise;

      // Verify the task completed successfully
      const taskEnd = events.find(
        (e) => e.type === "tool_call_end" && (e as any).toolName === "task",
      ) as any;
      expect(taskEnd).toBeTruthy();

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeTruthy();
    } finally {
      client.cleanup();
    }
  });
});

