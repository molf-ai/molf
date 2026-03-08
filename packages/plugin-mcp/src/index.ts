import { definePlugin } from "@molf-ai/protocol";
import type { WorkerTool, WorkerPluginApi } from "@molf-ai/protocol";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { loadMcpConfig, type McpServerConfig } from "./config.js";
import { McpClientManager, createServerCaller } from "./client.js";
import { adaptMcpTools, sanitizeName } from "./tool-adapter.js";

export { loadMcpConfig, interpolateEnv } from "./config.js";
export type { McpConfig, McpServerConfig } from "./config.js";
export { adaptMcpTools, sanitizeName } from "./tool-adapter.js";
export type { McpToolCaller, McpToolDef } from "./tool-adapter.js";
export { McpClientManager, createServerCaller } from "./client.js";

/**
 * Load MCP tools from the workdir's .mcp.json config.
 * Returns the adapted WorkerTool[] and the manager handle for lifecycle management.
 * If no config exists, returns empty tools and null manager.
 */
export async function loadMcpTools(workdir: string): Promise<{
  tools: WorkerTool[];
  manager: McpClientManager | null;
}> {
  const config = loadMcpConfig(workdir);
  if (!config || Object.keys(config.mcpServers).length === 0) {
    return { tools: [], manager: null };
  }

  const manager = new McpClientManager();
  await manager.connectAll(config.mcpServers);

  const connectedServers = manager.getConnectedServers();
  if (connectedServers.length === 0) {
    return { tools: [], manager: null };
  }

  const allTools: WorkerTool[] = [];

  for (const serverName of connectedServers) {
    const mcpToolDefs = await manager.listTools(serverName);
    const caller = createServerCaller(manager, serverName);
    const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);
    allTools.push(...adapted);
  }

  return { tools: allTools, manager };
}

const WATCHER_DEBOUNCE_MS = 500;

/**
 * Read the raw .mcp.json file content for change detection.
 */
