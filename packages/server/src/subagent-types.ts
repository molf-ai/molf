import { homedir } from "os";
import type { WorkerAgentInfo } from "@molf-ai/protocol";

export interface ResolvedAgentType {
  name: string;
  description: string;
  systemPromptSuffix: string;
  permission: Rule[];
  maxSteps: number;
  source: "default" | "worker";
}

export interface Rule {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

export type Ruleset = Rule[];

const TASK_DENY_RULE: Rule = { permission: "task", pattern: "*", action: "deny" };

type CompactPermission = Record<string, string | Record<string, string>>;

function expand(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return homedir() + pattern.slice(1);
  if (pattern === "$HOME") return homedir();
  if (pattern.startsWith("$HOME/")) return homedir() + pattern.slice(5);
  return pattern;
}

/**
 * Convert a compact permission config to a Ruleset.
 * Handles both simple ("glob": "allow") and detailed ("read_file": { "*": "allow", "*.env": "deny" }) entries.
 */
function fromConfig(config: CompactPermission): Ruleset {
  const rules: Ruleset = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value as Rule["action"] });
    } else {
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({ permission, pattern: expand(pattern), action: action as Rule["action"] });
      }
    }
  }
  return rules;
}

export const DEFAULT_AGENTS: ResolvedAgentType[] = [
  {
    name: "explore",
    description: "Fast agent for exploring the codebase. Read-only.",
    systemPromptSuffix: [
      "You are a focused exploration subagent. Your job is to search and read code to answer questions.",
      "Use grep, glob, list_dir, and read_file to find information efficiently.",
      "Return concise, factual answers. Do not modify any files.",
    ].join("\n"),
    permission: fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      list_dir: "allow",
      read_file: "allow",
      web_fetch: "allow",
      web_search: "allow",
    }),
    maxSteps: 15,
    source: "default",
  },
  {
    name: "general",
    description: "General-purpose agent for multi-step tasks. Full tool access, no nesting.",
    systemPromptSuffix: [
      "You are a subagent executing a specific task.",
      "Complete the task described in the prompt. Be thorough but focused.",
      "Return a clear summary of what you accomplished.",
    ].join("\n"),
    permission: fromConfig({ "*": "allow" }),
    maxSteps: 20,
    source: "default",
  },
];

/**
 * Merge server defaults with worker-provided agents.
 */
export function resolveAgentTypes(
  workerAgents: WorkerAgentInfo[],
): ResolvedAgentType[] {
  const agentMap = new Map<string, ResolvedAgentType>();

  for (const def of DEFAULT_AGENTS) {
    agentMap.set(def.name, def);
  }

  for (const wa of workerAgents) {
    const permission = wa.permission
      ? fromConfig(wa.permission as CompactPermission)
      : fromConfig({ "*": "allow" });
    agentMap.set(wa.name, {
      name: wa.name,
      description: wa.description,
      systemPromptSuffix: wa.content,
      permission,
      maxSteps: wa.maxSteps ?? 10,
      source: "worker",
    });
  }

  return Array.from(agentMap.values()).map(agent => ({
    ...agent,
    permission: [...agent.permission, TASK_DENY_RULE],
  }));
}
