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

/**
 * Load AGENTS.md from workdir root (if it exists).
 */
export function loadAgentsDoc(workdir: string): string | null {
  const agentsPath = resolve(workdir, "AGENTS.md");
  if (!existsSync(agentsPath)) return null;

  try {
    return readFileSync(agentsPath, "utf-8");
  } catch {
    return null;
  }
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
