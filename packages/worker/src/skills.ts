import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import { getLogger } from "@logtape/logtape";
import type { WorkerSkillInfo } from "@molf-ai/protocol";

const logger = getLogger(["molf", "worker"]);

interface SkillFrontmatter {
  name: string;
  description: string;
}

/** Skill directory candidates in priority order. */
export const SKILL_DIRS = [".agents/skills", ".claude/skills"] as const;

/**
 * Resolve the first existing skills directory under workdir.
 * Returns the absolute path and which source matched, or null if neither exists.
 */
export function resolveSkillsDir(workdir: string): { path: string; source: string } | null {
  for (const dir of SKILL_DIRS) {
    const full = resolve(workdir, dir);
    if (existsSync(full)) return { path: full, source: dir };
  }
  return null;
}

/** Load skills from .agents/skills/ (preferred) or .claude/skills/ (fallback). */
export function loadSkills(workdir: string): { skills: WorkerSkillInfo[]; source: string | null } {
  const resolved = resolveSkillsDir(workdir);
  if (!resolved) return { skills: [], source: null };

  const skills: WorkerSkillInfo[] = [];

  const entries = readdirSync(resolved.path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = resolve(resolved.path, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    try {
      const raw = readFileSync(skillFile, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);

      skills.push({
        name: frontmatter.name || entry.name,
        description: frontmatter.description ?? "",
        content: body.trim(),
      });
    } catch (err) {
      logger.warn("Failed to load skill", { skillFile, error: err });
    }
  }

  return { skills, source: resolved.source };
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Load instruction doc from workdir root.
 * Tries AGENTS.md first, then falls back to CLAUDE.md.
 */
export function loadAgentsDoc(workdir: string): { content: string; source: string } | null {
  for (const filename of INSTRUCTION_FILES) {
    const filepath = resolve(workdir, filename);
    if (!existsSync(filepath)) continue;
    try {
      return { content: readFileSync(filepath, "utf-8"), source: filename };
    } catch (err) {
      logger.warn("Failed to load agents doc", { filename, error: err });
      continue;
    }
  }
  return null;
}

/**
 * Discover nested instruction files between a file's directory and workdir.
 * Walks from dirname(filePath) up to workdir (exclusive), checking
 * AGENTS.md first, then CLAUDE.md per directory.
 */
export function discoverNestedInstructions(
  filePath: string,
  workdir: string,
): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const resolvedWorkdir = resolve(workdir);
  let dir = dirname(resolve(filePath));

  // Walk up to workdir (exclusive)
  while (dir.startsWith(resolvedWorkdir + "/") && dir !== resolvedWorkdir) {
    for (const filename of INSTRUCTION_FILES) {
      const filepath = resolve(dir, filename);
      if (!existsSync(filepath)) continue;
      try {
        const content = readFileSync(filepath, "utf-8");
        results.push({ path: relative(resolvedWorkdir, filepath), content });
        break; // Only one per directory: AGENTS.md wins over CLAUDE.md
      } catch {
        continue;
      }
    }
    dir = dirname(dir);
  }

  return results;
}

function parseFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: { name: "", description: "" },
      body: raw,
    };
  }

  const [, yamlBlock, body] = match;
  const frontmatter: Record<string, string> = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    frontmatter[key] = value;
  }

  return {
    frontmatter: {
      name: frontmatter.name ?? "",
      description: frontmatter.description ?? "",
    },
    body,
  };
}
