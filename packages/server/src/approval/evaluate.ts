import picomatch from "picomatch";
import type { RuleAction, ToolRule, GroupedRuleset } from "./types.js";

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
 * Find the matching tool rule from a ruleset.
 * Checks exact tool name first, then falls back to `*` wildcard.
 */
function findToolRule(toolName: string, ruleset: GroupedRuleset): ToolRule | undefined {
  return ruleset.rules[toolName] ?? ruleset.rules["*"];
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
 * Evaluate a tool call against one or more rulesets.
 *
 * For a single pattern:
 *   1. Find matching tool entry (exact name, then `*` wildcard)
 *   2. Check `deny` across ALL rulesets — any match -> deny
 *   3. Check `allow` across ALL rulesets (later rulesets first) — any match -> allow
 *   4. Fall back to `default`
 *
 * For multiple patterns (shell commands with pipes/chains):
 *   - any deny -> deny
 *   - any ask -> ask
 *   - all allow -> allow
 */
export function evaluate(
  toolName: string,
  patterns: string[],
  ...rulesets: GroupedRuleset[]
): RuleAction {
  if (patterns.length === 0) {
    // No patterns — just use the default action
    return evaluateDefault(toolName, rulesets);
  }

  if (patterns.length === 1) {
    return evaluateSingle(toolName, patterns[0], rulesets);
  }

  // Multiple patterns (shell pipes/chains): aggregate results
  let hasAsk = false;
  for (const pattern of patterns) {
    const action = evaluateSingle(toolName, pattern, rulesets);
    if (action === "deny") return "deny";
    if (action === "ask") hasAsk = true;
  }
  return hasAsk ? "ask" : "allow";
}

function evaluateSingle(
  toolName: string,
  pattern: string,
  rulesets: GroupedRuleset[],
): RuleAction {
  // 1. Check deny across ALL rulesets — any match -> deny
  for (const ruleset of rulesets) {
    const rule = findToolRule(toolName, ruleset);
    if (rule?.deny) {
      for (const denyGlob of rule.deny) {
        if (patternMatches(pattern, denyGlob)) {
          return "deny";
        }
      }
    }
  }

  // 2. Check allow across ALL rulesets (later rulesets = higher priority, check last first)
  for (let i = rulesets.length - 1; i >= 0; i--) {
    const rule = findToolRule(toolName, rulesets[i]);
    if (rule?.allow) {
      for (const allowGlob of rule.allow) {
        if (patternMatches(pattern, allowGlob)) {
          return "allow";
        }
      }
    }
  }

  // 3. Fall back to default
  return evaluateDefault(toolName, rulesets);
}

function evaluateDefault(
  toolName: string,
  rulesets: GroupedRuleset[],
): RuleAction {
  // Check most specific tool rule's default (later rulesets override)
  for (let i = rulesets.length - 1; i >= 0; i--) {
    const rule = rulesets[i].rules[toolName];
    if (rule) return rule.default;
  }
  // Fall back to wildcard rule's default
  for (let i = rulesets.length - 1; i >= 0; i--) {
    const rule = rulesets[i].rules["*"];
    if (rule) return rule.default;
  }
  return "ask";
}
