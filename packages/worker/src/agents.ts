import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { getLogger } from "@logtape/logtape";
import type { CompactPermission, WorkerAgentInfo } from "@molf-ai/protocol";

const logger = getLogger(["molf", "worker"]);

interface AgentFrontmatter {
  name?: string;
  description?: string;
  permission?: CompactPermission;
  maxSteps?: number;
}

/** Agent directory candidates in priority order. */
export const AGENT_DIRS = [".agents/agents", ".claude/agents"] as const;

/**
 * Resolve the first existing agents directory under workdir.
 * Returns the absolute path and which source matched, or null if neither exists.
 */
export function resolveAgentsDir(workdir: string): { path: string; source: string } | null {
  for (const dir of AGENT_DIRS) {
    const full = resolve(workdir, dir);
    if (existsSync(full)) return { path: full, source: dir };
  }
  return null;
}

/**
 * Load agents from `.agents/agents/` (preferred) or `.claude/agents/` (fallback).
 *
 * Each agent is a `*.md` file with YAML frontmatter.
 */
export function loadAgents(workdir: string): {
  agents: WorkerAgentInfo[];
  source: string | null;
} {
  const resolved = resolveAgentsDir(workdir);
  if (!resolved) return { agents: [], source: null };

  const agents: WorkerAgentInfo[] = [];

  const entries = readdirSync(resolved.path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = resolve(resolved.path, entry.name);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);

      if (!frontmatter.description) {
        logger.warn("Agent missing description, skipping", { file: entry.name });
        continue;
      }

      agents.push({
        name: frontmatter.name || basename(entry.name, ".md"),
        description: frontmatter.description,
        content: body.trim(),
        permission: frontmatter.permission,
        maxSteps: frontmatter.maxSteps,
      });
    } catch (err) {
      logger.warn("Failed to load agent", { file: entry.name, error: err });
    }
  }

  return { agents, source: resolved.source };
}

function parseFrontmatter(raw: string): {
  frontmatter: AgentFrontmatter;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const [, yamlBlock, body = ""] = match;
  try {
    const parsed = parseYaml(yamlBlock) as AgentFrontmatter | null;
    return { frontmatter: parsed ?? {}, body };
  } catch (err) {
    logger.warn("Failed to parse agent frontmatter", { error: err });
    return { frontmatter: {}, body };
  }
}
