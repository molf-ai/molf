import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { WorkerSkillInfo } from "@molf-ai/protocol";

interface SkillFrontmatter {
  name: string;
  description: string;
}

/** Load skills from workdir/skills/<name>/SKILL.md */
export function loadSkills(workdir: string): WorkerSkillInfo[] {
  const skillsDir = resolve(workdir, "skills");
  if (!existsSync(skillsDir)) return [];

  const skills: WorkerSkillInfo[] = [];

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillFile = resolve(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    try {
      const raw = readFileSync(skillFile, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);

      skills.push({
        name: frontmatter.name || entry.name,
        description: frontmatter.description ?? "",
        content: body.trim(),
      });
    } catch {
      // Skip unreadable skill files
    }
  }

  return skills;
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
    } catch {
      continue;
    }
  }
  return null;
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
