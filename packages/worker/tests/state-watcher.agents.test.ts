import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { resolve } from "path";
import { StateWatcher } from "../src/state-watcher.js";
import type { WorkerAgentInfo } from "@molf-ai/protocol";

/**
 * Tests for the agents handler in StateWatcher.
 * Mirrors the skills handler tests pattern — calls handler methods directly
 * rather than relying on fs.watch event propagation.
 */

describe("StateWatcher — agents handler", () => {
  let tmpDir: TmpDir;
  let syncCount: number;
  let requestSync: ReturnType<typeof mock>;
  let onAgentsChange: ReturnType<typeof mock>;
  let watcher: StateWatcher;

  beforeEach(() => {
    tmpDir = createTmpDir("state-watcher-agents-");
    syncCount = 0;
    requestSync = mock(() => { syncCount++; });
    onAgentsChange = mock(() => {});
  });

  afterEach(async () => {
    await watcher?.close();
    tmpDir.cleanup();
  });

  function createWatcher() {
    watcher = new StateWatcher({
      workdir: tmpDir.path,
      requestSync,
      onAgentsChange,
    });
  }

  test("adding agent .md triggers requestSync and onAgentsChange", async () => {
    mkdirSync(resolve(tmpDir.path, ".agents/agents"), { recursive: true });
    createWatcher();

    // Add an agent file
    writeFileSync(
      resolve(tmpDir.path, ".agents/agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nReview instructions.",
    );

    await watcher.handleAgentsChange();

    expect(syncCount).toBe(1);
    expect(onAgentsChange).toHaveBeenCalledTimes(1);
    const agents = onAgentsChange.mock.calls[0][0] as WorkerAgentInfo[];
    expect(agents.some(a => a.name === "reviewer")).toBe(true);
  });

  test("modifying agent file triggers requestSync", async () => {
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

    expect(syncCount).toBe(1);
    const agents = onAgentsChange.mock.calls[0][0] as WorkerAgentInfo[];
    const agent = agents.find(a => a.name === "reviewer");
    expect(agent?.description).toBe("Reviews code v2");
    expect(agent?.content).toBe("Updated instructions.");
  });

  test("removing agent file triggers requestSync", async () => {
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

    expect(syncCount).toBe(1);
    const agents = onAgentsChange.mock.calls[0][0] as WorkerAgentInfo[];
    expect(agents.some(a => a.name === "reviewer")).toBeFalsy();
  });

  test("no change triggers no requestSync", async () => {
    const agentsDir = resolve(tmpDir.path, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\nInstructions.",
    );

    createWatcher();

    // Call handler without changing anything
    await watcher.handleAgentsChange();

    expect(syncCount).toBe(0);
    expect(onAgentsChange).not.toHaveBeenCalled();
  });

  test("removing all agents triggers requestSync with empty agents", async () => {
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

    expect(syncCount).toBe(1);
    const agents = onAgentsChange.mock.calls[0][0] as WorkerAgentInfo[];
    expect(agents).toHaveLength(0);
  });
});
