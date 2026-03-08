import { existsSync } from "fs";
import { resolve } from "path";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import type { WorkerAgentInfo, WorkerSkillInfo } from "@molf-ai/protocol";
import { getLogger } from "@logtape/logtape";
import { loadSkills, loadAgentsDoc, SKILL_DIRS } from "./skills.js";
import { loadAgents, AGENT_DIRS } from "./agents.js";

const logger = getLogger(["molf", "worker", "state"]);

export const WATCHER_DEBOUNCE_MS = 500;

export interface StateWatcherOptions {
  workdir: string;
  onSkillsChange?: (skills: WorkerSkillInfo[]) => void;
  onAgentsChange?: (agents: WorkerAgentInfo[]) => void;
  onAgentsDocChange?: (agentsDoc: string | undefined) => void;
  requestSync: () => void;
}

/**
 * Watches the filesystem for changes to skills, agents, and project instructions.
 * Triggers syncState calls to the server when relevant state changes.
 *
 * Uses chokidar to watch glob patterns. This handles non-existent directories
 * (e.g. .agents/skills/ created at runtime) and provides stable cross-platform
 * file watching with built-in write stabilization.
 *
 * All handlers are serialized through a queue to prevent concurrent syncState
 * calls from racing and overwriting each other with stale snapshots.
 *
 * MCP config watching is handled by the MCP plugin itself.
 */
/** Interval for polling skill directory existence. */
const SKILL_DIR_POLL_MS = 5_000;

export class StateWatcher {
  private watcher: ChokidarWatcher | null = null;
  private skillDirPollTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private workdir: string;
  private opts: StateWatcherOptions;

  /** Serialization queue: ensures only one handler runs at a time. */
  private pending: Promise<void> = Promise.resolve();
  /** Skill dirs already added to chokidar. */
  private watchedSkillDirs = new Set<string>();
  /** Agent dirs already added to chokidar. */
  private watchedAgentDirs = new Set<string>();

  /** Current effective agents doc content for change detection. */
  private currentAgentsDoc: string | undefined;
  /** Current skills for change detection. */
  private currentSkills: WorkerSkillInfo[];
  /** Current agents for change detection. */
  private currentAgents: WorkerAgentInfo[];

  constructor(opts: StateWatcherOptions) {
    this.workdir = opts.workdir;
    this.opts = opts;

    // Snapshot current state for diffing
    const agentsDoc = loadAgentsDoc(this.workdir);
    this.currentAgentsDoc = agentsDoc?.content;
    this.currentSkills = loadSkills(this.workdir).skills;
    this.currentAgents = loadAgents(this.workdir).agents;
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
      resolve(this.workdir, "AGENTS.md"),
      resolve(this.workdir, "CLAUDE.md"),
    ]);

    // Add existing skill and agent directories for recursive watching
    this.addSkillDirs();
    this.addAgentDirs();

    // Poll for skill/agent dirs that don't exist yet (created at runtime)
    if (this.watchedSkillDirs.size < SKILL_DIRS.length || this.watchedAgentDirs.size < AGENT_DIRS.length) {
      this.skillDirPollTimer = setInterval(() => {
        this.addSkillDirs();
        this.addAgentDirs();
      }, SKILL_DIR_POLL_MS);
      this.skillDirPollTimer.unref();
    }

    this.watcher.on("all", (_event, filePath) => {
      if (this.closed) return;

      if (filePath.includes("/skills/") && filePath.endsWith("SKILL.md")) {
        this.enqueue(() => this.handleSkillsChange());
      } else if (filePath.includes("/agents/") && filePath.endsWith(".md")) {
        this.enqueue(() => this.handleAgentsChange());
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
    if (
      this.watchedSkillDirs.size >= SKILL_DIRS.length &&
      this.watchedAgentDirs.size >= AGENT_DIRS.length &&
      this.skillDirPollTimer
    ) {
      clearInterval(this.skillDirPollTimer);
      this.skillDirPollTimer = null;
    }
  }

  /** Add any newly created agent directories to the watcher. */
  private addAgentDirs(): void {
    for (const dir of AGENT_DIRS) {
      const full = resolve(this.workdir, dir);
      if (this.watchedAgentDirs.has(dir)) continue;
      if (!existsSync(full)) continue;

      this.watcher!.add(full);
      this.watchedAgentDirs.add(dir);
      logger.info("Watching agent directory", { dir });

      // Trigger an agent reload — the dir may already contain agents
      this.enqueue(() => this.handleAgentsChange());
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

    this.opts.onSkillsChange?.(newSkills);
    this.opts.requestSync();
  }

  // --- Agents handler ---

  /** Check for agent changes. Public for testing. */
  async handleAgentsChange(): Promise<void> {
    const { agents: newAgents } = loadAgents(this.workdir);

    const oldJson = JSON.stringify(this.currentAgents);
    const newJson = JSON.stringify(newAgents);
    if (oldJson === newJson) return;

    this.currentAgents = newAgents;
    logger.info("Agents changed", { count: newAgents.length });

    this.opts.onAgentsChange?.(newAgents);
    this.opts.requestSync();
  }

  // --- AGENTS.md / CLAUDE.md handler ---

  /** Check for AGENTS.md/CLAUDE.md changes. Public for testing. */
  async handleAgentsDocChange(): Promise<void> {
    const doc = loadAgentsDoc(this.workdir);
    const newContent = doc?.content;

    if (newContent === this.currentAgentsDoc) return;

    this.currentAgentsDoc = newContent;
    logger.info("Project instructions changed", { source: doc?.source ?? "(cleared)" });

    this.opts.onAgentsDocChange?.(newContent);
    this.opts.requestSync();
  }
}
