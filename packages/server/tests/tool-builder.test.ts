import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { makeWorker, EventBus, ApprovalGate, RulesetStorage } from "./_helpers.js";
import type { AgentEvent } from "@molf-ai/protocol";

const { buildSkillTool, raceAbort } = await import("../src/tool-builder.js");

let tmp: TmpDir;
let env: EnvGuard;
let eventBus: InstanceType<typeof EventBus>;
let approvalGate: InstanceType<typeof ApprovalGate>;
const WORKER_ID = crypto.randomUUID();

beforeAll(() => {
  env = createEnvGuard();
  env.set("GEMINI_API_KEY", "test-key");
  tmp = createTmpDir("molf-tool-builder-");
  eventBus = new EventBus();
  const rulesetStorage = new RulesetStorage(tmp.path);
  approvalGate = new ApprovalGate(rulesetStorage, eventBus);
});

afterAll(() => {
  tmp.cleanup();
  env.restore();
});

describe("raceAbort", () => {
  test("resolves normally when no signal is provided", async () => {
    await expect(raceAbort(Promise.resolve(), undefined)).resolves.toBeUndefined();
  });

  test("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(raceAbort(Promise.resolve(), ac.signal)).rejects.toThrow("Aborted");
  });

  test("resolves when promise settles before abort", async () => {
    const ac = new AbortController();
    await expect(raceAbort(Promise.resolve(), ac.signal)).resolves.toBeUndefined();
    // Signal never fired — no lingering listener
  });

  test("rejects when signal fires before promise settles", async () => {
    const ac = new AbortController();
    const neverResolves = new Promise<void>(() => {});
    const p = raceAbort(neverResolves, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("Aborted");
  });

  test("removes abort listener after promise settles", async () => {
    const ac = new AbortController();
    // Spy on removeEventListener to confirm cleanup
    let removeCalled = false;
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = (...args: Parameters<typeof origRemove>) => {
      removeCalled = true;
      return origRemove(...args);
    };

    await raceAbort(Promise.resolve(), ac.signal);
    // Give microtask queue a tick for finally() to run
    await new Promise((r) => setTimeout(r, 0));
    expect(removeCalled).toBe(true);
  });
});

describe("buildSkillTool", () => {
  test("with skills returns tool def", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy app", content: "Deploy instructions" }],
    });
    const result = buildSkillTool(worker, approvalGate, "test-session", WORKER_ID);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("skill");
  });

  test("without skills returns null", () => {
    const worker = makeWorker();
    expect(buildSkillTool(worker, approvalGate, "test-session", WORKER_ID)).toBeNull();
  });

  test("execute with unknown skill returns error after approval", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy", content: "..." }],
    });
    const sessionId = "skill-unknown-test";
    const result = buildSkillTool(worker, approvalGate, sessionId, WORKER_ID);

    // Skill approval defaults to "ask", so auto-approve in background
    const events: AgentEvent[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    const execPromise = result!.toolDef.execute!({ name: "unknown" } as any, { toolCallId: "tc1", abortSignal: undefined } as any);

    // Wait for approval event then approve
    await new Promise<void>((resolve) => {
      const check = () => {
        const ev = events.find((e) => e.type === "tool_approval_required");
        if (ev) {
          const approvalId = (ev as any).approvalId;
          approvalGate.reply(approvalId, "once");
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const execResult = await execPromise;
    expect((execResult as any).error).toContain("Unknown skill");
    unsub();
  });

  test("execute returns content after approval", async () => {
    const worker = makeWorker({
      skills: [{ name: "deploy", description: "Deploy app", content: "Deploy instructions" }],
    });
    const sessionId = "skill-approve-test";
    const result = buildSkillTool(worker, approvalGate, sessionId, WORKER_ID);

    const events: AgentEvent[] = [];
    const unsub = eventBus.subscribe(sessionId, (e) => events.push(e));

    const execPromise = result!.toolDef.execute!({ name: "deploy" } as any, { toolCallId: "tc2", abortSignal: undefined } as any);

    // Wait for approval event then approve
    await new Promise<void>((resolve) => {
      const check = () => {
        const ev = events.find((e) => e.type === "tool_approval_required");
        if (ev) {
          const approvalId = (ev as any).approvalId;
          approvalGate.reply(approvalId, "once");
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const execResult = await execPromise;
    expect((execResult as any).content).toBe("Deploy instructions");
    unsub();
  });
});
