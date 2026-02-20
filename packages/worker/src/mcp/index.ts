export { loadMcpConfig, interpolateEnv } from "./config.js";
export type { McpConfig, McpServerConfig } from "./config.js";
export { adaptMcpTools, sanitizeName } from "./tool-adapter.js";
export type { McpToolCaller, McpToolDef } from "./tool-adapter.js";
export { McpClientManager, createServerCaller } from "./client.js";

import type { WorkerTool } from "../tool-executor.js";
import { loadMcpConfig } from "./config.js";
import { adaptMcpTools } from "./tool-adapter.js";
import { McpClientManager, createServerCaller } from "./client.js";

const TOOL_WARN_THRESHOLD = 30;
const TOOL_HARD_CAP = 50;

/**
 * Load MCP tools from the workdir's .molf/mcp.json config.
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
    console.log(`MCP: '${serverName}' provides ${adapted.length} tools`);
  }

  return { tools: allTools, manager };
}

/**
 * Enforce the tool count limit. Returns the subset of newTools that fit
 * within the hard cap, given the currentToolCount of already-registered tools.
 * Logs warnings at the threshold and drops tools that exceed the cap.
 */
export function enforceToolLimit(
  currentToolCount: number,
  newTools: WorkerTool[],
): WorkerTool[] {
  const total = currentToolCount + newTools.length;

  if (total > TOOL_HARD_CAP) {
    const allowed = TOOL_HARD_CAP - currentToolCount;
    if (allowed <= 0) {
      console.warn(
        `MCP: tool limit reached (${currentToolCount} builtins, cap ${TOOL_HARD_CAP}). All ${newTools.length} MCP tools dropped.`,
      );
      return [];
    }

    const kept = newTools.slice(0, allowed);
    const dropped = newTools.slice(allowed);
    console.warn(
      `MCP: tool limit reached (${total} total, cap ${TOOL_HARD_CAP}). Dropped ${dropped.length} tools: ${dropped.map((t) => t.name).join(", ")}`,
    );
    return kept;
  }

  if (total >= TOOL_WARN_THRESHOLD) {
    console.warn(
      `Warning: ${total} tools registered (30+ may affect LLM accuracy). Consider reducing MCP servers.`,
    );
  }

  return newTools;
}
