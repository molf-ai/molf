import { getLogger } from "@logtape/logtape";
import type { ServerBus } from "../server-bus.js";
import type { RulesetStorage } from "./ruleset-storage.js";
import type { Rule, Ruleset, PendingApproval } from "./types.js";
import { evaluate, extractPatterns, findMatchingRules } from "./evaluate.js";
import { parseShellCommand } from "./shell-parser.js";

const logger = getLogger(["molf", "server", "approval"]);

/**
 * Error thrown when a tool call is denied by static rules (unconditional deny).
 * The LLM receives this as a tool error result so it can adjust.
 */
export class ToolDeniedError extends Error {
  public matchingRules: Rule[];
  constructor(toolName: string, pattern?: string, matchingRules: Rule[] = []) {
    const base = pattern
      ? `Tool "${toolName}" denied by policy for pattern: ${pattern}`
      : `Tool "${toolName}" denied by policy`;
    const suffix = matchingRules.length > 0
      ? `\nRelevant rules: ${JSON.stringify(matchingRules)}`
      : "";
    super(base + suffix);
    this.name = "ToolDeniedError";
    this.matchingRules = matchingRules;
  }
}

/**
 * Error thrown when the user rejects a tool approval request.
 * May include user feedback.
 */
export class ToolRejectedError extends Error {
  public feedback?: string;
  constructor(toolName: string, feedback?: string) {
    const base = `Tool "${toolName}" rejected by user`;
    super(feedback ? `${base}: ${feedback}` : base);
    this.name = "ToolRejectedError";
    this.feedback = feedback;
  }
}

export class ApprovalGate {
  /** Runtime "always approve" patterns accumulated from user responses, keyed by sessionId */
  private runtimeApprovals = new Map<string, Ruleset>();
  /** Agent permission rulesets for subagent sessions, keyed by sessionId */
  private agentPermissions = new Map<string, Ruleset>();
  /** Pending approval requests, keyed by approvalId */
  private pending = new Map<string, PendingApproval>();

  constructor(
    private storage: RulesetStorage,
    private serverBus: ServerBus,
    private enabled: boolean = true,
  ) {}

