import { getLogger } from "@logtape/logtape";
import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { GroupedRuleset } from "./types.js";
import { DEFAULT_RULESET } from "./defaults.js";
import { serializeRuleset } from "./serialize.js";

const logger = getLogger(["molf", "server", "approval"]);

/**
 * Manages per-worker permission rulesets stored as JSONC files on disk.
 */
export class RulesetStorage {
  constructor(private dataDir: string) {}

  /**
   * Load the ruleset for a worker.
   * Reads from `data/workers/{workerId}/permissions.jsonc`, falls back to DEFAULT_RULESET.
   */
  load(workerId: string): GroupedRuleset {
    const filePath = resolve(this.dataDir, "workers", workerId, "permissions.jsonc");

    if (!existsSync(filePath)) {
      this.seed(filePath);
      return DEFAULT_RULESET;
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const stripped = stripJsonComments(raw);
      const parsed = JSON.parse(stripped) as GroupedRuleset;

      if (!parsed.version || !parsed.rules) {
        logger.warn("Invalid permissions file, using defaults", { workerId, filePath });
        return DEFAULT_RULESET;
      }

      return parsed;
    } catch (err) {
      logger.warn("Failed to load permissions file, using defaults", { workerId, filePath, error: err });
      return DEFAULT_RULESET;
    }
  }
  /**
   * Add allow patterns to a worker's permissions file and persist to disk.
   */
  addAllowPatterns(workerId: string, toolName: string, patterns: string[]): void {
    if (patterns.length === 0) return;

    const ruleset = this.load(workerId);

    if (!ruleset.rules[toolName]) {
      ruleset.rules[toolName] = { default: "ask", allow: [] };
    }
    const rule = ruleset.rules[toolName];
    if (!rule.allow) rule.allow = [];

    let added = false;
    for (const p of patterns) {
      if (!rule.allow.includes(p)) {
        rule.allow.push(p);
        added = true;
      }
    }

    if (!added) return;

    const filePath = resolve(this.dataDir, "workers", workerId, "permissions.jsonc");
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, serializeRuleset(ruleset), "utf-8");
      logger.info("Persisted always-approve patterns", { workerId, toolName, patterns });
    } catch (err) {
      logger.warn("Failed to persist always-approve patterns", { workerId, toolName, error: err });
    }
  }

  /**
   * Write the default permissions.jsonc to disk so the user can customize it.
   */
  private seed(filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, serializeRuleset(DEFAULT_RULESET), "utf-8");
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
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2; // skip closing */
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}
