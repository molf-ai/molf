import { getLogger } from "@logtape/logtape";
import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { parse as parseJsonc, modify, applyEdits, type ModificationOptions } from "jsonc-parser";
import type { CompactPermission, Ruleset } from "./types.js";
import { DEFAULT_RULESET, DEFAULT_CONFIG } from "./defaults.js";
import { fromConfig } from "./evaluate.js";
import { serializeCompactConfig } from "./serialize.js";
import { toConfig } from "./evaluate.js";
import { expand } from "./expand.js";

const logger = getLogger(["molf", "server", "approval"]);

const MODIFY_OPTS: ModificationOptions = {
  formattingOptions: { tabSize: 2, insertSpaces: true },
};

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
      const parsed = parseJsonc(raw);

      if (Array.isArray(parsed)) {
        // New flat format
        return expandPatterns(parsed as Ruleset);
      }

      // Compact config format — { "tool": "action" | { "pattern": "action" } }
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
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
   * Uses jsonc-parser modify() to preserve comments and formatting.
   * Appends rules to end (last = highest priority), deduplicates.
   */
  addAllowPatterns(workerId: string, toolName: string, patterns: string[]): void {
    if (patterns.length === 0) return;

    const filePath = resolve(this.dataDir, "workers", workerId, "permissions.jsonc");

    try {
      // Read existing file as text (or create default)
      let text = "";
      if (existsSync(filePath)) {
        text = readFileSync(filePath, "utf-8");
      } else {
        this.seed(filePath);
        text = readFileSync(filePath, "utf-8");
      }

      const parsed = parseJsonc(text);
      if (!parsed || typeof parsed !== "object") {
        // Fallback to full regeneration for corrupt files
        const ruleset = this.load(workerId);
        for (const p of patterns) {
          if (!ruleset.some(r => r.permission === toolName && r.pattern === p && r.action === "allow")) {
            ruleset.push({ permission: toolName, pattern: p, action: "allow" });
          }
        }
        this.saveFull(workerId, ruleset);
        return;
      }

      // Use modify() to update the specific tool's entry, preserving comments
      const existing = parsed[toolName];
      for (const p of patterns) {
        // Check if this pattern is already allowed
        if (typeof existing === "string" && existing === "allow") continue;
        if (typeof existing === "object" && existing !== null && existing[p] === "allow") continue;

        if (typeof existing === "string" || existing === undefined) {
          // Tool has a simple action or doesn't exist — convert to object with patterns
          const newValue: Record<string, string> = {};
          if (typeof existing === "string") {
            newValue["*"] = existing;
          }
          newValue[p] = "allow";
          const edits = modify(text, [toolName], newValue, MODIFY_OPTS);
          text = applyEdits(text, edits);
        } else {
          // Tool already has pattern object — add the new pattern
          const edits = modify(text, [toolName, p], "allow", MODIFY_OPTS);
          text = applyEdits(text, edits);
        }
      }

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, text, "utf-8");
      logger.info("Persisted permissions (incremental)", { workerId });
    } catch (err) {
      logger.warn("Failed to persist permissions incrementally, falling back to full save", { workerId, error: err });
      // Fallback to full regeneration
      const ruleset = this.load(workerId);
      for (const p of patterns) {
        if (!ruleset.some(r => r.permission === toolName && r.pattern === p && r.action === "allow")) {
          ruleset.push({ permission: toolName, pattern: p, action: "allow" });
        }
      }
      this.saveFull(workerId, ruleset);
    }
  }

  /** Full regeneration save (used for seed and fallback). */
  private saveFull(workerId: string, ruleset: Ruleset): void {
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
