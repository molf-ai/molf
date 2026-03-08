import { describe, test, expect, mock } from "bun:test";

// Mock chokidar
mock.module("chokidar", () => ({
  watch: () => ({
    add: () => {},
    on: () => {},
    close: async () => {},
  }),
}));

// Mock the local MCP modules
const mockConnectAll = mock(async () => {});
const mockCloseAll = mock(async () => {});
const mockListTools = mock(async () => [
  { name: "mcp_tool", description: "An MCP tool", inputSchema: { type: "object" } },
]);
const mockGetConnectedServers = mock(() => ["test-server"]);
const mockRegisterExitHandler = mock(() => {});

mock.module("../../src/config.js", () => ({
  loadMcpConfig: (workdir: string) => ({
    mcpServers: { "test-server": { command: "echo", args: [] } },
  }),
  interpolateEnv: (v: string) => v,
}));

mock.module("../../src/client.js", () => ({
  McpClientManager: class {
    connectAll = mockConnectAll;
    closeAll = mockCloseAll;
    listTools = mockListTools;
    getConnectedServers = mockGetConnectedServers;
    registerExitHandler = mockRegisterExitHandler;
    onToolsChanged = null as any;
  },
  createServerCaller: () => async () => ({}),
}));

const plugin = (await import("../../src/index.js")).default;

describe("plugin-mcp", () => {
  test("has name 'mcp'", () => {
    expect(plugin.name).toBe("mcp");
  });

  test("has worker() but no server()", () => {
    expect(plugin.worker).toBeDefined();
    expect(plugin.server).toBeUndefined();
  });

  test("worker() registers MCP tools via api.addTool", async () => {
    const registered: Array<{ name: string; def: any }> = [];
    const fakeApi = {
      addTool(name: string, def: any) {
        registered.push({ name, def });
      },
      removeTool() {},
      syncState: async () => {},
      on() {},
      addSkill() {},
      addAgent() {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: undefined,
      workdir: "/test",
    };

    const result = await plugin.worker!(fakeApi as any);

    expect(registered.length).toBeGreaterThan(0);
    expect(registered[0].name).toBe("test-server_mcp_tool");
    expect(registered[0].def.description).toBe("[test-server] An MCP tool");
    expect(typeof registered[0].def.execute).toBe("function");
  });

  test("worker() returns destroy function that closes connections", async () => {
    const fakeApi = {
      addTool() {},
      removeTool() {},
      syncState: async () => {},
      on() {},
      addSkill() {},
      addAgent() {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: undefined,
      workdir: "/test",
    };

    const result = await plugin.worker!(fakeApi as any);

    expect(result).toBeDefined();
    expect(typeof (result as any).destroy).toBe("function");
  });

  test("worker() with no MCP config returns early", async () => {
    // Override loadMcpConfig to return null
    mock.module("../../src/config.js", () => ({
      loadMcpConfig: () => null,
      interpolateEnv: (v: string) => v,
    }));

    // Re-import with new mock
    const { default: pluginNoConfig } = await import("../../src/index.js");
    const registered: any[] = [];
    const fakeApi = {
      addTool(name: string, def: any) { registered.push({ name, def }); },
      removeTool() {},
      syncState: async () => {},
      on() {},
      addSkill() {},
      addAgent() {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: undefined,
      workdir: "/test/no-mcp",
    };

    const result = await pluginNoConfig.worker!(fakeApi as any);

    // No tools should be registered, but destroy is returned for watcher cleanup
    expect(registered).toHaveLength(0);
    expect(result).toBeDefined();
    expect(typeof (result as any).destroy).toBe("function");
  });
});
