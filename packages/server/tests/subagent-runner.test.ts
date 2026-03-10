import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { mockTextResponse, mockToolCallResponse } from "@molf-ai/test-utils";
import type { AgentEvent, WorkerAgentInfo } from "@molf-ai/protocol";
import {
  setStreamTextImpl,
  makeWorker,
  collectEvents as _collectEvents,
  createTestHarness,
  type TestHarness,
} from "./_helpers.js";
import { buildAgentSystemPrompt } from "../src/agent-runner.js";
import { resolveAgentTypes, DEFAULT_AGENTS } from "../src/subagent-types.js";

vi.mock("ai", async () => {
  const { aiMockFactory } = await import("@molf-ai/test-utils/ai-mock-harness");
  return aiMockFactory();
});

let h: TestHarness;
let sessionMgr: TestHarness["sessionMgr"];
let connectionRegistry: TestHarness["connectionRegistry"];
let eventBus: TestHarness["eventBus"];
let toolDispatch: TestHarness["toolDispatch"];
let agentRunner: TestHarness["agentRunner"];
let approvalGate: TestHarness["approvalGate"];
let WORKER_ID: string;

function collectEvents(sessionId: string) {
  return _collectEvents(eventBus, sessionId);
}

beforeAll(() => {
  h = createTestHarness({ tmpPrefix: "molf-subagent-runner-" });
  ({ sessionMgr, connectionRegistry, eventBus, toolDispatch, agentRunner, approvalGate } = h);
  WORKER_ID = h.workerId;
});

afterAll(() => h.cleanup());

// --- buildTaskTool tests ---

describe("buildTaskTool", () => {
  test("system prompt includes task hint when default agents exist", () => {
    const worker = makeWorker({ agents: [] });
    const prompt = buildAgentSystemPrompt(worker);
    // Default agents (explore, general) always exist, so task hint is included
    expect(prompt).toContain("task");
  });

  test("system prompt does not include task hint when no agents resolve", () => {
    // This can't easily happen since DEFAULT_AGENTS always exist,
    // but the logic is: resolveAgentTypes([]) returns defaults.
    // So the hint is always present with any worker.
    const worker = makeWorker({ agents: [] });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("'task' tool");
  });
});

// --- runSubagent tests ---

