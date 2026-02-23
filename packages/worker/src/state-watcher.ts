import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import type { WorkerMetadata, WorkerSkillInfo, WorkerToolInfo } from "@molf-ai/protocol";
import { getLogger } from "@logtape/logtape";
import { loadSkills, loadAgentsDoc, SKILL_DIRS } from "./skills.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { McpClientManager } from "./mcp/client.js";
import { loadMcpConfig, adaptMcpTools, createServerCaller, sanitizeName, enforceToolLimit } from "./mcp/index.js";
import type { McpServerConfig } from "./mcp/index.js";

const logger = getLogger(["molf", "worker", "state"]);

export const WATCHER_DEBOUNCE_MS = 500;

export interface SyncStateFn {
  (state: {
    tools: WorkerToolInfo[];
    skills: WorkerSkillInfo[];
    metadata?: WorkerMetadata;
  }): Promise<void>;
}

export interface StateWatcherOptions {
  workdir: string;
  toolExecutor: ToolExecutor;
  mcpManager: McpClientManager | null;
  syncState: SyncStateFn;
}

/**
 * Watches the filesystem for changes to skills, MCP config, and project instructions.
 * Triggers syncState calls to the server when relevant state changes.
 *
 * Uses chokidar to watch glob patterns. This handles non-existent directories
 * (e.g. .agents/skills/ created at runtime) and provides stable cross-platform
 * file watching with built-in write stabilization.
 *
 * All handlers are serialized through a queue to prevent concurrent syncState
 * calls from racing and overwriting each other with stale snapshots.
 */
/** Interval for polling skill directory existence. */
const SKILL_DIR_POLL_MS = 5_000;

export class StateWatcher {
  private watcher: ChokidarWatcher | null = null;
  private skillDirPollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private workdir: string;
  private toolExecutor: ToolExecutor;
  private mcpManager: McpClientManager | null;
  private syncState: SyncStateFn;

  /** Serialization queue: ensures only one handler runs at a time. */
  private pending: Promise<void> = Promise.resolve();
  /** Skill dirs already added to chokidar. */
  private watchedSkillDirs = new Set<string>();

  /** Current effective agents doc content for change detection. */
  private currentAgentsDoc: string | undefined;
  /** Current skills for change detection. */
  private currentSkills: WorkerSkillInfo[];
  /** Current MCP config JSON for change detection. */
  private currentMcpConfigJson: string | null;
  /** Current parsed MCP server configs for diffing changed servers. */
  private currentMcpServers: Record<string, McpServerConfig> = {};

  constructor(opts: StateWatcherOptions) {
    this.workdir = opts.workdir;
    this.toolExecutor = opts.toolExecutor;
    this.mcpManager = opts.mcpManager;
    this.syncState = opts.syncState;

    // Snapshot current state for diffing
    const agentsDoc = loadAgentsDoc(this.workdir);
    this.currentAgentsDoc = agentsDoc?.content;
    this.currentSkills = loadSkills(this.workdir).skills;
    this.currentMcpConfigJson = this.readMcpConfigRaw();

    // Snapshot current MCP server configs
    try {
      const config = loadMcpConfig(this.workdir);
      if (config) this.currentMcpServers = config.mcpServers;
    } catch { /* ignore */ }
  }

