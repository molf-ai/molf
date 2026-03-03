export type RuleAction = "allow" | "deny" | "ask";

export interface Rule {
  /** Tool name or wildcard pattern (e.g. "shell_exec", "mcp:*", "*") */
  permission: string;
  /** Value pattern — file path, shell command, skill name, etc. */
  pattern: string;
  /** What to do when both permission and pattern match */
  action: RuleAction;
}

export type Ruleset = Rule[];

/**
 * Compact permission config format.
 * Keys are tool names (or "*" for catch-all).
 * Values are either a simple action or a map of pattern → action.
 *
 * Example:
 * ```
 * { "*": "ask", "read_file": { "*": "allow", "*.env": "deny" }, "glob": "allow" }
 * ```
 */
export type CompactPermission = Record<string, RuleAction | Record<string, RuleAction>>;

export interface PendingApproval {
  resolve: () => void;
  reject: (err: Error) => void;
  promise: Promise<void>;
  /** JSON-stringified args */
  args: string;
  sessionId: string;
  workerId: string;
  toolName: string;
  /** Exact command/pattern text shown to the user */
  patterns: string[];
  /** Arity-derived globs for "always approve" */
  alwaysPatterns: string[];
}

