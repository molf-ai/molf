import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { resolve } from "path";
import { StateWatcher } from "../src/state-watcher.js";
import type { WorkerSkillInfo, WorkerAgentInfo } from "@molf-ai/protocol";

/**
 * These tests call the handler methods directly rather than relying on
 * fs.watch event propagation, which is unreliable across platforms/CI.
 * The watcher integration (fs.watch → debounce → handler) is validated
 * separately through manual testing.
 */

describe("StateWatcher", () => {
  let tmpDir: TmpDir;
  let syncCount: number;
  let requestSync: ReturnType<typeof vi.fn>;
  let onSkillsChange: ReturnType<typeof vi.fn>;
  let onAgentsChange: ReturnType<typeof vi.fn>;
  let onAgentsDocChange: ReturnType<typeof vi.fn>;
  let watcher: StateWatcher;

  beforeEach(() => {
    tmpDir = createTmpDir("state-watcher-");
    syncCount = 0;
    requestSync = vi.fn(() => { syncCount++; });
    onSkillsChange = vi.fn(() => {});
    onAgentsChange = vi.fn(() => {});
    onAgentsDocChange = vi.fn(() => {});
  });

  afterEach(async () => {
    await watcher?.close();
    tmpDir.cleanup();
  });

  function createWatcher() {
    watcher = new StateWatcher({
      workdir: tmpDir.path,
      requestSync,
      onSkillsChange,
      onAgentsChange,
      onAgentsDocChange,
    });
    // Note: we don't call start() in most tests since we test handlers directly
  }

  describe("skills handler", () => {
    test("new skill triggers requestSync and onSkillsChange", async () => {
      mkdirSync(resolve(tmpDir.path, ".agents/skills"), { recursive: true });
      createWatcher();

      // Add a skill
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting skill\n---\nHello!");

      await watcher.handleSkillsChange();

      expect(syncCount).toBe(1);
      expect(onSkillsChange).toHaveBeenCalledTimes(1);
      const skills = onSkillsChange.mock.calls[0][0] as WorkerSkillInfo[];
      expect(skills.some((s) => s.name === "greet")).toBe(true);
    });

    test("remove skill triggers requestSync", async () => {
      // Pre-create skill
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");

      createWatcher();

      // Remove the skill
      rmSync(skillDir, { recursive: true });

      await watcher.handleSkillsChange();

      expect(syncCount).toBe(1);
      const skills = onSkillsChange.mock.calls[0][0] as WorkerSkillInfo[];
      expect(skills.some((s) => s.name === "greet")).toBeFalsy();
    });

    test("edit skill content triggers requestSync", async () => {
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");

      createWatcher();

      // Edit content
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHello World!");

      await watcher.handleSkillsChange();

      expect(syncCount).toBe(1);
      const skills = onSkillsChange.mock.calls[0][0] as WorkerSkillInfo[];
      const skill = skills.find((s) => s.name === "greet");
      expect(skill?.content).toBe("Hello World!");
    });

    test("no change triggers no requestSync", async () => {
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");

      createWatcher();

      // Call handler without changing anything
      await watcher.handleSkillsChange();

      expect(syncCount).toBe(0);
      expect(onSkillsChange).not.toHaveBeenCalled();
    });

    test("no skills dir initially — no crash", () => {
      createWatcher();
      watcher.start();
      expect(watcher).toBeTruthy();
    });
  });

  describe("AGENTS.md / CLAUDE.md handler", () => {
    test("edit AGENTS.md triggers requestSync and onAgentsDocChange", async () => {
      tmpDir.writeFile("AGENTS.md", "original");

      createWatcher();

      writeFileSync(resolve(tmpDir.path, "AGENTS.md"), "updated content");

      await watcher.handleAgentsDocChange();

      expect(syncCount).toBe(1);
      expect(onAgentsDocChange).toHaveBeenCalledTimes(1);
      expect(onAgentsDocChange.mock.calls[0][0]).toBe("updated content");
    });

    test("create AGENTS.md triggers requestSync", async () => {
      createWatcher();

      tmpDir.writeFile("AGENTS.md", "new content");

      await watcher.handleAgentsDocChange();

      expect(syncCount).toBe(1);
      expect(onAgentsDocChange.mock.calls[0][0]).toBe("new content");
    });

    test("delete AGENTS.md with CLAUDE.md fallback triggers requestSync", async () => {
      tmpDir.writeFile("AGENTS.md", "agents content");
      tmpDir.writeFile("CLAUDE.md", "claude content");

      createWatcher();

      unlinkSync(resolve(tmpDir.path, "AGENTS.md"));

      await watcher.handleAgentsDocChange();

      expect(syncCount).toBe(1);
      expect(onAgentsDocChange.mock.calls[0][0]).toBe("claude content");
    });

    test("delete AGENTS.md with no CLAUDE.md clears agentsDoc", async () => {
      tmpDir.writeFile("AGENTS.md", "agents content");

      createWatcher();

      unlinkSync(resolve(tmpDir.path, "AGENTS.md"));

      await watcher.handleAgentsDocChange();

      expect(syncCount).toBe(1);
      expect(onAgentsDocChange.mock.calls[0][0]).toBeUndefined();
    });

    test("edit CLAUDE.md while AGENTS.md exists — no requestSync", async () => {
      tmpDir.writeFile("AGENTS.md", "agents content");
      tmpDir.writeFile("CLAUDE.md", "claude original");

      createWatcher();

      writeFileSync(resolve(tmpDir.path, "CLAUDE.md"), "claude updated");

      await watcher.handleAgentsDocChange();

      // AGENTS.md still exists and is unchanged, so effective content didn't change
      expect(syncCount).toBe(0);
      expect(onAgentsDocChange).not.toHaveBeenCalled();
    });

    test("edit CLAUDE.md while no AGENTS.md triggers requestSync", async () => {
      tmpDir.writeFile("CLAUDE.md", "original");

      createWatcher();

      writeFileSync(resolve(tmpDir.path, "CLAUDE.md"), "updated");

      await watcher.handleAgentsDocChange();

      expect(syncCount).toBe(1);
      expect(onAgentsDocChange.mock.calls[0][0]).toBe("updated");
    });

    test("no change triggers no requestSync", async () => {
      tmpDir.writeFile("AGENTS.md", "content");

      createWatcher();

      // Call handler without changing anything
      await watcher.handleAgentsDocChange();

      expect(syncCount).toBe(0);
      expect(onAgentsDocChange).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    test("close stops watchers", async () => {
      createWatcher();
      watcher.start();
      await watcher.close();
      expect(watcher).toBeTruthy();
    });
  });
});
