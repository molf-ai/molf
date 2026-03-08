import { describe, test, expect } from "bun:test";
import { resolveAgentTypes, DEFAULT_AGENTS } from "../src/subagent-types.js";
import { fromConfig } from "../src/approval/evaluate.js";
import type { WorkerAgentInfo } from "@molf-ai/protocol";

describe("DEFAULT_AGENTS", () => {
  test("includes explore and general agents", () => {
    const names = DEFAULT_AGENTS.map((a) => a.name);
    expect(names).toContain("explore");
    expect(names).toContain("general");
  });

  test("explore agent is read-only (denies by default, allows read tools)", () => {
    const explore = DEFAULT_AGENTS.find((a) => a.name === "explore")!;
    expect(explore.source).toBe("default");
    expect(explore.permission.some((r) => r.permission === "*" && r.action === "deny")).toBe(true);
    expect(explore.permission.some((r) => r.permission === "read_file" && r.action === "allow")).toBe(true);
    expect(explore.permission.some((r) => r.permission === "grep" && r.action === "allow")).toBe(true);
  });

  test("general agent allows everything", () => {
    const general = DEFAULT_AGENTS.find((a) => a.name === "general")!;
    expect(general.source).toBe("default");
    expect(general.permission.some((r) => r.permission === "*" && r.action === "allow")).toBe(true);
  });
});

describe("resolveAgentTypes", () => {
  test("returns defaults when no worker agents", () => {
    const result = resolveAgentTypes([]);
    expect(result).toHaveLength(DEFAULT_AGENTS.length);
    expect(result.map(a => a.name)).toContain("explore");
    expect(result.map(a => a.name)).toContain("general");
  });

  test("worker agent overrides default with same name", () => {
    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "explore",
        description: "Custom explore agent",
        content: "Custom explore instructions",
        permission: { "*": "deny", grep: "allow" },
        maxSteps: 5,
      },
    ];
    const result = resolveAgentTypes(workerAgents);

    const explore = result.find(a => a.name === "explore")!;
    expect(explore.description).toBe("Custom explore agent");
    expect(explore.systemPromptSuffix).toBe("Custom explore instructions");
    expect(explore.maxSteps).toBe(5);
    expect(explore.source).toBe("worker");

    // general should still be there
    const general = result.find(a => a.name === "general")!;
    expect(general.source).toBe("default");
  });

  test("worker agent with new name is added", () => {
    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "reviewer",
        description: "Code reviewer",
        content: "Review instructions",
      },
    ];
    const result = resolveAgentTypes(workerAgents);
    expect(result.map(a => a.name)).toContain("explore");
    expect(result.map(a => a.name)).toContain("general");
    expect(result.map(a => a.name)).toContain("reviewer");

    const reviewer = result.find(a => a.name === "reviewer")!;
    expect(reviewer.source).toBe("worker");
    expect(reviewer.maxSteps).toBe(10); // default maxSteps
  });

  test("task deny rule always appended as LAST rule in every agent's ruleset", () => {
    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "custom",
        description: "Custom agent",
        content: "Instructions",
        permission: { "*": "allow" },
      },
    ];
    const result = resolveAgentTypes(workerAgents);

    for (const agent of result) {
      const lastRule = agent.permission[agent.permission.length - 1];
      expect(lastRule).toEqual({
        permission: "task",
        pattern: "*",
        action: "deny",
      });
    }
  });

  test("task deny rule is present even for default agents", () => {
    const result = resolveAgentTypes([]);
    for (const agent of result) {
      const lastRule = agent.permission[agent.permission.length - 1];
      expect(lastRule).toEqual({
        permission: "task",
        pattern: "*",
        action: "deny",
      });
    }
  });

  test("worker CompactPermission converted to Ruleset via fromConfig()", () => {
    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "restricted",
        description: "Restricted",
        content: "Body",
        permission: {
          "*": "deny",
          grep: "allow",
          read_file: { "*": "allow", "*.env": "deny" },
        },
      },
    ];
    const result = resolveAgentTypes(workerAgents);
    const restricted = result.find(a => a.name === "restricted")!;

    // Should have the converted rules + task deny at end
    const expected = fromConfig({
      "*": "deny",
      grep: "allow",
      read_file: { "*": "allow", "*.env": "deny" },
    });
    // All expected rules should be present (before the appended task deny)
    for (const expectedRule of expected) {
      expect(restricted.permission).toContainEqual(expectedRule);
    }
  });

  test("worker agent without permission gets default allow-all", () => {
    const workerAgents: WorkerAgentInfo[] = [
      {
        name: "noperm",
        description: "No permission",
        content: "Body",
      },
    ];
    const result = resolveAgentTypes(workerAgents);
    const agent = result.find(a => a.name === "noperm")!;
    // Should have { permission: "*", pattern: "*", action: "allow" } from fromConfig({ "*": "allow" })
    expect(agent.permission).toContainEqual({
      permission: "*",
      pattern: "*",
      action: "allow",
    });
  });

  test("empty worker agents = defaults only", () => {
    const result = resolveAgentTypes([]);
    expect(result).toHaveLength(DEFAULT_AGENTS.length);
    result.forEach(a => {
      expect(a.source).toBe("default");
    });
  });
});