function readMcpConfigRaw(workdir: string): string | null {
  const configPath = resolve(workdir, ".mcp.json");
  if (!existsSync(configPath)) return null;
  try {
    return readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Handle MCP config changes: diff against previous config,
 * disconnect removed/changed servers, connect new/changed ones.
 */
async function handleMcpConfigChange(
  api: WorkerPluginApi,
  manager: McpClientManager,
  state: { currentMcpConfigJson: string | null; currentMcpServers: Record<string, McpServerConfig> },
  toolNameMap: ToolNameMap,
): Promise<void> {
  const newRaw = readMcpConfigRaw(api.workdir);

  // No actual change in raw content
  if (newRaw === state.currentMcpConfigJson) return;
  const oldRaw = state.currentMcpConfigJson;
  state.currentMcpConfigJson = newRaw;

  // Validate JSON before committing the change
  if (newRaw !== null) {
    try {
      JSON.parse(newRaw);
    } catch {
      api.log.warn("MCP config invalid JSON, skipping reload");
      state.currentMcpConfigJson = oldRaw;
      return;
    }
  }

  // Config deleted — stop all servers
  if (newRaw === null) {
    api.log.info("MCP config deleted, stopping all servers");
    const connected = manager.getConnectedServers();
    for (const name of connected) {
      removeServerToolsTracked(api, name, toolNameMap);
      await manager.disconnectOne(name);
    }
    state.currentMcpServers = {};
    await api.syncState();
    return;
  }

  // Parse the new config
  let newConfig: Record<string, McpServerConfig>;
  try {
    const config = loadMcpConfig(api.workdir);
    if (!config) return;
    newConfig = config.mcpServers;
  } catch (err) {
    api.log.warn("MCP config parse error, skipping reload", { error: String(err) });
    return;
  }

  const currentServers = new Set(manager.getConnectedServers());
  const newServerNames = new Set(Object.keys(newConfig));

  // Determine changes: added, removed, and changed (config differs)
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const name of newServerNames) {
    if (!currentServers.has(name)) {
      added.push(name);
    } else if (serverConfigChanged(state.currentMcpServers[name], newConfig[name])) {
      changed.push(name);
    }
  }

  for (const name of currentServers) {
    if (!newServerNames.has(name)) {
      removed.push(name);
    } else if (newConfig[name].enabled === false) {
      removed.push(name);
    }
  }

  // Changed servers: disconnect then reconnect (full restart)
  for (const name of changed) {
    removeServerToolsTracked(api, name, toolNameMap);
    await manager.disconnectOne(name);
    added.push(name); // Re-add to trigger fresh connect
    api.log.info("MCP hot-reload restarting server", { serverName: name });
  }

  // Apply removals
  for (const name of removed) {
    removeServerToolsTracked(api, name, toolNameMap);
    await manager.disconnectOne(name);
    api.log.info("MCP hot-reload removed server", { serverName: name });
  }

  // Apply additions (includes changed servers that were disconnected above)
  for (const name of added) {
    const config = newConfig[name];
    if (config.enabled === false) continue;
    await connectAndRegisterTools(api, manager, name, config, toolNameMap);
  }

  // Update stored config for future diffs
  state.currentMcpServers = newConfig;

  if (removed.length > 0 || added.length > 0) {
    await api.syncState();
  }
}

function serverConfigChanged(oldConfig: McpServerConfig | undefined, newConfig: McpServerConfig): boolean {
  if (!oldConfig) return true;
  return JSON.stringify(oldConfig) !== JSON.stringify(newConfig);
}

type ToolNameMap = Map<string, string[]>;

function removeServerToolsTracked(api: WorkerPluginApi, serverName: string, toolNameMap: ToolNameMap): void {
  const toolNames = toolNameMap.get(serverName);
  if (toolNames) {
    for (const name of toolNames) {
      api.removeTool(name);
    }
    toolNameMap.delete(serverName);
  }
}

async function connectAndRegisterTools(
  api: WorkerPluginApi,
  manager: McpClientManager,
  serverName: string,
  config: McpServerConfig,
  toolNameMap: ToolNameMap,
): Promise<void> {
  try {
    await manager.connectOne(serverName, config);
    const mcpToolDefs = await manager.listTools(serverName);
    const caller = createServerCaller(manager, serverName);
    const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);

    const toolNames: string[] = [];
    for (const tool of adapted) {
      api.addTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: tool.execute,
      });
      toolNames.push(tool.name);
    }
    toolNameMap.set(serverName, toolNames);

    api.log.info("MCP hot-reload added server", { serverName, toolCount: adapted.length });
  } catch (err) {
    api.log.warn("MCP hot-reload failed to connect server", { serverName, error: String(err) });
  }
}

export default definePlugin({
  name: "mcp",

  async worker(api) {
    /** Per-instance tool name tracking, keyed by server name. */
    const toolNameMap: ToolNameMap = new Map();
    /** Mutable manager reference — shared with watcher so destroy always sees the current one. */
    const mcpState: { manager: McpClientManager | null } = { manager: null };

    const config = loadMcpConfig(api.workdir);
    if (!config || Object.keys(config.mcpServers).length === 0) {
      // Even with no initial config, watch for .mcp.json creation
      const watcher = setupConfigWatcher(api, mcpState, {
        currentMcpConfigJson: null,
        currentMcpServers: {},
      }, toolNameMap);
      return {
        destroy: async () => {
          await watcher?.close();
          await mcpState.manager?.closeAll();
        },
      };
    }

    mcpState.manager = new McpClientManager();
    await mcpState.manager.connectAll(config.mcpServers);

    const connectedServers = mcpState.manager.getConnectedServers();

    for (const serverName of connectedServers) {
      const mcpToolDefs = await mcpState.manager.listTools(serverName);
      const caller = createServerCaller(mcpState.manager, serverName);
      const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);

      const toolNames: string[] = [];
      for (const tool of adapted) {
        api.addTool(tool.name, {
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: tool.execute,
        });
        toolNames.push(tool.name);
      }
      toolNameMap.set(serverName, toolNames);

      api.log.info("MCP server provides tools", {
        serverName,
        toolCount: adapted.length,
      });
    }

    // Handle tool list changes from MCP servers (reconnect / ToolListChanged)
    mcpState.manager.onToolsChanged = async (serverName) => {
      api.log.debug("MCP tools changed, reloading", { serverName });
      try {
        const mcpToolDefs = await mcpState.manager!.listTools(serverName);
        const caller = createServerCaller(mcpState.manager!, serverName);
        const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);

        // Remove old tools for this server
        removeServerToolsTracked(api, serverName, toolNameMap);

        // Register new tools
        const toolNames: string[] = [];
        for (const tool of adapted) {
          api.addTool(tool.name, {
            description: tool.description,
            inputSchema: tool.inputSchema,
            execute: tool.execute,
          });
          toolNames.push(tool.name);
        }
        toolNameMap.set(serverName, toolNames);

        api.log.info("MCP tools reloaded", {
          serverName,
          toolCount: adapted.length,
        });
        await api.syncState();
      } catch (err) {
        api.log.warn("Failed to reload MCP tools", { serverName, error: String(err) });
      }
    };

    mcpState.manager.registerExitHandler();

    // Watch .mcp.json for hot-reload
    const watcherState = {
      currentMcpConfigJson: readMcpConfigRaw(api.workdir),
      currentMcpServers: config.mcpServers as Record<string, McpServerConfig>,
    };
    const watcher = setupConfigWatcher(api, mcpState, watcherState, toolNameMap);

    return {
      destroy: async () => {
        await watcher?.close();
        await mcpState.manager?.closeAll();
      },
    };
  },
});

