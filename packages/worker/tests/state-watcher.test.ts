import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { resolve } from "path";
import { ToolExecutor } from "../src/tool-executor.js";
import { StateWatcher } from "../src/state-watcher.js";
import type { WorkerToolInfo, WorkerSkillInfo } from "@molf-ai/protocol";

/**
 * These tests call the handler methods directly rather than relying on
 * fs.watch event propagation, which is unreliable across platforms/CI.
 * The watcher integration (fs.watch → debounce → handler) is validated
 * separately through manual testing.
 */

describe("StateWatcher", () => {
  let tmpDir: TmpDir;
  let toolExecutor: ToolExecutor;
  let syncCalls: Array<{
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    metadata?: { agentsDoc?: string };
  }>;
  let watcher: StateWatcher;

  beforeEach(() => {
    tmpDir = createTmpDir("state-watcher-");
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
      syncState: async (state) => { syncCalls.push(state); },
    });
    // Note: we don't call start() in most tests since we test handlers directly
  }

  describe("skills handler", () => {
    test("new skill triggers syncState", async () => {
      mkdirSync(resolve(tmpDir.path, ".agents/skills"), { recursive: true });
      createWatcher();

      // Add a skill
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting skill\n---\nHello!");

      await watcher.handleSkillsChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].skills?.some((s) => s.name === "greet")).toBe(true);
    });

    test("remove skill triggers syncState without that skill", async () => {
      // Pre-create skill
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");

      createWatcher();

      // Remove the skill
      rmSync(skillDir, { recursive: true });

      await watcher.handleSkillsChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].skills?.some((s) => s.name === "greet")).toBeFalsy();
    });

    test("edit skill content triggers syncState", async () => {
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");

      createWatcher();

      // Edit content
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHello World!");

      await watcher.handleSkillsChange();

      expect(syncCalls).toHaveLength(1);
      const skill = syncCalls[0].skills?.find((s) => s.name === "greet");
      expect(skill?.content).toBe("Hello World!");
    });

    test("no change triggers no syncState", async () => {
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");

      createWatcher();

      // Call handler without changing anything
      await watcher.handleSkillsChange();

      expect(syncCalls).toHaveLength(0);
    });

    test("no skills dir initially — no crash", () => {
      createWatcher();
      watcher.start();
      expect(watcher).toBeTruthy();
    });
  });

  describe("AGENTS.md / CLAUDE.md handler", () => {
    test("edit AGENTS.md triggers syncState", async () => {
      tmpDir.writeFile("AGENTS.md", "original");

      createWatcher();

      writeFileSync(resolve(tmpDir.path, "AGENTS.md"), "updated content");

      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].metadata?.agentsDoc).toBe("updated content");
    });

    test("create AGENTS.md triggers syncState", async () => {
      createWatcher();

      tmpDir.writeFile("AGENTS.md", "new content");

      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].metadata?.agentsDoc).toBe("new content");
    });

    test("delete AGENTS.md with CLAUDE.md fallback triggers syncState", async () => {
      tmpDir.writeFile("AGENTS.md", "agents content");
      tmpDir.writeFile("CLAUDE.md", "claude content");

      createWatcher();

      unlinkSync(resolve(tmpDir.path, "AGENTS.md"));

      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].metadata?.agentsDoc).toBe("claude content");
    });

    test("delete AGENTS.md with no CLAUDE.md clears agentsDoc", async () => {
      tmpDir.writeFile("AGENTS.md", "agents content");

      createWatcher();

      unlinkSync(resolve(tmpDir.path, "AGENTS.md"));

      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].metadata?.agentsDoc).toBeUndefined();
    });

    test("edit CLAUDE.md while AGENTS.md exists — no syncState", async () => {
      tmpDir.writeFile("AGENTS.md", "agents content");
      tmpDir.writeFile("CLAUDE.md", "claude original");

      createWatcher();

      writeFileSync(resolve(tmpDir.path, "CLAUDE.md"), "claude updated");

      await watcher.handleAgentsDocChange();

      // AGENTS.md still exists and is unchanged, so effective content didn't change
      expect(syncCalls).toHaveLength(0);
    });

    test("edit CLAUDE.md while no AGENTS.md triggers syncState", async () => {
      tmpDir.writeFile("CLAUDE.md", "original");

      createWatcher();

      writeFileSync(resolve(tmpDir.path, "CLAUDE.md"), "updated");

      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].metadata?.agentsDoc).toBe("updated");
    });

    test("no change triggers no syncState", async () => {
      tmpDir.writeFile("AGENTS.md", "content");

      createWatcher();

      // Call handler without changing anything
      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(0);
    });
  });

  describe("MCP config handler", () => {
    test("new .mcp.json triggers syncState (no mcpManager)", async () => {
      createWatcher();

      // Create a minimal config (no actual MCP server will connect since mcpManager is null)
      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "test-server": { command: "echo", args: ["hi"] } },
      }));

      await watcher.handleMcpConfigChange();

      // With null mcpManager, just sends current state
      expect(syncCalls).toHaveLength(1);
    });

    test("no change triggers no syncState", async () => {
      tmpDir.writeFile(".mcp.json", JSON.stringify({ mcpServers: {} }));

      createWatcher();

      // Call without change
      await watcher.handleMcpConfigChange();

      expect(syncCalls).toHaveLength(0);
    });

    test("invalid JSON skips reload gracefully", async () => {
      createWatcher();

      writeFileSync(resolve(tmpDir.path, ".mcp.json"), "not valid json {{{");

      // Should not throw
      await watcher.handleMcpConfigChange();

      expect(syncCalls).toHaveLength(0);
    });
  });

  describe("MCP config handler with mock manager", () => {
    /** Minimal mock McpClientManager for testing config change detection. */
    function createMockMcpManager(connectedServers: string[] = []) {
      const disconnected: string[] = [];
      const connected: Array<{ name: string; config: any }> = [];

      return {
        manager: {
          getConnectedServers: () => connectedServers.filter((s) => !disconnected.includes(s)),
          disconnectOne: async (name: string) => {
            disconnected.push(name);
            connectedServers = connectedServers.filter((s) => s !== name);
          },
          connectOne: async (name: string, config: any) => {
            connected.push({ name, config });
            connectedServers.push(name);
          },
          listTools: async () => [],
          closeAll: async () => {},
          registerExitHandler: () => {},
          onToolsChanged: undefined as any,
          callTool: async () => ({ content: [], isError: false }),
        } as any,
        getDisconnected: () => disconnected,
        getConnected: () => connected,
      };
    }

    test("added server triggers connect and syncState", async () => {
      const mock = createMockMcpManager([]);

      watcher = new StateWatcher({
        workdir: tmpDir.path,
        toolExecutor,
        mcpManager: mock.manager,
        syncState: async (state) => { syncCalls.push(state); },
      });

      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "new-server": { command: "echo", args: ["hi"] } },
      }));

      await watcher.handleMcpConfigChange();

      expect(mock.getConnected().length).toBe(1);
      expect(mock.getConnected()[0].name).toBe("new-server");
      expect(syncCalls).toHaveLength(1);
    });

    test("removed server triggers disconnect and syncState", async () => {
      // Start with a server in the config
      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "old-server": { command: "echo", args: [] } },
      }));

      const mock = createMockMcpManager(["old-server"]);

      watcher = new StateWatcher({
        workdir: tmpDir.path,
        toolExecutor,
        mcpManager: mock.manager,
        syncState: async (state) => { syncCalls.push(state); },
      });

      // Remove the server
      writeFileSync(resolve(tmpDir.path, ".mcp.json"), JSON.stringify({
        mcpServers: {},
      }));

      await watcher.handleMcpConfigChange();

      expect(mock.getDisconnected()).toContain("old-server");
      expect(syncCalls).toHaveLength(1);
    });

    test("changed server config triggers disconnect + reconnect", async () => {
      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "my-server": { command: "old-cmd", args: ["--old"] } },
      }));

      const mock = createMockMcpManager(["my-server"]);

      watcher = new StateWatcher({
        workdir: tmpDir.path,
        toolExecutor,
        mcpManager: mock.manager,
        syncState: async (state) => { syncCalls.push(state); },
      });

      // Change the server's config (different args)
      writeFileSync(resolve(tmpDir.path, ".mcp.json"), JSON.stringify({
        mcpServers: { "my-server": { command: "new-cmd", args: ["--new"] } },
      }));

      await watcher.handleMcpConfigChange();

      // Should have disconnected the old and reconnected with new config
      expect(mock.getDisconnected()).toContain("my-server");
      expect(mock.getConnected().some((c) => c.name === "my-server")).toBe(true);
      expect(syncCalls).toHaveLength(1);
    });

    test("toggling enabled: false triggers disconnect", async () => {
      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "my-server": { command: "echo", args: [] } },
      }));

      const mock = createMockMcpManager(["my-server"]);

      watcher = new StateWatcher({
        workdir: tmpDir.path,
        toolExecutor,
        mcpManager: mock.manager,
        syncState: async (state) => { syncCalls.push(state); },
      });

      // Disable the server
      writeFileSync(resolve(tmpDir.path, ".mcp.json"), JSON.stringify({
        mcpServers: { "my-server": { command: "echo", args: [], enabled: false } },
      }));

      await watcher.handleMcpConfigChange();

      expect(mock.getDisconnected()).toContain("my-server");
      expect(syncCalls).toHaveLength(1);
    });

    test("deleted .mcp.json stops all servers", async () => {
      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "srv1": { command: "echo" }, "srv2": { command: "echo" } },
      }));

      const mock = createMockMcpManager(["srv1", "srv2"]);

      watcher = new StateWatcher({
        workdir: tmpDir.path,
        toolExecutor,
        mcpManager: mock.manager,
        syncState: async (state) => { syncCalls.push(state); },
      });

      // Delete the config file
      unlinkSync(resolve(tmpDir.path, ".mcp.json"));

      await watcher.handleMcpConfigChange();

      expect(mock.getDisconnected()).toContain("srv1");
      expect(mock.getDisconnected()).toContain("srv2");
      expect(syncCalls).toHaveLength(1);
    });

    test("unchanged server config triggers no reconnect", async () => {
      tmpDir.writeFile(".mcp.json", JSON.stringify({
        mcpServers: { "stable": { command: "echo", args: [] } },
      }));

      const mock = createMockMcpManager(["stable"]);

      watcher = new StateWatcher({
        workdir: tmpDir.path,
        toolExecutor,
        mcpManager: mock.manager,
        syncState: async (state) => { syncCalls.push(state); },
      });

      // Write same content again (different whitespace triggers raw diff but same parsed config)
      writeFileSync(resolve(tmpDir.path, ".mcp.json"), JSON.stringify({
        mcpServers: { "stable": { command: "echo", args: [] } },
      }) + "\n");

      await watcher.handleMcpConfigChange();

      // Raw content changed but parsed config is the same — no disconnect/connect
      expect(mock.getDisconnected()).toHaveLength(0);
      expect(mock.getConnected()).toHaveLength(0);
      expect(syncCalls).toHaveLength(0);
    });
  });

  describe("syncState payload", () => {
    test("includes current tools from toolExecutor", async () => {
      createWatcher();

      tmpDir.writeFile("AGENTS.md", "new content");
      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].tools).toHaveLength(1);
      expect(syncCalls[0].tools[0].name).toBe("test_tool");
    });

    test("includes skills and metadata together", async () => {
      const skillDir = resolve(tmpDir.path, ".agents/skills", "greet");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: greet\ndescription: greeting\n---\nHi");
      tmpDir.writeFile("AGENTS.md", "instructions");

      createWatcher();

      // Change AGENTS.md
      writeFileSync(resolve(tmpDir.path, "AGENTS.md"), "new instructions");
      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].skills).toHaveLength(1);
      expect(syncCalls[0].skills[0].name).toBe("greet");
      expect(syncCalls[0].metadata?.agentsDoc).toBe("new instructions");
    });

    test("metadata includes workdir", async () => {
      createWatcher();

      tmpDir.writeFile("AGENTS.md", "new content");
      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      expect(syncCalls[0].metadata?.workdir).toBe(tmpDir.path);
    });

    test("clearing agentsDoc sends metadata without agentsDoc", async () => {
      tmpDir.writeFile("AGENTS.md", "content");
      createWatcher();

      unlinkSync(resolve(tmpDir.path, "AGENTS.md"));
      await watcher.handleAgentsDocChange();

      expect(syncCalls).toHaveLength(1);
      // agentsDoc should be undefined (cleared), not the old value
      expect(syncCalls[0].metadata?.agentsDoc).toBeUndefined();
      // workdir is still present
      expect(syncCalls[0].metadata?.workdir).toBe(tmpDir.path);
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