  /**
   * Evaluate rules for a tool call — no blocking, no events.
   * Async because parseShellCommand() uses lazy-init tree-sitter.
   * After first call, the parser is cached and this resolves instantly.
   */
  async evaluate(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    workerId: string,
  ): Promise<{ action: "allow" | "deny" | "ask"; patterns: string[]; alwaysPatterns: string[]; matchingRules?: Rule[] }> {
    // When approval is disabled, allow everything
    if (!this.enabled) {
      return { action: "allow", patterns: [], alwaysPatterns: [] };
    }

    // 1. Compute patterns
    let patterns: string[];
    let alwaysPatterns: string[];

    if (toolName === "shell_exec" && typeof args.command === "string") {
      const parsed = await parseShellCommand(args.command);
      patterns = parsed.patterns;
      alwaysPatterns = parsed.always;
    } else {
      patterns = extractPatterns(toolName, args);
      // For non-shell tools, always pattern = exact pattern (no arity)
      alwaysPatterns = patterns.length > 0 ? patterns : [];
    }

    // 2. Load static ruleset
    const staticRuleset = this.storage.load(workerId);

    // 3. Get runtime ruleset for session
    const runtimeRuleset = this.runtimeApprovals.get(sessionId);

    // 4. Agent deny = veto: if the agent layer alone evaluates to "deny", short-circuit.
    //    Agent allow/ask can still be overridden by later layers.
    const agentRuleset = this.agentPermissions.get(sessionId);
    if (agentRuleset) {
      const agentAction = evaluate(toolName, patterns, agentRuleset);
      if (agentAction === "deny") {
        const effectivePatterns = patterns.length > 0 ? patterns : ["*"];
        const rules = effectivePatterns.flatMap(
          p => findMatchingRules(toolName, p, agentRuleset),
        );
        const seen = new Set<string>();
        const matchingRules = rules.filter(r => {
          const key = `${r.permission}|${r.pattern}|${r.action}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { action: "deny", patterns, alwaysPatterns, matchingRules };
      }
    }

    // 5. Build rulesets: agent (base) → static (server) → runtime (user "always")
    const rulesets: Ruleset[] = [];
    if (agentRuleset) rulesets.push(agentRuleset);
    rulesets.push(staticRuleset);
    if (runtimeRuleset) rulesets.push(runtimeRuleset);
    const action = evaluate(toolName, patterns, ...rulesets);

    if (action === "deny") {
      const effectivePatterns = patterns.length > 0 ? patterns : ["*"];
      const rules = effectivePatterns.flatMap(
        p => findMatchingRules(toolName, p, ...rulesets),
      );
      // Deduplicate rules (same rule object can match multiple patterns)
      const seen = new Set<string>();
      const matchingRules = rules.filter(r => {
        const key = `${r.permission}|${r.pattern}|${r.action}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { action, patterns, alwaysPatterns, matchingRules };
    }

    return { action, patterns, alwaysPatterns };
  }

  /**
   * Create a pending approval request and emit the event to the client.
   * Does NOT block — returns the approvalId immediately.
   * The Promise is created eagerly so reply() can resolve it before waitForApproval() is called.
   */
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    patterns: string[],
    alwaysPatterns: string[],
    sessionId: string,
    workerId: string,
  ): string {
    const approvalId = `${sessionId}:${crypto.randomUUID().slice(0, 8)}`;

    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pending.set(approvalId, {
      resolve,
      reject,
      promise,
      args: JSON.stringify(args),
      sessionId,
      workerId,
      toolName,
      patterns,
      alwaysPatterns,
    });

    logger.debug("Tool requires approval", { toolName, patterns, sessionId, approvalId });

    this.serverBus.emit({ type: "session", sessionId }, {
      type: "tool_approval_required",
      approvalId,
      toolName,
      arguments: JSON.stringify(args),
      sessionId,
    });

    return approvalId;
  }

  /**
   * Returns the Promise created by requestApproval().
   * Resolves when user approves, rejects on deny.
   * Caller can race this with an AbortSignal for cancellation.
   */
  waitForApproval(approvalId: string): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) throw new Error(`No pending approval: ${approvalId}`);
    return entry.promise;
  }

  /**
   * List pending approval requests for a session.
   * Used to re-emit events on client reconnect.
   */
  getPendingForSession(sessionId: string): Array<{
    approvalId: string;
    toolName: string;
    args: string;
  }> {
    const result: Array<{ approvalId: string; toolName: string; args: string }> = [];
    for (const [approvalId, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        result.push({ approvalId, toolName: pending.toolName, args: pending.args });
      }
    }
    return result;
  }

  /**
   * Cancel a pending approval without resolve/reject.
   * Called after abort — the turn is over, nobody awaits the Promise.
   * The pending entry is silently removed so it won't appear on reconnect.
   */
  cancel(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    this.emitResolved(entry.sessionId, approvalId, "cancelled");
    logger.debug("Approval cancelled (abort)", { approvalId });
  }

  /**
   * Handle user's response to an approval request.
   *
   * - `"once"`: approve this single request
   * - `"always"`: approve and add patterns to runtime layer, then cascade-check
   * - `"reject"`: reject this request
   */
  reply(
    requestId: string,
    response: "once" | "always" | "reject",
    feedback?: string,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      logger.warn("No pending approval for requestId", { requestId });
      return false;
    }

    this.pending.delete(requestId);

    if (response === "reject") {
      pending.reject(new ToolRejectedError(pending.toolName, feedback));
      this.emitResolved(pending.sessionId, requestId, "denied");
      return true;
    }

    // Approve once or always
    pending.resolve();
    this.emitResolved(pending.sessionId, requestId, "approved");

    if (response === "always") {
      this.addRuntimeApproval(pending.sessionId, pending.toolName, pending.alwaysPatterns);
      // Persist to disk so the rule survives across sessions/restarts
      this.storage.addAllowPatterns(pending.workerId, pending.toolName, pending.alwaysPatterns);
      // Cascade: re-evaluate other pending requests for this session
      this.cascadeResolve(pending.sessionId);
    }

