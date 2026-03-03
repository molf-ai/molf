import type { WorkerAgentInfo } from "@molf-ai/protocol";
import type { Rule, Ruleset } from "./approval/types.js";
import { fromConfig } from "./approval/evaluate.js";

export interface ResolvedAgentType {
  name: string;
  description: string;
  systemPromptSuffix: string;
  permission: Ruleset;
  maxSteps: number;
  source: "default" | "worker";
}

const TASK_DENY_RULE: Rule = { permission: "task", pattern: "*", action: "deny" };

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
 *
 * 1. Start with defaults
 * 2. Worker agents with same name replace defaults
 * 3. Worker agents with new names are added
 * 4. { permission: "task", pattern: "*", action: "deny" } is always appended
 *    as the LAST rule in every resolved agent's ruleset (last-match-wins ensures no nesting)
 */
export function resolveAgentTypes(
  workerAgents: WorkerAgentInfo[],
): ResolvedAgentType[] {
  const agentMap = new Map<string, ResolvedAgentType>();

  // 1. Start with defaults
  for (const def of DEFAULT_AGENTS) {
    agentMap.set(def.name, def);
  }

  // 2. Worker agents override/add
  for (const wa of workerAgents) {
    const permission = wa.permission
      ? fromConfig(wa.permission)
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

  // 3. Append task deny as LAST rule for every agent
  return Array.from(agentMap.values()).map(agent => ({
    ...agent,
    permission: [...agent.permission, TASK_DENY_RULE],
  }));
}