  start(): void {
    // Chokidar glob patterns don't work on Bun — watch directories and
    // specific file paths instead, filtering by filename in the handler.
    this.watcher = chokidarWatch([], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: WATCHER_DEBOUNCE_MS, pollInterval: 100 },
    });

    // Add workdir-level file paths (chokidar watches the parent dir internally)
    this.watcher.add([
      resolve(this.workdir, ".mcp.json"),
      resolve(this.workdir, "AGENTS.md"),
      resolve(this.workdir, "CLAUDE.md"),
    ]);

    // Add existing skill directories for recursive watching
    this.addSkillDirs();

    // Poll for skill dirs that don't exist yet (created at runtime)
    if (this.watchedSkillDirs.size < SKILL_DIRS.length) {
      this.skillDirPollTimer = setInterval(() => this.addSkillDirs(), SKILL_DIR_POLL_MS);
    }

    this.watcher.on("all", (_event, filePath) => {
      if (this.closed) return;

      if (filePath.includes("/skills/") && filePath.endsWith("SKILL.md")) {
        this.enqueue(() => this.handleSkillsChange());
      } else if (filePath.endsWith(".mcp.json")) {
        this.enqueue(() => this.handleMcpConfigChange());
      } else if (filePath.endsWith("AGENTS.md") || filePath.endsWith("CLAUDE.md")) {
        this.enqueue(() => this.handleAgentsDocChange());
      }
    });
  }

  /** Add any newly created skill directories to the watcher. */
  private addSkillDirs(): void {
    for (const dir of SKILL_DIRS) {
      const full = resolve(this.workdir, dir);
      if (this.watchedSkillDirs.has(dir)) continue;
      if (!existsSync(full)) continue;

      this.watcher!.add(full);
      this.watchedSkillDirs.add(dir);
      logger.info("Watching skill directory", { dir });

      // Trigger a skill reload — the dir may already contain skills
      this.enqueue(() => this.handleSkillsChange());
    }

    // Stop polling once all dirs are watched
    if (this.watchedSkillDirs.size >= SKILL_DIRS.length && this.skillDirPollTimer) {
      clearInterval(this.skillDirPollTimer);
      this.skillDirPollTimer = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.skillDirPollTimer) {
      clearInterval(this.skillDirPollTimer);
      this.skillDirPollTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Enqueue a handler to run serially. Prevents concurrent syncState races. */
  private enqueue(fn: () => Promise<void>): void {
    this.pending = this.pending.then(fn, fn);
  }

  // --- Skills handler ---

  /** Check for skill changes. Public for testing. */
  async handleSkillsChange(): Promise<void> {
    const { skills: newSkills } = loadSkills(this.workdir);

    // Quick diff: compare serialized forms
    const oldJson = JSON.stringify(this.currentSkills);
    const newJson = JSON.stringify(newSkills);
    if (oldJson === newJson) return;

    this.currentSkills = newSkills;
    logger.info("Skills changed", { count: newSkills.length });

    await this.sendSyncState();
  }

  // --- MCP config handler ---

  private readMcpConfigRaw(): string | null {
    const configPath = resolve(this.workdir, ".mcp.json");
    if (!existsSync(configPath)) return null;
    try {
      return readFileSync(configPath, "utf-8");
    } catch {
      return null;
    }
  }

  /** Handle MCP config changes. Public for testing. */
  async handleMcpConfigChange(): Promise<void> {
    const newRaw = this.readMcpConfigRaw();

    // No actual change in raw content
    if (newRaw === this.currentMcpConfigJson) return;
    const oldRaw = this.currentMcpConfigJson;
    this.currentMcpConfigJson = newRaw;

    // Validate JSON before committing the change
    if (newRaw !== null) {
      try {
        JSON.parse(newRaw);
      } catch {
        logger.warn("MCP config invalid JSON, skipping reload");
        this.currentMcpConfigJson = oldRaw;
        return;
      }
    }

    if (!this.mcpManager) {
      await this.sendSyncState();
      return;
    }

    // Config deleted — stop all servers
    if (newRaw === null) {
      logger.info("MCP config deleted, stopping all servers");
      const connected = this.mcpManager.getConnectedServers();
      for (const name of connected) {
        const prefix = `${sanitizeName(name)}_`;
        const toRemove = this.toolExecutor.getToolNames().filter((n) => n.startsWith(prefix));
        if (toRemove.length > 0) this.toolExecutor.deregisterTools(toRemove);
        await this.mcpManager.disconnectOne(name);
      }
      this.currentMcpServers = {};
      await this.sendSyncState();
      return;
    }

    // Parse the new config
    let newConfig: Record<string, McpServerConfig>;
    try {
      const config = loadMcpConfig(this.workdir);
      if (!config) return;
      newConfig = config.mcpServers;
    } catch (err) {
      logger.warn("MCP config parse error, skipping reload", { error: err });
      return;
    }

    const currentServers = new Set(this.mcpManager.getConnectedServers());
    const newServerNames = new Set(Object.keys(newConfig));

    // Determine changes: added, removed, and changed (config differs)
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const name of newServerNames) {
      if (!currentServers.has(name)) {
        added.push(name);
      } else if (this.serverConfigChanged(name, newConfig[name])) {
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
      const prefix = `${sanitizeName(name)}_`;
      const toRemove = this.toolExecutor.getToolNames().filter((n) => n.startsWith(prefix));
      if (toRemove.length > 0) this.toolExecutor.deregisterTools(toRemove);
      await this.mcpManager.disconnectOne(name);
      added.push(name); // Re-add to trigger fresh connect
      logger.info("MCP hot-reload restarting server", { serverName: name });
    }

    // Apply removals
    for (const name of removed) {
      const prefix = `${sanitizeName(name)}_`;
      const toRemove = this.toolExecutor.getToolNames().filter((n) => n.startsWith(prefix));
      if (toRemove.length > 0) this.toolExecutor.deregisterTools(toRemove);
      await this.mcpManager.disconnectOne(name);
      logger.info("MCP hot-reload removed server", { serverName: name });
    }

    // Apply additions (includes changed servers that were disconnected above)
    for (const name of added) {
      const config = newConfig[name];
      if (config.enabled === false) continue;

      try {
        await this.mcpManager.connectOne(name, config);
        const mcpToolDefs = await this.mcpManager.listTools(name);
        const caller = createServerCaller(this.mcpManager, name);
        const adapted = adaptMcpTools(name, mcpToolDefs, caller);
        const currentCount = this.toolExecutor.getToolInfos().length;
        const allowed = enforceToolLimit(currentCount, adapted);
        if (allowed.length > 0) {
          this.toolExecutor.registerTools(allowed);
        }
        logger.info("MCP hot-reload added server", { serverName: name, toolCount: allowed.length });
      } catch (err) {
        logger.warn("MCP hot-reload failed to connect server", { serverName: name, error: err });
      }
    }

    // Update stored config for future diffs
    this.currentMcpServers = newConfig;

    if (removed.length > 0 || added.length > 0) {
      await this.sendSyncState();
    }
  }

  /** Compare a server's config against the previously stored config. */
  private serverConfigChanged(name: string, newConfig: McpServerConfig): boolean {
    const oldConfig = this.currentMcpServers[name];
    if (!oldConfig) return true; // no previous config means it's new
    return JSON.stringify(oldConfig) !== JSON.stringify(newConfig);
  }

  // --- AGENTS.md / CLAUDE.md handler ---

  /** Check for AGENTS.md/CLAUDE.md changes. Public for testing. */
  async handleAgentsDocChange(): Promise<void> {
    const doc = loadAgentsDoc(this.workdir);
    const newContent = doc?.content;

    if (newContent === this.currentAgentsDoc) return;

    this.currentAgentsDoc = newContent;
    logger.info("Project instructions changed", { source: doc?.source ?? "(cleared)" });

    await this.sendSyncState();
  }

  // --- Send sync state ---

  private async sendSyncState(): Promise<void> {
    try {
      await this.syncState({
        tools: this.toolExecutor.getToolInfos(),
        skills: this.currentSkills,
        metadata: { workdir: this.workdir, agentsDoc: this.currentAgentsDoc },
      });
    } catch (err) {
      logger.warn("syncState failed", { error: err });
    }
  }
}
