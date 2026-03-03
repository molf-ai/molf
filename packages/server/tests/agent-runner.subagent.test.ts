import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { setStreamTextImpl } from "@molf-ai/test-utils/ai-mock-harness";
import { mockTextResponse, mockToolCallResponse } from "@molf-ai/test-utils";
import type { AgentEvent, WorkerAgentInfo } from "@molf-ai/protocol";

// Dynamic imports after mock.module
const {
  buildAgentSystemPrompt,
  AgentRunner,
} = await import("../src/agent-runner.js");
const { SessionManager } = await import("../src/session-mgr.js");
const { ConnectionRegistry } = await import("../src/connection-registry.js");
const { EventBus } = await import("../src/event-bus.js");
const { ToolDispatch } = await import("../src/tool-dispatch.js");
const { InlineMediaCache } = await import("../src/inline-media-cache.js");
const { ApprovalGate } = await import("../src/approval/approval-gate.js");
const { RulesetStorage } = await import("../src/approval/ruleset-storage.js");
const { resolveAgentTypes, DEFAULT_AGENTS } = await import("../src/subagent-types.js");

import type { WorkerRegistration } from "../src/connection-registry.js";

function makeWorker(overrides?: Partial<WorkerRegistration>): WorkerRegistration {
  return {
    role: "worker",
    id: "w1",
    name: "test-worker",
    connectedAt: Date.now(),
    tools: [],
    skills: [],
    agents: [],

    ...overrides,
  };
}

let tmp: TmpDir;
let env: EnvGuard;
let sessionMgr: InstanceType<typeof SessionManager>;
let connectionRegistry: InstanceType<typeof ConnectionRegistry>;
let eventBus: InstanceType<typeof EventBus>;
let toolDispatch: InstanceType<typeof ToolDispatch>;
let inlineMediaCache: InstanceType<typeof InlineMediaCache>;
let agentRunner: InstanceType<typeof AgentRunner>;
let approvalGate: InstanceType<typeof ApprovalGate>;

const WORKER_ID = crypto.randomUUID();

function collectEvents(sessionId: string): { events: AgentEvent[]; unsub: () => void } {
  const events: AgentEvent[] = [];
  const unsub = eventBus.subscribe(sessionId, (event) => events.push(event));
  return { events, unsub };
}

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");

  tmp = createTmpDir("molf-subagent-runner-");
  sessionMgr = new SessionManager(tmp.path);
  connectionRegistry = new ConnectionRegistry();
  eventBus = new EventBus();
  toolDispatch = new ToolDispatch();
  inlineMediaCache = new InlineMediaCache();
  const rulesetStorage = new RulesetStorage(tmp.path);
  approvalGate = new ApprovalGate(rulesetStorage, eventBus);
  agentRunner = new AgentRunner(
    sessionMgr, eventBus, connectionRegistry, toolDispatch,
    { provider: "gemini", model: "test" },
    inlineMediaCache, approvalGate,
  );

  connectionRegistry.registerWorker({
    id: WORKER_ID,
    name: "subagent-worker",
    connectedAt: Date.now(),
    tools: [{
      name: "echo",
      description: "Echo the input",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    skills: [],
    agents: [],

  });
});

afterAll(async () => {
  connectionRegistry.unregister(WORKER_ID);
  inlineMediaCache.close();
  await Bun.sleep(200);
  tmp.cleanup();
  env.restore();
});

// --- buildTaskTool tests ---

describe("buildTaskTool", () => {
  test("generates correct description with agent list", () => {
    const worker = makeWorker({ agents: [] });
    // Access private method via AgentRunner instance indirectly:
    // buildTaskTool is called by prepareAgentRun. We'll test via buildAgentSystemPrompt.
    // Actually, buildTaskTool is private. Test its effects instead:
    // When there are agents, the system prompt should include the task tool hint.
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("task");
  });

  test("system prompt includes task tool hint when agents available", () => {
    const worker = makeWorker({ agents: [] });
    const prompt = buildAgentSystemPrompt(worker);
    // Default agents (explore, general) are always available
    expect(prompt).toContain("task");
    expect(prompt).toContain("subagent");
  });

});

// --- runSubagent tests ---

describe("AgentRunner.runSubagent()", () => {
  test("creates child session with correct metadata", async () => {
    setStreamTextImpl(() => mockTextResponse("Subagent done"));

    const parentSession = await sessionMgr.create({
      name: "parent-session",
      workerId: WORKER_ID,
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
    });

    const clearSpy = spyOn(approvalGate, "clearSession");

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

    clearSpy.mockRestore();
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
    });

    // Monkey-patch the timeout constant by overriding setTimeout to speed up the test.
    // The real timeout is 5 minutes — we shorten it via a timer spy.
    const origSetTimeout = globalThis.setTimeout;
    const FAST_TIMEOUT = 50; // 50ms instead of 5 min
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        // Replace the 5-minute timeout with a short one
        const effectiveMs = ms && ms >= 60_000 ? FAST_TIMEOUT : ms;
        return origSetTimeout(fn, effectiveMs, ...args);
      }) as typeof setTimeout,
    );

    try {
      await expect(
        agentRunner.runSubagent({
          parentSessionId: parentSession.sessionId,
          workerId: WORKER_ID,
          agentType: "explore",
          prompt: "test",
        }),
      ).rejects.toThrow("Subagent timeout");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("sets agent permission on approval gate for child session", async () => {
    setStreamTextImpl(() => mockTextResponse("Done"));

    const parentSession = await sessionMgr.create({
      name: "parent-permission",
      workerId: WORKER_ID,
    });

    const setSpy = spyOn(approvalGate, "setAgentPermission");

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

    setSpy.mockRestore();
  });
});

// --- approval event forwarding ---

describe("subagent approval event forwarding", () => {
  const APPROVAL_WORKER_ID = crypto.randomUUID();

  test("forwards tool_approval_required from child session to parent session", async () => {
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
    const dispatchSpy = spyOn(toolDispatch, "dispatch").mockResolvedValue({
      output: "file1.txt",
    });

    const parentSession = await sessionMgr.create({
      name: "parent-approval-fwd",
      workerId: APPROVAL_WORKER_ID,
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

    // Approve it so the subagent can complete
    approvalGate.reply(wrapper.event.approvalId, "once");

    const { result } = await subagentPromise;
    expect(result).toBe("Done");

    dispatchSpy.mockRestore();
    connectionRegistry.unregister(APPROVAL_WORKER_ID);
  });
});

// --- buildAgentSystemPrompt with agents ---

describe("buildAgentSystemPrompt with agents", () => {
  test("includes task hint when agents are available", () => {
    const worker = makeWorker({
      agents: [{ name: "custom", description: "Custom", content: "Body" }],
    });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("task");
  });

  test("includes task hint for default agents (no worker agents)", () => {
    const worker = makeWorker({ agents: [] });
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("task");
  });

});
