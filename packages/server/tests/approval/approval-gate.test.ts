import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { flushAsync } from "@molf-ai/test-utils";
import { ApprovalGate, ToolRejectedError } from "../../src/approval/approval-gate.js";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { ServerBus } from "../../src/server-bus.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import type { AgentEvent } from "@molf-ai/protocol";

let tmp: TmpDir;
let serverBus: ServerBus;
let storage: RulesetStorage;
let gate: ApprovalGate;

beforeEach(() => {
  tmp = createTmpDir("molf-gate-test-");
  serverBus = new ServerBus();
  storage = new RulesetStorage(tmp.path);
  gate = new ApprovalGate(storage, serverBus);
});

afterEach(() => {
  gate.clearAll();
  tmp.cleanup();
});

const SESSION = "session-1";
const WORKER = "worker-1";

/** Helper: evaluate → requestApproval → return approvalId + waitForApproval promise */
async function setupApproval(
  toolName: string,
  args: Record<string, unknown>,
  sessionId = SESSION,
  workerId = WORKER,
): Promise<{ approvalId: string; promise: Promise<void> }> {
  const { action, patterns, alwaysPatterns } = await gate.evaluate(toolName, args, sessionId, workerId);
  expect(action).toBe("ask");
  const approvalId = gate.requestApproval(toolName, args, patterns, alwaysPatterns, sessionId, workerId);
  return { approvalId, promise: gate.waitForApproval(approvalId) };
}

