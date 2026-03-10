import { describe, test, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { ApprovalGate } from "../../src/approval/approval-gate.js";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { EventBus } from "../../src/event-bus.js";
import { fromConfig } from "../../src/approval/evaluate.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

let tmp: TmpDir;
let eventBus: EventBus;
let storage: RulesetStorage;
let gate: ApprovalGate;

const SESSION = "child-session-1";
const WORKER = "worker-1";

/**
 * Write an empty static ruleset for the worker so that ONLY
 * the agent permission layer is active (no default rules interfering).
 */
function seedEmptyStaticRuleset() {
  const workerDir = resolve(tmp.path, "workers", WORKER);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(resolve(workerDir, "permissions.jsonc"), "[]");
}

beforeEach(() => {
  tmp = createTmpDir("molf-gate-subagent-");
  eventBus = new EventBus();
  storage = new RulesetStorage(tmp.path);
  gate = new ApprovalGate(storage, eventBus);
});

describe("ApprovalGate — subagent permissions", () => {
  describe("agent permission as base layer (isolated — empty static ruleset)", () => {
    test("agent '*': 'deny' blocks unlisted tools", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({ "*": "deny", grep: "allow" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // With empty static ruleset, agent deny is the last match → deny
      const result = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(result.action).toBe("deny");
    });

    test("agent permission allows listed tools", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({ "*": "deny", grep: "allow", glob: "allow" });
      gate.setAgentPermission(SESSION, agentRuleset);

      const result = await gate.evaluate("grep", { path: "src/", pattern: "TODO" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
    });

    test("agent 'read_file: { \"*.env\": \"deny\" }' blocks specific patterns", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({
        "*": "deny",
        read_file: { "*": "allow", "*.env": "deny" },
      });
      gate.setAgentPermission(SESSION, agentRuleset);

      // Normal file allowed
      const r1 = await gate.evaluate("read_file", { path: "src/index.ts" }, SESSION, WORKER);
      expect(r1.action).toBe("allow");

      // .env file denied
      const r2 = await gate.evaluate("read_file", { path: ".env" }, SESSION, WORKER);
      expect(r2.action).toBe("deny");
    });

    test("agent 'ask' triggers normal approval flow", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({ "*": "ask" });
      gate.setAgentPermission(SESSION, agentRuleset);

      const result = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });

    test("no match defaults to 'ask' when no rules match", async () => {
      seedEmptyStaticRuleset();

      // Agent with very specific rule that doesn't match
      const agentRuleset = fromConfig({ grep: "allow" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // shell_exec doesn't match any rule → default "ask"
      const result = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });
  });

  describe("layered evaluation: agent → static → runtime", () => {
    test("agent deny cannot be overridden by static rules", async () => {
      // Agent denies all
      const agentRuleset = fromConfig({ "*": "deny" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // Static ruleset allows read_file (write a custom permissions file)
      const workerDir = resolve(tmp.path, "workers", WORKER);
      mkdirSync(workerDir, { recursive: true });
      writeFileSync(
        resolve(workerDir, "permissions.jsonc"),
        JSON.stringify([
          { permission: "read_file", pattern: "*", action: "allow" },
        ]),
      );

      // Agent denies "*" → veto; static cannot override
      const r = await gate.evaluate("read_file", { path: "src/index.ts" }, SESSION, WORKER);
      expect(r.action).toBe("deny");

      // shell_exec also denied by agent → deny
      const r2 = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r2.action).toBe("deny");
    });

    test("runtime 'always approve' overrides both agent and static", async () => {
      seedEmptyStaticRuleset();

      // Agent denies all except via ask
      const agentRuleset = fromConfig({ "*": "ask" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // shell_exec evaluates to "ask" (agent base)
      const r = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(r.action).toBe("ask");

      // Simulate "always approve"
      const approvalId = gate.requestApproval(
        "shell_exec",
        { command: "echo hi" },
        r.patterns,
        r.alwaysPatterns,
        SESSION,
        WORKER,
      );
      const promise = gate.waitForApproval(approvalId);
      gate.reply(approvalId, "always");
      await promise;

      // Now shell_exec with similar pattern should be allowed from runtime layer
      const r2 = await gate.evaluate("shell_exec", { command: "echo bye" }, SESSION, WORKER);
      expect(r2.action).toBe("allow");
    });

    test("agent deny vetoes even with default static rules", async () => {
      // Don't seed empty — use the real default static ruleset
      // Agent says deny all
      const agentRuleset = fromConfig({ "*": "deny" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // Agent deny vetoes — default static allow for write_file cannot override
      const r = await gate.evaluate("write_file", { path: "test.txt" }, SESSION, WORKER);
      expect(r.action).toBe("deny");

      // Agent deny vetoes — default static ask for shell_exec cannot override
      const r2 = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r2.action).toBe("deny");
    });

    test("agent deny cannot be overridden by runtime 'always approve'", async () => {
      seedEmptyStaticRuleset();

      // Agent denies shell_exec
      const agentRuleset = fromConfig({ "*": "deny", grep: "allow" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // Verify shell_exec is denied
      const r1 = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(r1.action).toBe("deny");

      // Manually inject a runtime "always approve" for shell_exec.
      // In real use a denied tool never reaches the approval prompt, but
      // we test the invariant that even if runtime rules exist, the veto holds.
      (gate as any).addRuntimeApproval(SESSION, "shell_exec", ["echo *"]);

      // shell_exec should still be denied despite the runtime allow
      const r2 = await gate.evaluate("shell_exec", { command: "echo hi" }, SESSION, WORKER);
      expect(r2.action).toBe("deny");
    });

    test("agent allow can be tightened by static rules", async () => {
      // Agent allows write_file
      const agentRuleset = fromConfig({ "*": "ask", write_file: "allow" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // Static ruleset denies write_file for *.env
      const workerDir = resolve(tmp.path, "workers", WORKER);
      mkdirSync(workerDir, { recursive: true });
      writeFileSync(
        resolve(workerDir, "permissions.jsonc"),
        JSON.stringify([
          { permission: "write_file", pattern: "*.env", action: "deny" },
        ]),
      );

      // Normal file: agent allows, static has no override → allow
      const r1 = await gate.evaluate("write_file", { path: "readme.md" }, SESSION, WORKER);
      expect(r1.action).toBe("allow");

      // .env file: agent allows, but static denies → deny (static tightens agent allow)
      const r2 = await gate.evaluate("write_file", { path: ".env" }, SESSION, WORKER);
      expect(r2.action).toBe("deny");
    });

    test("agent deny includes matchingRules from agent layer", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({ "*": "deny" });
      gate.setAgentPermission(SESSION, agentRuleset);

      const r = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r.action).toBe("deny");
      expect(r.matchingRules).toBeDefined();
      expect(r.matchingRules!.length).toBeGreaterThan(0);
      expect(r.matchingRules![0].action).toBe("deny");
    });
  });

  describe("clearSession", () => {
    test("clearSession removes agent permission", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({ "*": "deny", grep: "allow" });
      gate.setAgentPermission(SESSION, agentRuleset);

      // shell_exec denied by agent permission
      const r1 = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r1.action).toBe("deny");

      // Clear session
      gate.clearSession(SESSION);

      // Without agent permission, and empty static: no rules match → default "ask"
      const r2 = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r2.action).toBe("ask");
    });

    test("clearAll also removes agent permissions", async () => {
      seedEmptyStaticRuleset();

      const agentRuleset = fromConfig({ "*": "deny" });
      gate.setAgentPermission(SESSION, agentRuleset);

      const r1 = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r1.action).toBe("deny");

      gate.clearAll();

      const r2 = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(r2.action).toBe("ask");
    });
  });

  describe("no agent permission = normal evaluation", () => {
    test("without setAgentPermission, uses only static+runtime", async () => {
      // With default static ruleset, shell_exec evaluates to "ask"
      const result = await gate.evaluate("shell_exec", { command: "ls" }, SESSION, WORKER);
      expect(result.action).toBe("ask");
    });

    test("without setAgentPermission, grep evaluates to allow from default static", async () => {
      const result = await gate.evaluate("grep", { path: "src/", pattern: "TODO" }, SESSION, WORKER);
      expect(result.action).toBe("allow");
    });
  });
});