    return true;
  }

  /**
   * Set a subagent's permission ruleset for a session.
   * Agent "deny" rules act as a veto — they cannot be overridden by static
   * or runtime layers. Agent "allow" and "ask" can still be overridden.
   */
  setAgentPermission(sessionId: string, permission: Ruleset): void {
    this.agentPermissions.set(sessionId, permission);
  }

  /**
   * Clear runtime approvals, agent permissions, and reject all pending requests for a session.
   * Called on session end or eviction.
   */
  clearSession(sessionId: string): void {
    this.runtimeApprovals.delete(sessionId);
    this.agentPermissions.delete(sessionId);
    this.rejectSession(sessionId);
  }

  /**
   * Reject all pending approvals across all sessions and clear runtime approvals.
   * Called on server shutdown.
   */
  clearAll(): void {
    for (const [approvalId, pending] of this.pending) {
      pending.reject(new ToolRejectedError(pending.toolName, "Server shutting down"));
      this.emitResolved(pending.sessionId, approvalId, "cancelled");
    }
    this.pending.clear();
    this.runtimeApprovals.clear();
    this.agentPermissions.clear();
  }

  /** Get the count of pending approvals (for testing/monitoring). */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --- Private ---

  /** Add allow patterns to the runtime layer for a session. */
  private addRuntimeApproval(sessionId: string, toolName: string, patterns: string[]): void {
    if (patterns.length === 0) return;

    let ruleset = this.runtimeApprovals.get(sessionId);
    if (!ruleset) {
      ruleset = [];
      this.runtimeApprovals.set(sessionId, ruleset);
    }

    for (const p of patterns) {
      ruleset.push({ permission: toolName, pattern: p, action: "allow" });
    }

    logger.debug("Runtime approval added", { sessionId, toolName, patterns });
  }

  /**
   * After adding a runtime approval, re-evaluate all other pending requests
   * for the same session. Any that now evaluate to "allow" are auto-resolved.
   */
  private cascadeResolve(sessionId: string): void {
    const toResolve: string[] = [];

    for (const [reqId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;

      // Agent deny = veto: never cascade-resolve a tool the agent denies
      const agentRuleset = this.agentPermissions.get(sessionId);
      if (agentRuleset) {
        const agentAction = evaluate(pending.toolName, pending.patterns, agentRuleset);
        if (agentAction === "deny") continue;
      }

      const staticRuleset = this.storage.load(pending.workerId);
      const runtimeRuleset = this.runtimeApprovals.get(sessionId);
      const rulesets: Ruleset[] = [];
      if (agentRuleset) rulesets.push(agentRuleset);
      rulesets.push(staticRuleset);
      if (runtimeRuleset) rulesets.push(runtimeRuleset);

      const action = evaluate(pending.toolName, pending.patterns, ...rulesets);
      if (action === "allow") {
        toResolve.push(reqId);
      }
    }

    for (const reqId of toResolve) {
      const pending = this.pending.get(reqId);
      if (pending) {
        this.pending.delete(reqId);
        pending.resolve();
        this.emitResolved(pending.sessionId, reqId, "approved");
        logger.debug("Cascade-resolved pending approval", { requestId: reqId });
      }
    }
  }

  /** Emit an approval_resolved event so all subscribers can clean up. */
  private emitResolved(sessionId: string, approvalId: string, outcome: "approved" | "denied" | "cancelled"): void {
    this.serverBus.emit({ type: "session", sessionId }, {
      type: "tool_approval_resolved",
      approvalId,
      outcome,
      sessionId,
    });
  }

  /** Reject all pending approval requests for a session. */
  private rejectSession(sessionId: string, feedback?: string): void {
    const toReject: string[] = [];
    for (const [reqId, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        toReject.push(reqId);
      }
    }

    for (const reqId of toReject) {
      const pending = this.pending.get(reqId);
      if (pending) {
        this.pending.delete(reqId);
        pending.reject(new ToolRejectedError(pending.toolName, feedback));
        this.emitResolved(pending.sessionId, reqId, "denied");
      }
    }
  }
}
