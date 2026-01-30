import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSkills, loadAgentsDoc } from "../src/skills.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "molf-skills-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("loadSkills", () => {
  test("returns empty array when skills dir does not exist", () => {
    expect(loadSkills(testDir)).toEqual([]);
  });

  test("loads skill with frontmatter", () => {
    const skillDir = join(testDir, "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: deploy
description: Deploy the application
---

## Steps

1. Build
2. Deploy
`,
    );

    const skills = loadSkills(testDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("deploy");
    expect(skills[0].description).toBe("Deploy the application");
    expect(skills[0].content).toContain("## Steps");
    expect(skills[0].content).toContain("1. Build");
  });

  test("loads multiple skills", () => {
    for (const name of ["deploy", "test", "review"]) {
      const skillDir = join(testDir, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---
name: ${name}
description: ${name} skill
---

Content for ${name}
`,
      );
    }

    const skills = loadSkills(testDir);
    expect(skills).toHaveLength(3);
    expect(skills.map((s) => s.name).sort()).toEqual(["deploy", "review", "test"]);
  });

  test("uses directory name when frontmatter name is missing", () => {
    const skillDir = join(testDir, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Just content, no frontmatter");

    const skills = loadSkills(testDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].content).toBe("Just content, no frontmatter");
  });

  test("skips directories without SKILL.md", () => {
    const skillDir = join(testDir, "skills", "empty-skill");
    mkdirSync(skillDir, { recursive: true });
    // No SKILL.md file

    expect(loadSkills(testDir)).toEqual([]);
  });

  test("skips non-directory entries in skills folder", () => {
    const skillsDir = join(testDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "not-a-dir.txt"), "not a skill");

    expect(loadSkills(testDir)).toEqual([]);
  });
});

describe("loadAgentsDoc", () => {
  test("returns null when AGENTS.md does not exist", () => {
    expect(loadAgentsDoc(testDir)).toBeNull();
  });

  test("returns content of AGENTS.md", () => {
    writeFileSync(join(testDir, "AGENTS.md"), "# Agent Instructions\n\nBe helpful.");

    const content = loadAgentsDoc(testDir);

    expect(content).toBe("# Agent Instructions\n\nBe helpful.");
  });
});
