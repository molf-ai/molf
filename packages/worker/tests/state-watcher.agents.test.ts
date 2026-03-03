import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { resolve } from "path";
import { ToolExecutor } from "../src/tool-executor.js";
import { StateWatcher } from "../src/state-watcher.js";
import type { WorkerToolInfo, WorkerSkillInfo, WorkerAgentInfo } from "@molf-ai/protocol";

/**
 * Tests for the agents handler in StateWatcher.
 * Mirrors the skills handler tests pattern — calls handler methods directly
 * rather than relying on fs.watch event propagation.
 */

describe("StateWatcher — agents handler", () => {
  let tmpDir: TmpDir;
  let toolExecutor: ToolExecutor;
  let syncCalls: Array<{
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    agents: WorkerAgentInfo[];
    metadata?: { agentsDoc?: string };
  }>;
  let watcher: StateWatcher;

  beforeEach(() => {
    tmpDir = createTmpDir("state-watcher-agents-");
    toolExecutor = new ToolExecutor(tmpDir.path);
    toolExecutor.registerTools([
      { name: "test_tool", description: "a test tool", inputSchema: { type: "object" } },
    ]);
    syncCalls = [];
  });

  afterEach(async () => {
    await watcher?.close();
    tmpDir.cleanup();
  });

  function createWatcher() {
    watcher = new StateWatcher({
      workdir: tmpDir.path,
      toolExecutor,
      mcpManager: null,
      syncState: async (state) => { syncCalls.push(state as any); },
    });
  }

  test("adding agent .md triggers syncState", async () => {
    mkdirSync(resolve(tmpDir.path, ".agents/agents"), { recursive: true });
    createWatcher();

    // Add an agent file
    writeFileSync(
      resolve(tmpDir.path, ".agents/agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nReview instructions.",
    );

    await watcher.handleAgentsChange();

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].agents?.some(a => a.name === "reviewer")).toBe(true);
  });

  test("modifying agent file triggers syncState", async () => {
    const agentsDir = resolve(tmpDir.path, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nOriginal instructions.",
    );

    createWatcher();

    // Modify the agent
    writeFileSync(
      resolve(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code v2\n---\nUpdated instructions.",
    );

    await watcher.handleAgentsChange();

    expect(syncCalls).toHaveLength(1);
    const agent = syncCalls[0].agents?.find(a => a.name === "reviewer");
    expect(agent?.description).toBe("Reviews code v2");
    expect(agent?.content).toBe("Updated instructions.");
  });

  test("removing agent file triggers syncState", async () => {
    const agentsDir = resolve(tmpDir.path, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nInstructions.",
    );

    createWatcher();

    // Remove the agent
    unlinkSync(resolve(agentsDir, "reviewer.md"));

    await watcher.handleAgentsChange();

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].agents?.some(a => a.name === "reviewer")).toBeFalsy();
  });

  test("no change triggers no syncState", async () => {
    const agentsDir = resolve(tmpDir.path, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nInstructions.",
    );

    createWatcher();

    // Call handler without changing anything
    await watcher.handleAgentsChange();

    expect(syncCalls).toHaveLength(0);
  });

  test("removing all agents triggers syncState with empty agents", async () => {
    const agentsDir = resolve(tmpDir.path, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "a.md"),
      "---\nname: a\ndescription: Agent A\n---\nBody",
    );

    createWatcher();

    // Remove all agents
    rmSync(resolve(agentsDir, "a.md"));

    await watcher.handleAgentsChange();

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].agents).toHaveLength(0);
  });
});
