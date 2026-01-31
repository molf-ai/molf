import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { loadSkills, loadAgentsDoc } from "../src/skills.js";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("loadSkills", () => {
  test("valid skill directory", () => {
    const dir = `${tmp.path}/sk1`;
    const skillDir = resolve(dir, "skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      resolve(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy instructions here",
    );
    const skills = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("deploy");
    expect(skills[0].description).toBe("Deploy the app");
    expect(skills[0].content).toBe("Deploy instructions here");
  });

  test("YAML frontmatter parsed", () => {
    const dir = `${tmp.path}/sk2`;
    const skillDir = resolve(dir, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      resolve(skillDir, "SKILL.md"),
      "---\nname: custom-name\ndescription: Custom desc\n---\nBody content",
    );
    const skills = loadSkills(dir);
    expect(skills[0].name).toBe("custom-name");
    expect(skills[0].description).toBe("Custom desc");
  });

  test("without frontmatter falls back to directory name", () => {
    const dir = `${tmp.path}/sk3`;
    const skillDir = resolve(dir, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, "SKILL.md"), "Just plain content");
    const skills = loadSkills(dir);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].content).toBe("Just plain content");
  });

  test("multiple skills", () => {
    const dir = `${tmp.path}/sk4`;
    for (const name of ["a", "b", "c"]) {
      const skillDir = resolve(dir, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), `Skill ${name}`);
    }
    expect(loadSkills(dir)).toHaveLength(3);
  });

  test("no skills directory", () => {
    const dir = `${tmp.path}/sk5`;
    mkdirSync(dir, { recursive: true });
    expect(loadSkills(dir)).toHaveLength(0);
  });

  test("skips files (not directories)", () => {
    const dir = `${tmp.path}/sk6`;
    const skillsDir = resolve(dir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(resolve(skillsDir, "not-a-dir.txt"), "hello");
    const skillDir = resolve(skillsDir, "real-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, "SKILL.md"), "content");
    expect(loadSkills(dir)).toHaveLength(1);
  });

  test("skips dirs without SKILL.md", () => {
    const dir = `${tmp.path}/sk7`;
    const skillDir = resolve(dir, "skills", "empty-skill");
    mkdirSync(skillDir, { recursive: true });
    expect(loadSkills(dir)).toHaveLength(0);
  });
});

describe("loadAgentsDoc", () => {
  test("finds AGENTS.md", () => {
    const dir = `${tmp.path}/agents1`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "AGENTS.md"), "Agent instructions");
    const result = loadAgentsDoc(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("AGENTS.md");
    expect(result!.content).toBe("Agent instructions");
  });

  test("falls back to CLAUDE.md", () => {
    const dir = `${tmp.path}/agents2`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "CLAUDE.md"), "Claude instructions");
    const result = loadAgentsDoc(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("CLAUDE.md");
  });

  test("no instruction file", () => {
    const dir = `${tmp.path}/agents3`;
    mkdirSync(dir, { recursive: true });
    expect(loadAgentsDoc(dir)).toBeNull();
  });

  test("loadAgentsDoc skips unreadable file and falls back", () => {
    const dir = `${tmp.path}/agents4`;
    mkdirSync(dir, { recursive: true });
    // Create a directory named AGENTS.md so existsSync returns true but readFileSync throws EISDIR
    mkdirSync(resolve(dir, "AGENTS.md"), { recursive: true });
    writeFileSync(resolve(dir, "CLAUDE.md"), "Fallback content");
    const result = loadAgentsDoc(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("CLAUDE.md");
    expect(result!.content).toBe("Fallback content");
  });
});