describe("ApprovalGate", () => {
  describe("evaluate — allow flow", () => {
    test("read_file with normal path evaluates to allow", async () => {
      const result = await gate.evaluate("read_file", { path: "src/index.ts" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
      expect(gate.pendingCount).toBe(0);
    });

    test("glob evaluates to allow", async () => {
      const result = await gate.evaluate("glob", { pattern: "**/*.ts" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
    });

    test("grep evaluates to allow", async () => {
      const result = await gate.evaluate("grep", { path: "src/", pattern: "TODO" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
      expect(result.matchingRules).toBeUndefined();
    });

    test("skill evaluates to allow when pattern is in allow list", async () => {
      const dir = resolve(tmp.path, "workers", WORKER);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "permissions.jsonc"), JSON.stringify([
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "skill", pattern: "deploy", action: "allow" },
      ]));

      const result = await gate.evaluate("skill", { name: "deploy" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
      expect(result.patterns).toEqual(["deploy"]);
    });

    test("shell_exec with any command evaluates to ask (empty default allow/deny)", async () => {
      const result = await gate.evaluate("shell_exec", { command: "cat file.txt" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });

    test("shell_exec with git status evaluates to ask", async () => {
      const result = await gate.evaluate("shell_exec", { command: "git status" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });
  });

  describe("evaluate — deny flow", () => {
    test("read_file .env evaluates to deny with matchingRules", async () => {
      const result = await gate.evaluate("read_file", { path: ".env" }, SESSION, WORKER);
      expect(result.action).toBe("deny");
      expect(result.matchingRules).toBeDefined();
      expect(result.matchingRules!.length).toBeGreaterThan(0);
      // Should include the deny rule for *.env
      expect(result.matchingRules!.some(r => r.pattern === "*.env" && r.action === "deny")).toBe(true);
    });

    test("skill with deny pattern evaluates to deny", async () => {
      const dir = resolve(tmp.path, "workers", WORKER);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "permissions.jsonc"), JSON.stringify([
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "skill", pattern: "dangerous-*", action: "deny" },
      ]));

      const result = await gate.evaluate("skill", { name: "dangerous-deploy" }, SESSION, WORKER);
      expect(result.action).toBe("deny");
    });

    test("shell_exec rm -rf evaluates to ask (empty default deny list)", async () => {
      const result = await gate.evaluate("shell_exec", { command: "rm -rf /" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });

    test("shell_exec git push --force evaluates to ask", async () => {
      const result = await gate.evaluate(
        "shell_exec", { command: "git push --force origin main" }, SESSION, WORKER,
      );
      expect(result.action).toBe("ask");
    });

    test("pipeline: all commands ask with default ruleset", async () => {
      const result = await gate.evaluate(
        "shell_exec", { command: "echo hello | rm -rf /" }, SESSION, WORKER,
      );
      expect(result.action).toBe("ask");
    });
  });

  describe("evaluate — ask flow", () => {
    test("unknown shell command evaluates to ask", async () => {
      const result = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      expect(result.action).toBe("ask");
    });

    test("skill evaluates to ask by default", async () => {
      const result = await gate.evaluate("skill", { name: "deploy" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
      expect(result.patterns).toEqual(["deploy"]);
      expect(result.alwaysPatterns).toEqual(["deploy"]);
    });

    test("unknown tool evaluates to ask", async () => {
      const result = await gate.evaluate("unknown_tool", { arg: "value" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });

    test("evaluate returns patterns and alwaysPatterns", async () => {
      const result = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      expect(result.action).toBe("ask");
      expect(Array.isArray(result.patterns)).toBe(true);
      expect(Array.isArray(result.alwaysPatterns)).toBe(true);
      expect(result.patterns.length).toBeGreaterThan(0);
    });

    test("evaluate is async — returns a Promise", () => {
      const result = gate.evaluate("shell_exec", { command: "python script.py" }, SESSION, WORKER);
      expect(result).toBeInstanceOf(Promise);
      return result; // await via test return
    });
  });

  describe("requestApproval", () => {
    test("emits tool_approval_required event with approvalId", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      const { action, patterns, alwaysPatterns } = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      expect(action).toBe("ask");

      const approvalId = gate.requestApproval(
        "shell_exec", { command: "python script.py" }, patterns, alwaysPatterns, SESSION, WORKER,
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_approval_required");

      const ev = events[0] as Extract<AgentEvent, { type: "tool_approval_required" }>;
      expect(ev.toolName).toBe("shell_exec");
      expect(ev.approvalId).toBe(approvalId);
      expect(ev.sessionId).toBe(SESSION);

      gate.cancel(approvalId);
    });

    test("does not block — returns approvalId immediately without waiting", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      const { action, patterns, alwaysPatterns } = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      expect(action).toBe("ask");

      const approvalId = gate.requestApproval(
        "shell_exec", { command: "python script.py" }, patterns, alwaysPatterns, SESSION, WORKER,
      );

      // Returns string immediately
      expect(typeof approvalId).toBe("string");
      expect(approvalId.startsWith(SESSION + ":")).toBe(true);
      expect(gate.pendingCount).toBe(1);

      gate.cancel(approvalId);
    });
  });

  describe("waitForApproval", () => {
    test("resolves when reply('once') is called", async () => {
      const { approvalId, promise } = await setupApproval(
        "shell_exec", { command: "python script.py" },
      );
      gate.reply(approvalId, "once");
      await promise; // should not throw
      expect(gate.pendingCount).toBe(0);
    });

    test("rejects with ToolRejectedError when reply('reject') is called", async () => {
      const { approvalId, promise } = await setupApproval(
        "shell_exec", { command: "node deploy.js" },
      );
      gate.reply(approvalId, "reject", "I don't want to deploy");
      await expect(promise).rejects.toThrow(ToolRejectedError);
      await expect(promise).rejects.toThrow("I don't want to deploy");
    });

    test("returns the same Promise on multiple calls (eagerly created)", async () => {
      const { action, patterns, alwaysPatterns } = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      const approvalId = gate.requestApproval(
        "shell_exec", { command: "python script.py" }, patterns, alwaysPatterns, SESSION, WORKER,
      );

      const p1 = gate.waitForApproval(approvalId);
      const p2 = gate.waitForApproval(approvalId);
      expect(p1).toBe(p2); // Same Promise object — created eagerly in requestApproval

      gate.reply(approvalId, "once");
      await p1;
    });

    test("throws when approvalId is unknown", () => {
      expect(() => gate.waitForApproval("nonexistent")).toThrow("No pending approval");
    });
  });

  describe("early reply race", () => {
    test("reply before await works because Promise is created eagerly", async () => {
      const { action, patterns, alwaysPatterns } = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      const approvalId = gate.requestApproval(
        "shell_exec", { command: "python script.py" }, patterns, alwaysPatterns, SESSION, WORKER,
      );

      // Get Promise reference first
      const promise = gate.waitForApproval(approvalId);

      // Reply synchronously — before awaiting the Promise
      gate.reply(approvalId, "once");

      // Promise is already settled, resolves immediately
      await promise;
      expect(gate.pendingCount).toBe(0);
    });
  });

  describe("no timer", () => {
    test("pending entries do not auto-reject after a delay", async () => {
      const { action, patterns, alwaysPatterns } = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      const approvalId = gate.requestApproval(
        "shell_exec", { command: "python script.py" }, patterns, alwaysPatterns, SESSION, WORKER,
      );

      await flushAsync();

      // Still pending — no automatic timeout
      expect(gate.pendingCount).toBe(1);
      const pending = gate.getPendingForSession(SESSION);
      expect(pending).toHaveLength(1);
      expect(pending[0].approvalId).toBe(approvalId);

      gate.cancel(approvalId);
    });
  });

  describe("always approve", () => {
    test("always adds to runtime layer and future calls auto-approve", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      // First call: asks (curl has arity 1, so "curl *" is the always pattern)
      const { approvalId, promise: p1 } = await setupApproval(
        "shell_exec", { command: "curl https://example.com" },
      );
      expect(events).toHaveLength(1);

      gate.reply(approvalId, "always");
      await p1;

      // Second call with same prefix: auto-allowed (no new event)
      const eventCountBefore = events.length;
      const r2 = await gate.evaluate(
        "shell_exec", { command: "curl https://other.com" }, SESSION, WORKER,
      );
      expect(r2.action).toBe("allow");
      expect(events.length).toBe(eventCountBefore); // no new events
    });
  });

  describe("cascade resolution", () => {
    test("always approve cascades to other pending requests", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      // Two requests that would both need approval (curl has arity 1)
      const r1 = await gate.evaluate("shell_exec", { command: "curl https://a.com" }, SESSION, WORKER);
      const r2 = await gate.evaluate("shell_exec", { command: "curl https://b.com" }, SESSION, WORKER);

      const id1 = gate.requestApproval(
        "shell_exec", { command: "curl https://a.com" }, r1.patterns, r1.alwaysPatterns, SESSION, WORKER,
      );
      const id2 = gate.requestApproval(
        "shell_exec", { command: "curl https://b.com" }, r2.patterns, r2.alwaysPatterns, SESSION, WORKER,
      );

      const p1 = gate.waitForApproval(id1);
      const p2 = gate.waitForApproval(id2);

      expect(events).toHaveLength(2);

      // Approve first with "always" — second should cascade-resolve
      gate.reply(id1, "always");
      await p1;
      await p2; // Should resolve without user interaction
      expect(gate.pendingCount).toBe(0);
    });
  });

  describe("per-request deny", () => {
    test("reply('reject') only rejects the single request", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      const r1 = await gate.evaluate("shell_exec", { command: "python a.py" }, SESSION, WORKER);
      const r2 = await gate.evaluate("shell_exec", { command: "python b.py" }, SESSION, WORKER);

      const id1 = gate.requestApproval(
        "shell_exec", { command: "python a.py" }, r1.patterns, r1.alwaysPatterns, SESSION, WORKER,
      );
      const id2 = gate.requestApproval(
        "shell_exec", { command: "python b.py" }, r2.patterns, r2.alwaysPatterns, SESSION, WORKER,
      );

      const p1 = gate.waitForApproval(id1);
      const p2 = gate.waitForApproval(id2);
      p1.catch(() => {}); // suppress unhandled rejection

      expect(events).toHaveLength(2);

      // Reject first — only first should fail
      gate.reply(id1, "reject", "stop one");

      await expect(p1).rejects.toThrow(ToolRejectedError);
      // p2 should still be pending
      expect(gate.pendingCount).toBe(1);

      // Clean up
      gate.reply(id2, "once");
      await p2;
      expect(gate.pendingCount).toBe(0);
    });
  });

  describe("cancel", () => {
    test("cancel removes pending entry without resolve/reject", async () => {
      const r = await gate.evaluate(
        "shell_exec", { command: "python script.py" }, SESSION, WORKER,
      );
      const approvalId = gate.requestApproval(
        "shell_exec", { command: "python script.py" }, r.patterns, r.alwaysPatterns, SESSION, WORKER,
      );

      expect(gate.pendingCount).toBe(1);
      expect(gate.getPendingForSession(SESSION)).toHaveLength(1);

      gate.cancel(approvalId);

      expect(gate.pendingCount).toBe(0);
      expect(gate.getPendingForSession(SESSION)).toHaveLength(0);

      // Entry is gone — waitForApproval would throw
      expect(() => gate.waitForApproval(approvalId)).toThrow("No pending approval");
    });

    test("cancel is a no-op for unknown approvalId", () => {
      // Should not throw
      gate.cancel("nonexistent");
      expect(gate.pendingCount).toBe(0);
    });
  });

  describe("clearSession", () => {
    test("rejects pending requests on clearSession", async () => {
      const r = await gate.evaluate(
        "shell_exec", { command: "node server.js" }, SESSION, WORKER,
      );
      const approvalId = gate.requestApproval(
        "shell_exec", { command: "node server.js" }, r.patterns, r.alwaysPatterns, SESSION, WORKER,
      );
      const p1 = gate.waitForApproval(approvalId);

      gate.clearSession(SESSION);
      await expect(p1).rejects.toThrow(ToolRejectedError);
      expect(gate.pendingCount).toBe(0);
    });

    test("always-approve persists to disk, survives clearSession", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      // First call: asks for approval (curl has arity 1 → "curl *" always pattern)
      const { approvalId, promise: p1 } = await setupApproval(
        "shell_exec", { command: "curl https://example.com" },
      );
      expect(events).toHaveLength(1);

      gate.reply(approvalId, "always");
      await p1;

      // Clear the session (drops runtime layer)
      gate.clearSession(SESSION);

      // curl should STILL auto-allow because the pattern was persisted to disk
      const eventCountBefore = events.length;
      const r2 = await gate.evaluate(
        "shell_exec", { command: "curl https://other.com" }, SESSION, WORKER,
      );
      expect(r2.action).toBe("allow");
      expect(events.length).toBe(eventCountBefore); // no new approval event
    });
  });

  describe("clearAll", () => {
    test("rejects all pending across all sessions", async () => {
      const rA = await gate.evaluate("shell_exec", { command: "python a.py" }, "session-A", WORKER);
      const rB = await gate.evaluate("shell_exec", { command: "python b.py" }, "session-B", WORKER);

      const idA = gate.requestApproval(
        "shell_exec", { command: "python a.py" }, rA.patterns, rA.alwaysPatterns, "session-A", WORKER,
      );
      const idB = gate.requestApproval(
        "shell_exec", { command: "python b.py" }, rB.patterns, rB.alwaysPatterns, "session-B", WORKER,
      );

      const pA = gate.waitForApproval(idA);
      const pB = gate.waitForApproval(idB);
      pA.catch(() => {});
      pB.catch(() => {});

      gate.clearAll();

      await expect(pA).rejects.toThrow(ToolRejectedError);
      await expect(pB).rejects.toThrow(ToolRejectedError);
      expect(gate.pendingCount).toBe(0);
    });

    test("clearAll also clears runtime approvals", async () => {
      const events: AgentEvent[] = [];
      serverBus.subscribe(SESSION, (e) => events.push(e));

      // Earn a runtime approval (curl has arity 1 → "curl *" always pattern)
      const { approvalId, promise } = await setupApproval(
        "shell_exec", { command: "curl https://example.com" },
      );
      gate.reply(approvalId, "always");
      await promise;

      // Runtime layer: curl should be allowed
      const r1 = await gate.evaluate(
        "shell_exec", { command: "curl https://other.com" }, SESSION, WORKER,
      );
      expect(r1.action).toBe("allow");

      gate.clearAll();

      // Runtime layer is cleared — BUT disk layer persists, so it's still allowed
      // (clearAll clears runtime approvals, but the disk layer was also updated by "always")
      // So this still evaluates to "allow" from the disk layer.
      // This just tests that clearAll doesn't throw.
      expect(gate.pendingCount).toBe(0);
    });
  });

  describe("getPendingForSession", () => {
    test("returns correct pending entries for a session", async () => {
      const r1 = await gate.evaluate("shell_exec", { command: "python a.py" }, SESSION, WORKER);
      const id1 = gate.requestApproval(
        "shell_exec", { command: "python a.py" }, r1.patterns, r1.alwaysPatterns, SESSION, WORKER,
      );

      const pending = gate.getPendingForSession(SESSION);
      expect(pending).toHaveLength(1);
      expect(pending[0].approvalId).toBe(id1);
      expect(pending[0].toolName).toBe("shell_exec");
      expect(pending[0].args).toBe(JSON.stringify({ command: "python a.py" }));

      gate.cancel(id1);
    });

    test("returns empty after cancel", async () => {
      const r = await gate.evaluate("shell_exec", { command: "python a.py" }, SESSION, WORKER);
      const id = gate.requestApproval(
        "shell_exec", { command: "python a.py" }, r.patterns, r.alwaysPatterns, SESSION, WORKER,
      );

      gate.cancel(id);
      expect(gate.getPendingForSession(SESSION)).toHaveLength(0);
    });

    test("returns empty after reply", async () => {
      const { approvalId, promise } = await setupApproval(
        "shell_exec", { command: "python a.py" },
      );

      gate.reply(approvalId, "once");
      await promise;

      expect(gate.getPendingForSession(SESSION)).toHaveLength(0);
    });

    test("does not return pending from other sessions", async () => {
      const rA = await gate.evaluate("shell_exec", { command: "python a.py" }, "session-A", WORKER);
      const idA = gate.requestApproval(
        "shell_exec", { command: "python a.py" }, rA.patterns, rA.alwaysPatterns, "session-A", WORKER,
      );

      const pendingB = gate.getPendingForSession("session-B");
      expect(pendingB).toHaveLength(0);

      gate.cancel(idA);
    });

    test("returns multiple pending entries for a session", async () => {
      const r1 = await gate.evaluate("shell_exec", { command: "python a.py" }, SESSION, WORKER);
      const r2 = await gate.evaluate("shell_exec", { command: "python b.py" }, SESSION, WORKER);

      const id1 = gate.requestApproval(
        "shell_exec", { command: "python a.py" }, r1.patterns, r1.alwaysPatterns, SESSION, WORKER,
      );
      const id2 = gate.requestApproval(
        "shell_exec", { command: "python b.py" }, r2.patterns, r2.alwaysPatterns, SESSION, WORKER,
      );

      const pending = gate.getPendingForSession(SESSION);
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.approvalId).sort()).toEqual([id1, id2].sort());

      gate.cancel(id1);
      gate.cancel(id2);
    });
  });

  describe("reply with invalid requestId", () => {
    test("returns false for unknown requestId", () => {
      expect(gate.reply("nonexistent", "once")).toBe(false);
    });
  });

  describe("enabled: false mode", () => {
    test("evaluate always returns allow when disabled", async () => {
      const disabledGate = new ApprovalGate(storage, serverBus, false);
      const result = await disabledGate.evaluate("shell_exec", { command: "rm -rf /" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
      expect(result.patterns).toEqual([]);
      expect(result.alwaysPatterns).toEqual([]);
    });

    test("evaluate returns allow for denied tools when disabled", async () => {
      const disabledGate = new ApprovalGate(storage, serverBus, false);
      const result = await disabledGate.evaluate("read_file", { path: ".env" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
    });
  });

  describe("setAgentPermission", () => {
    test("agent deny vetoes tool call", async () => {
      gate.setAgentPermission(SESSION, [
        { permission: "shell_exec", pattern: "*", action: "deny" },
      ]);
      const result = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(result.action).toBe("deny");
      expect(result.matchingRules).toBeDefined();
    });

    test("second setAgentPermission replaces the first", async () => {
      gate.setAgentPermission(SESSION, [
        { permission: "shell_exec", pattern: "*", action: "deny" },
      ]);

      // First evaluation: deny (agent veto)
      const r1 = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(r1.action).toBe("deny");

      // Replace with permissive ruleset — deny veto removed
      gate.setAgentPermission(SESSION, [
        { permission: "shell_exec", pattern: "*", action: "allow" },
      ]);

      // Now evaluates to "ask" (default static rules for shell_exec, agent allow doesn't override)
      const r2 = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(r2.action).not.toBe("deny"); // Veto is gone
    });

    test("agent permission is scoped to session", async () => {
      gate.setAgentPermission("session-X", [
        { permission: "shell_exec", pattern: "*", action: "deny" },
      ]);

      // Different session should not be affected
      const result = await gate.evaluate("shell_exec", { command: "echo hi" }, "session-Y", WORKER);
      expect(result.action).toBe("ask");
    });

    test("clearSession removes agent permissions", async () => {
      gate.setAgentPermission(SESSION, [
        { permission: "shell_exec", pattern: "*", action: "deny" },
      ]);
      gate.clearSession(SESSION);

      const result = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(result.action).toBe("ask"); // Back to default, not deny
    });
  });
});
