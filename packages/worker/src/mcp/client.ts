// Bun/MCP SDK compatibility: verified in Phase 0 spike (Task #1).
// SDK v1.26.0 works on Bun 1.3.x. StdioClientTransport uses newline-delimited
// JSON (not Content-Length framing). close() cleanly kills the subprocess.
// No special workarounds needed.

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";
import type { McpToolDef, McpToolCaller } from "./tool-adapter.js";

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 10_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_FACTOR = 1.5;
const RECONNECT_MAX_MS = 30_000;

const SAFE_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"];

function buildSafeEnv(declared: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  for (const [k, v] of Object.entries(declared)) {
    env[k] = v;
  }
  return env;
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface ManagedConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  config: McpServerConfig;
  closing: boolean;
}

/**
 * Manages connections to MCP servers via stdio or HTTP transport.
 * Use createServerCaller() to get a per-server McpToolCaller for adaptMcpTools.
 */
export class McpClientManager {
  private connections = new Map<string, ManagedConnection>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectingServers = new Set<string>();
  private managerClosing = false;
  private exitHandlerRegistered = false;

  /** Callback invoked when a server sends a ToolListChanged notification or reconnects. */
  onToolsChanged?: (serverName: string) => void;

  /**
   * Connect to all configured MCP servers in parallel.
   * Servers that fail to connect are skipped with a warning.
   */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connectOne(name, config)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        console.warn(
          `MCP: failed to connect to '${entries[i][0]}': ${result.reason}`,
        );
      }
    }
  }

  private async connectOne(name: string, config: McpServerConfig): Promise<void> {
    // Feature 4: skip disabled servers
    if (config.enabled === false) {
      console.log(`MCP: '${name}' is disabled, skipping`);
      return;
    }

    console.log(`MCP: connecting to '${name}'...`);

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    let client: Client;

    if (config.type === "stdio") {
      const stdioTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildSafeEnv(config.env),
        stderr: "pipe",
      });

      // Feature 3: stderr logging
      stdioTransport.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`MCP [${name}] stderr: ${chunk.toString().trimEnd()}`);
      });

      transport = stdioTransport;
      client = new Client({ name: "molf-worker", version: "0.1.0" });

      try {
        await raceWithTimeout(
          client.connect(transport),
          CONNECT_TIMEOUT_MS,
          `Connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
        );
      } catch (err) {
        try { await transport.close(); } catch { /* ignore cleanup errors */ }
        throw err;
      }
    } else {
      const url = new URL(config.url);
      const headers = config.headers;

      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      client = new Client({ name: "molf-worker", version: "0.1.0" });

      try {
        await raceWithTimeout(
          client.connect(transport),
          CONNECT_TIMEOUT_MS,
          `Connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
        );
      } catch (err) {
        try { await transport.close(); } catch { /* ignore cleanup errors */ }
        throw err;
      }
    }

    // Feature 5: ToolListChanged notification handler
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      this.onToolsChanged?.(name);
    });

    this.connections.set(name, { client, transport, config, closing: false });
    this.reconnectingServers.delete(name);
    console.log(`MCP: '${name}' connected`);

    client.onclose = () => {
      const conn = this.connections.get(name);
      // Bail if: intentional close, Map cleared, or stale closure after reconnect
      if (!conn || conn.closing || conn.client !== client) return;
      this.reconnectingServers.add(name);
      this.connections.delete(name);
      this.scheduleReconnect(name, conn.config);
    };
  }

  private scheduleReconnect(
    name: string,
    config: McpServerConfig,
    delayMs = RECONNECT_INITIAL_MS,
  ): void {
    if (this.managerClosing) return;
    console.log(`MCP: '${name}' disconnected, reconnecting in ${delayMs}ms...`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name);
      if (this.managerClosing) return;
      try {
        await this.connectOne(name, config);
        console.log(`MCP: '${name}' reconnected`);
        this.onToolsChanged?.(name);
      } catch {
        const next = Math.min(delayMs * RECONNECT_FACTOR, RECONNECT_MAX_MS);
        console.warn(`MCP: '${name}' reconnect failed, retrying in ${next}ms`);
        this.scheduleReconnect(name, config, next);
      }
    }, delayMs);

    this.reconnectTimers.set(name, timer);
  }

  /**
   * List tools available from a connected server.
   */
  async listTools(serverName: string): Promise<McpToolDef[]> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      const msg = this.reconnectingServers.has(serverName)
        ? `MCP server '${serverName}' is offline — reconnecting...`
        : `MCP server '${serverName}' is not connected`;
      throw new Error(msg);
    }

    const result = await raceWithTimeout(
      conn.client.listTools(),
      LIST_TIMEOUT_MS,
      `MCP listTools '${serverName}' timed out after ${LIST_TIMEOUT_MS}ms`,
    );
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpToolDef["inputSchema"],
    }));
  }

  /**
   * Call a tool on a specific named server with a 60s timeout.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: any[]; isError?: boolean }> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      const msg = this.reconnectingServers.has(serverName)
        ? `MCP server '${serverName}' is offline — reconnecting...`
        : `MCP server '${serverName}' is not connected`;
      throw new Error(msg);
    }

    const result = await raceWithTimeout(
      conn.client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP tool call '${toolName}' timed out after ${CALL_TIMEOUT_MS}ms`,
    );

    const r = result as { content?: unknown[]; isError?: boolean };
    return {
      content: Array.isArray(r?.content) ? r.content : [],
      isError: r?.isError === true,
    };
  }

  /**
   * Get list of connected server names.
   */
  getConnectedServers(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Register a process exit handler that SIGTERMs all MCP stdio subprocesses.
   * Call once from worker index.ts after connectAll().
   * Idempotent — calling twice is safe.
   */
  registerExitHandler(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    process.on("exit", () => {
      for (const [, conn] of this.connections) {
        if (conn.transport instanceof StdioClientTransport) {
          const pid = conn.transport.pid;
          if (pid != null) {
            try { process.kill(pid, "SIGTERM"); } catch { /* process may already be dead */ }
          }
        }
      }
    });
  }

  /**
   * Gracefully close all connections and cancel pending reconnects.
   */
  async closeAll(): Promise<void> {
    this.managerClosing = true;

    // Cancel pending reconnect timers
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectingServers.clear();

    // Mark connections as closing so onclose from transport.close() won't reconnect
    for (const conn of this.connections.values()) conn.closing = true;

    const entries = Array.from(this.connections.entries());
    this.connections.clear();

    await Promise.allSettled(
      entries.map(async ([name, { transport }]) => {
        try { await transport.close(); }
        catch { console.warn(`MCP: error closing '${name}'`); }
      }),
    );
  }
}

/**
 * Create an McpToolCaller scoped to a specific server.
 * This bridges the McpToolCaller interface (which takes name + args)
 * to McpClientManager.callTool (which needs serverName).
 */
export function createServerCaller(
  manager: McpClientManager,
  serverName: string,
): McpToolCaller {
  return {
    callTool: (name, args) => manager.callTool(serverName, name, args),
  };
}
