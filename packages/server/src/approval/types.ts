export type RuleAction = "allow" | "deny" | "ask";

export interface ToolRule {
  default: RuleAction;
  allow?: string[];
  deny?: string[];
}

export interface GroupedRuleset {
  version: number;
  rules: Record<string, ToolRule>;
}

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