function setupConfigWatcher(
  api: WorkerPluginApi,
  mcpState: { manager: McpClientManager | null },
  state: { currentMcpConfigJson: string | null; currentMcpServers: Record<string, McpServerConfig> },
  toolNameMap: ToolNameMap,
): ChokidarWatcher | null {
  let watcher: ChokidarWatcher;
  try {
    watcher = chokidarWatch([], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: WATCHER_DEBOUNCE_MS, pollInterval: 100 },
    });
  } catch {
    api.log.warn("Failed to start .mcp.json watcher");
    return null;
  }

  watcher.add(resolve(api.workdir, ".mcp.json"));

  // Serialization queue to prevent concurrent handler execution
  let pending: Promise<void> = Promise.resolve();

  watcher.on("all", (_event, filePath) => {
    if (!filePath.endsWith(".mcp.json")) return;

    pending = pending.then(async () => {
      // If no manager yet (started with no config), create one on demand
      if (!mcpState.manager) {
        const newRaw = readMcpConfigRaw(api.workdir);
        if (newRaw === state.currentMcpConfigJson) return;
        state.currentMcpConfigJson = newRaw;

        if (newRaw === null) return;

        try {
          JSON.parse(newRaw);
        } catch {
          api.log.warn("MCP config invalid JSON, skipping");
          state.currentMcpConfigJson = null;
          return;
        }

        let newConfig: Record<string, McpServerConfig>;
        try {
          const config = loadMcpConfig(api.workdir);
          if (!config) return;
          newConfig = config.mcpServers;
        } catch (err) {
          api.log.warn("MCP config parse error", { error: String(err) });
          return;
        }

        // Create manager and connect
        mcpState.manager = new McpClientManager();
        mcpState.manager.registerExitHandler();

        // Set up onToolsChanged handler
        mcpState.manager.onToolsChanged = async (serverName) => {
          api.log.debug("MCP tools changed, reloading", { serverName });
          try {
            const mcpToolDefs = await mcpState.manager!.listTools(serverName);
            const caller = createServerCaller(mcpState.manager!, serverName);
            const adapted = adaptMcpTools(serverName, mcpToolDefs, caller);
            removeServerToolsTracked(api, serverName, toolNameMap);
            const toolNames: string[] = [];
            for (const tool of adapted) {
              api.addTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema, execute: tool.execute });
              toolNames.push(tool.name);
            }
            toolNameMap.set(serverName, toolNames);
            await api.syncState();
          } catch (err) {
            api.log.warn("Failed to reload MCP tools", { serverName, error: String(err) });
          }
        };

        for (const [name, config] of Object.entries(newConfig)) {
          if (config.enabled === false) continue;
          await connectAndRegisterTools(api, mcpState.manager, name, config, toolNameMap);
        }
        state.currentMcpServers = newConfig;
        await api.syncState();
        return;
      }

      await handleMcpConfigChange(api, mcpState.manager, state, toolNameMap);
    }, () => { /* swallow errors from previous handler */ });
  });

  api.log.debug("Watching .mcp.json for hot-reload");
  return watcher;
}
