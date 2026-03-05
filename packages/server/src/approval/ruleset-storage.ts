import { getLogger } from "@logtape/logtape";
import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { CompactPermission, Ruleset } from "./types.js";
import { DEFAULT_RULESET, DEFAULT_CONFIG } from "./defaults.js";
import { fromConfig } from "./evaluate.js";
import { serializeCompactConfig } from "./serialize.js";
import { toConfig } from "./evaluate.js";
import { expand } from "./expand.js";

const logger = getLogger(["molf", "server", "approval"]);

/** Expand `~/` and `$HOME/` in all rule patterns. */
function expandPatterns(ruleset: Ruleset): Ruleset {
  return ruleset.map(r => ({
    ...r,
    pattern: expand(r.pattern),
  }));
}

/**
 * Manages per-worker permission rulesets stored as JSONC files on disk.
 */
export class RulesetStorage {
  constructor(private dataDir: string) {}

  /**
   * Load the ruleset for a worker.
   * Reads from `data/workers/{workerId}/permissions.jsonc`, falls back to DEFAULT_RULESET.
   * Auto-migrates old grouped format to flat format on first load.
   */
  load(workerId: string): Ruleset {
    const filePath = resolve(this.dataDir, "workers", workerId, "permissions.jsonc");

    if (!existsSync(filePath)) {
      this.seed(filePath);
      return expandPatterns([...DEFAULT_RULESET]);
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const stripped = stripJsonComments(raw);
      const parsed = JSON.parse(stripped);

      if (Array.isArray(parsed)) {
        // New flat format
        return expandPatterns(parsed as Ruleset);
      }

      // Compact config format — { "tool": "action" | { "pattern": "action" } }
      if (parsed && typeof parsed === "object") {
        return expandPatterns(fromConfig(parsed as CompactPermission));
      }

      logger.warn("Invalid permissions file, using defaults", { workerId, filePath });
      return expandPatterns([...DEFAULT_RULESET]);
    } catch (err) {
      logger.warn("Failed to load permissions file, using defaults", { workerId, filePath, error: err });
      return expandPatterns([...DEFAULT_RULESET]);
    }
  }

  /**
   * Add allow patterns to a worker's permissions file and persist to disk.
   * Appends rules to end (last = highest priority), deduplicates.
   */
  addAllowPatterns(workerId: string, toolName: string, patterns: string[]): void {
    if (patterns.length === 0) return;

    const ruleset = this.load(workerId);

    for (const p of patterns) {
      if (!ruleset.some(r => r.permission === toolName && r.pattern === p && r.action === "allow")) {
        ruleset.push({ permission: toolName, pattern: p, action: "allow" });
      }
    }

    this.save(workerId, ruleset);
  }

  /** Save a ruleset to disk for a worker. */
  private save(workerId: string, ruleset: Ruleset): void {
    const filePath = resolve(this.dataDir, "workers", workerId, "permissions.jsonc");
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, serializeCompactConfig(toConfig(ruleset)), "utf-8");
      logger.info("Persisted permissions", { workerId });
    } catch (err) {
      logger.warn("Failed to persist permissions", { workerId, error: err });
    }
  }

  /**
   * Write the default permissions.jsonc to disk so the user can customize it.
   */
  private seed(filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, serializeCompactConfig(DEFAULT_CONFIG), "utf-8");
      logger.info("Created default permissions file", { filePath });
    } catch (err) {
      logger.warn("Failed to seed permissions file", { filePath, error: err });
    }
  }
}

/**
 * Strip single-line (//) and multi-line comments from JSONC.
 * Respects quoted strings (won't strip // inside strings).
 */
function stripJsonComments(input: string): string {
  let result = "";
  let i = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      result += ch;
      if (ch === "\\" && i + 1 < input.length) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    // Single-line comment
    if (ch === "/" && next === "/") {
      // Skip until end of line
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      if (i + 1 < input.length) {
        i += 2; // skip closing */
      } else {
        i = input.length; // unterminated comment — skip remaining input
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}
