import picomatch from "picomatch";
import type { Rule, RuleAction, Ruleset, CompactPermission } from "./types.js";
import { expand } from "./expand.js";

/**
 * Check if a value matches a glob pattern.
 * Uses picomatch with bash-like globbing: `*` matches across `/` (path separators)
 * and matches dotfiles. This is correct for both shell command patterns
 * and file path patterns in our context.
 */
export function patternMatches(value: string, glob: string): boolean {
  return picomatch.isMatch(value, glob, { dot: true, bash: true });
}

/**
 * Extract patterns to check for a given tool call.
 * Returns the values that will be matched against allow/deny globs.
 *
 * For shell_exec, this is handled externally by the shell parser.
 * This function handles simpler tools.
 */
export function extractPatterns(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file": {
      const path = args.path ?? args.file_path;
      return typeof path === "string" ? [path] : [];
    }
    case "glob": {
      const pattern = args.pattern ?? args.path;
      return typeof pattern === "string" ? [pattern] : [];
    }
    case "grep": {
      const path = args.path;
      return typeof path === "string" ? [path] : [];
    }
    case "skill": {
      const name = args.name;
      return typeof name === "string" ? [name] : [];
    }
    default: {
      // MCP tools: use the full tool name as the pattern
      if (toolName.startsWith("mcp:")) {
        return [toolName];
      }
      return [];
    }
  }
}

/**
 * Evaluate a tool call against one or more flat rulesets.
 * Rulesets are merged in order and searched with findLast semantics
 * (last matching rule wins).
 *
 * For a single pattern: findLast matching rule, return its action (default "ask").
 * For multiple patterns (shell pipes): most restrictive wins (deny > ask > allow).
 * For no patterns: evaluate with pattern "*".
 */
export function evaluate(
  permission: string,
  patterns: string[],
  ...rulesets: Ruleset[]
): RuleAction {
  if (patterns.length === 0) {
    return evaluateSingle(permission, "*", rulesets);
  }

  if (patterns.length === 1) {
    return evaluateSingle(permission, patterns[0], rulesets);
  }

  // Multiple patterns (shell pipes/chains): most restrictive wins
  let worst: RuleAction = "allow";
  for (const p of patterns) {
    const action = evaluateSingle(permission, p, rulesets);
    if (action === "deny") return "deny";
    if (action === "ask") worst = "ask";
  }
  return worst;
}

/**
 * Find all rules matching a permission+pattern combo across one or more rulesets.
 * Useful for building informative deny messages.
 */
export function findMatchingRules(
  permission: string,
  pattern: string,
  ...rulesets: Ruleset[]
): Rule[] {
  return rulesets.flat().filter(
    r => patternMatches(permission, r.permission) && patternMatches(pattern, r.pattern),
  );
}

/**
 * Convert a compact permission config to a flat Ruleset.
 * Applies path expansion (`~/`, `$HOME/`) to all patterns.
 */
export function fromConfig(config: CompactPermission): Ruleset {
  const rules: Ruleset = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      // Simple action: e.g. "glob": "allow" → { permission: "glob", pattern: "*", action: "allow" }
      rules.push({ permission, pattern: "*", action: value });
    } else {
      // Detailed patterns: e.g. "read_file": { "*": "allow", "*.env": "deny" }
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({ permission, pattern: expand(pattern), action });
      }
    }
  }
  return rules;
}

/**
 * Convert a flat Ruleset back to a CompactPermission config.
 * Inverse of `fromConfig()`. Used for persisting rulesets in compact format.
 */
export function toConfig(ruleset: Ruleset): CompactPermission {
  const config: CompactPermission = {};
  for (const { permission, pattern, action } of ruleset) {
    const existing = config[permission];
    if (existing === undefined) {
      // First rule for this permission
      if (pattern === "*") {
        config[permission] = action;
      } else {
        config[permission] = { [pattern]: action };
      }
    } else if (typeof existing === "string") {
      // Was simple, promote to object
      config[permission] = { "*": existing, [pattern]: action };
    } else {
      existing[pattern] = action;
    }
  }
  return config;
}

function evaluateSingle(
  permission: string,
  pattern: string,
  rulesets: Ruleset[],
): RuleAction {
  const merged = rulesets.flat();
  const match = merged.findLast(
    r => patternMatches(permission, r.permission) && patternMatches(pattern, r.pattern),
  );
  return match?.action ?? "ask";
}