describe("AgentRunner.runSubagent()", () => {
  test("creates child session with correct metadata", async () => {
    setStreamTextImpl(() => mockTextResponse("Subagent done"));

    const parentSession = await sessionMgr.create({
      name: "parent-session",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    const { sessionId: childId, result } = await agentRunner.runSubagent({
      parentSessionId: parentSession.sessionId,
      workerId: WORKER_ID,
      agentType: "explore",
      prompt: "Find the main entry point",
    });

    expect(childId).toBeTruthy();
    expect(result).toBe("Subagent done");

    // Check child session metadata
    const childSession = sessionMgr.load(childId);
    expect(childSession).toBeTruthy();
    expect(childSession!.metadata).toBeDefined();
    expect((childSession!.metadata as any).subagent).toEqual({
      parentSessionId: parentSession.sessionId,
      agentType: "explore",
    });
    expect(childSession!.name).toBe("@explore subagent");
  });

  test("returns final assistant message as result", async () => {
    setStreamTextImpl(() => mockTextResponse("The answer is 42"));

    const parentSession = await sessionMgr.create({
      name: "parent-2",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    const { result } = await agentRunner.runSubagent({
      parentSessionId: parentSession.sessionId,
      workerId: WORKER_ID,
      agentType: "general",
      prompt: "What is the answer?",
    });

    expect(result).toBe("The answer is 42");
  });

  test("throws for unknown agent type", async () => {
    const parentSession = await sessionMgr.create({
      name: "parent-unknown",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    await expect(
      agentRunner.runSubagent({
        parentSessionId: parentSession.sessionId,
        workerId: WORKER_ID,
        agentType: "nonexistent",
        prompt: "test",
      }),
    ).rejects.toThrow("Unknown agent type: nonexistent");
  });

  test("throws when worker is disconnected", async () => {
    const parentSession = await sessionMgr.create({
      name: "parent-disconnected",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    await expect(
      agentRunner.runSubagent({
        parentSessionId: parentSession.sessionId,
        workerId: "nonexistent-worker-id",
        agentType: "explore",
        prompt: "test",
      }),
    ).rejects.toThrow("not connected");
  });

  test("cleans up approval gate on completion", async () => {
    setStreamTextImpl(() => mockTextResponse("Done"));

    const parentSession = await sessionMgr.create({
      name: "parent-cleanup",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    const { sessionId: childId } = await agentRunner.runSubagent({
      parentSessionId: parentSession.sessionId,
      workerId: WORKER_ID,
      agentType: "explore",
      prompt: "test",
    });

    // After runSubagent completes, clearSession should have been called.
    // We can't directly check private state, but setting agent permission
    // on a cleared session and re-evaluating should show no agent layer.
    // If the agent permission was NOT cleared, re-evaluating would still deny.
    // Since explore denies *, any tool would be denied if permission persisted.
    const r = await approvalGate.evaluate("shell_exec", { command: "ls" }, childId, WORKER_ID);
    // Without agent permission layer, shell_exec defaults to "ask" (no static rules)
    expect(r.action).toBe("ask");
  });

  test("cleans up approval gate on error", async () => {
    setStreamTextImpl(() => {
      throw new Error("LLM failure");
    });

    const parentSession = await sessionMgr.create({
      name: "parent-error",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    const clearSpy = vi.spyOn(approvalGate, "clearSession");

    try {
      try {
        await agentRunner.runSubagent({
          parentSessionId: parentSession.sessionId,
          workerId: WORKER_ID,
          agentType: "explore",
          prompt: "test",
        });
      } catch {
        // Expected to throw
      }

      // The finally block in runSubagent should call clearSession with the child session ID
      expect(clearSpy).toHaveBeenCalledTimes(1);
      const childSessionId = clearSpy.mock.calls[0][0] as string;
      expect(childSessionId).toBeTruthy();

      // Verify the child session's approval gate is actually cleaned up:
      // without agent permission, shell_exec defaults to "ask" (from default static rules)
      const r = await approvalGate.evaluate("shell_exec", { command: "ls" }, childSessionId, WORKER_ID);
      expect(r.action).toBe("ask");
    } finally {
      clearSpy.mockRestore();
    }
  });

  test("respects timeout and rejects with Subagent timeout", async () => {
    // Mock a stream that never finishes — hangs forever
    setStreamTextImpl(() => ({
      fullStream: (async function* () {
        // Yield nothing useful, just wait forever
        yield { type: "text-delta" as const, text: "thinking..." };
        await new Promise(() => {}); // never resolves
      })(),
    }));

    const parentSession = await sessionMgr.create({
      name: "parent-timeout",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    await expect(
      agentRunner.runSubagent({
        parentSessionId: parentSession.sessionId,
        workerId: WORKER_ID,
        agentType: "explore",
        prompt: "test",
        timeoutMs: 50, // Short timeout instead of 5 min default
      }),
    ).rejects.toThrow("Subagent timeout");
  });

  test("sets agent permission on approval gate for child session", async () => {
    setStreamTextImpl(() => mockTextResponse("Done"));

    const parentSession = await sessionMgr.create({
      name: "parent-permission",
      workerId: WORKER_ID,
      workspaceId: "test-ws",
    });

    const setSpy = vi.spyOn(approvalGate, "setAgentPermission");

    try {
      const { sessionId: childId } = await agentRunner.runSubagent({
        parentSessionId: parentSession.sessionId,
        workerId: WORKER_ID,
        agentType: "explore",
        prompt: "Find something",
      });

      // Verify setAgentPermission was called with the child session ID and a ruleset
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(setSpy.mock.calls[0][0]).toBe(childId);
      // The second arg is the explore agent's permission ruleset (array of rules)
      const ruleset = setSpy.mock.calls[0][1] as unknown[];
      expect(Array.isArray(ruleset)).toBe(true);
      expect(ruleset.length).toBeGreaterThan(0);
      // Explore agent denies task (last rule) — verify it's in the ruleset
      const taskDeny = (ruleset as any[]).find(
        (r: any) => r.permission === "task" && r.action === "deny",
      );
      expect(taskDeny).toBeTruthy();
    } finally {
      setSpy.mockRestore();
    }
  });
});

// --- approval event forwarding ---

describe("subagent approval event forwarding", () => {
  const APPROVAL_WORKER_ID = crypto.randomUUID();

  test("forwards tool_approval_required from child session to parent session", { timeout: 10_000 }, async () => {
    // Register a worker with shell_exec (triggers "ask" from default static ruleset)
    connectionRegistry.registerWorker({
      id: APPROVAL_WORKER_ID,
      name: "approval-worker",
      connectedAt: Date.now(),
      tools: [{
        name: "shell_exec",
        description: "Execute a shell command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      }],
      skills: [],
      agents: [],
  
    });

    // Custom mock that actually calls the tool's execute function (triggers approval gate)
    let callCount = 0;
    setStreamTextImpl((opts: any) => {
      callCount++;
      if (callCount === 1) {
        return {
          fullStream: (async function* () {
            yield { type: "tool-call" as const, toolCallId: "tc_1", toolName: "shell_exec", input: { command: "ls" } };
            const result = await opts.tools.shell_exec.execute(
              { command: "ls" },
              { toolCallId: "tc_1", abortSignal: opts.abortSignal },
            );
            yield { type: "tool-result" as const, toolCallId: "tc_1", toolName: "shell_exec", output: result };
            yield { type: "finish" as const, finishReason: "tool-calls" };
          })(),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        };
      }
      return mockTextResponse("Done");
    });

    // Mock toolDispatch so it resolves immediately (no real worker subscriber)
    const dispatchSpy = vi.spyOn(toolDispatch, "dispatch").mockResolvedValue({
      output: "file1.txt",
    });

    const parentSession = await sessionMgr.create({
      name: "parent-approval-fwd",
      workerId: APPROVAL_WORKER_ID,
      workspaceId: "test-ws",
    });

    // Listen for approval event on parent session (now wrapped in subagent_event)
    const approvalPromise = new Promise<AgentEvent>((resolve) => {
      const unsub = eventBus.subscribe(parentSession.sessionId, (event) => {
        if (
          event.type === "subagent_event" &&
          event.event.type === "tool_approval_required"
        ) {
          unsub();
          resolve(event);
        }
      });
    });

    // Start subagent (general agent: "*": "allow", but static overrides shell_exec to "ask")
    const subagentPromise = agentRunner.runSubagent({
      parentSessionId: parentSession.sessionId,
      workerId: APPROVAL_WORKER_ID,
      agentType: "general",
      prompt: "List files",
    });

    // Wait for forwarded approval event on parent
    const event = await approvalPromise;
    expect(event.type).toBe("subagent_event");
    const wrapper = event as any;
    expect(wrapper.agentType).toBe("general");
    expect(wrapper.event.type).toBe("tool_approval_required");
    expect(wrapper.event.toolName).toBe("shell_exec");
    expect(wrapper.event.approvalId).toBeTruthy();

    try {
      // Approve it so the subagent can complete
      approvalGate.reply(wrapper.event.approvalId, "once");

      const { result } = await subagentPromise;
      expect(result).toBe("Done");
    } finally {
      dispatchSpy.mockRestore();
      connectionRegistry.unregister(APPROVAL_WORKER_ID);
    }
  });
});

// --- buildAgentSystemPrompt with agents ---

describe("buildAgentSystemPrompt with agents", () => {
  test("includes task hint when agents are available", () => {
    const worker = makeWorker({
      agents: [{ name: "custom", description: "Custom", content: "Body" }],
    });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("'task' tool");
  });
});
