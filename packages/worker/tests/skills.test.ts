import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { loadSkills, loadAgentsDoc, discoverNestedInstructions, resolveSkillsDir } from "../src/skills.js";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("resolveSkillsDir", () => {
  test("prefers .agents/skills over .claude/skills", () => {
    const dir = `${tmp.path}/resolve1`;
    mkdirSync(resolve(dir, ".agents/skills"), { recursive: true });
    mkdirSync(resolve(dir, ".claude/skills"), { recursive: true });
    const result = resolveSkillsDir(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(".agents/skills");
  });

  test("falls back to .claude/skills", () => {
    const dir = `${tmp.path}/resolve2`;
    mkdirSync(resolve(dir, ".claude/skills"), { recursive: true });
    const result = resolveSkillsDir(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(".claude/skills");
  });

  test("returns null when neither exists", () => {
    const dir = `${tmp.path}/resolve3`;
    mkdirSync(dir, { recursive: true });
    expect(resolveSkillsDir(dir)).toBeNull();
  });
});

describe("loadSkills", () => {
  test("valid skill directory", () => {
    const dir = `${tmp.path}/sk1`;
    const skillDir = resolve(dir, ".agents/skills", "deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      resolve(skillDir, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy instructions here",
    );
    const { skills, source } = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("deploy");
    expect(skills[0].description).toBe("Deploy the app");
    expect(skills[0].content).toBe("Deploy instructions here");
    expect(source).toBe(".agents/skills");
  });

  test("YAML frontmatter parsed", () => {
    const dir = `${tmp.path}/sk2`;
    const skillDir = resolve(dir, ".agents/skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      resolve(skillDir, "SKILL.md"),
      "---\nname: custom-name\ndescription: Custom desc\n---\nBody content",
    );
    const { skills } = loadSkills(dir);
    expect(skills[0].name).toBe("custom-name");
    expect(skills[0].description).toBe("Custom desc");
  });

  test("without frontmatter falls back to directory name", () => {
    const dir = `${tmp.path}/sk3`;
    const skillDir = resolve(dir, ".agents/skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, "SKILL.md"), "Just plain content");
    const { skills } = loadSkills(dir);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].content).toBe("Just plain content");
  });

  test("multiple skills", () => {
    const dir = `${tmp.path}/sk4`;
    for (const name of ["a", "b", "c"]) {
      const skillDir = resolve(dir, ".agents/skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(resolve(skillDir, "SKILL.md"), `Skill ${name}`);
    }
    expect(loadSkills(dir).skills).toHaveLength(3);
  });

  test("no skills directory returns empty with null source", () => {
    const dir = `${tmp.path}/sk5`;
    mkdirSync(dir, { recursive: true });
    const { skills, source } = loadSkills(dir);
    expect(skills).toHaveLength(0);
    expect(source).toBeNull();
  });

  test("skips files (not directories)", () => {
    const dir = `${tmp.path}/sk6`;
    const skillsDir = resolve(dir, ".agents/skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(resolve(skillsDir, "not-a-dir.txt"), "hello");
    const skillDir = resolve(skillsDir, "real-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, "SKILL.md"), "content");
    expect(loadSkills(dir).skills).toHaveLength(1);
  });

  test("skips dirs without SKILL.md", () => {
    const dir = `${tmp.path}/sk7`;
    const skillDir = resolve(dir, ".agents/skills", "empty-skill");
    mkdirSync(skillDir, { recursive: true });
    expect(loadSkills(dir).skills).toHaveLength(0);
  });

  test("falls back to .claude/skills", () => {
    const dir = `${tmp.path}/sk8`;
    const skillDir = resolve(dir, ".claude/skills", "fallback-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, "SKILL.md"), "---\nname: fallback\ndescription: test\n---\nContent");
    const { skills, source } = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("fallback");
    expect(source).toBe(".claude/skills");
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

describe("discoverNestedInstructions", () => {
  test("finds AGENTS.md in subdirectory", () => {
    const workdir = `${tmp.path}/nested1`;
    const subDir = resolve(workdir, "packages", "server");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(workdir, "packages", "AGENTS.md"), "Package instructions");
    const filePath = resolve(subDir, "index.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("packages/AGENTS.md");
    expect(results[0].content).toBe("Package instructions");
  });

  test("AGENTS.md takes priority over CLAUDE.md in same directory", () => {
    const workdir = `${tmp.path}/nested2`;
    const subDir = resolve(workdir, "pkg");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(subDir, "AGENTS.md"), "Agents wins");
    writeFileSync(resolve(subDir, "CLAUDE.md"), "Claude loses");
    const filePath = resolve(subDir, "file.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Agents wins");
  });

  test("falls back to CLAUDE.md when no AGENTS.md", () => {
    const workdir = `${tmp.path}/nested3`;
    const subDir = resolve(workdir, "lib");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(subDir, "CLAUDE.md"), "Claude fallback");
    const filePath = resolve(subDir, "mod.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Claude fallback");
  });

  test("collects from multiple levels", () => {
    const workdir = `${tmp.path}/nested4`;
    const deep = resolve(workdir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(resolve(workdir, "a", "AGENTS.md"), "Level a");
    writeFileSync(resolve(workdir, "a", "b", "AGENTS.md"), "Level b");
    const filePath = resolve(deep, "file.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(2);
    // Walk starts from dirname(filePath) = a/b/c, then a/b, then a
    expect(results[0].path).toBe("a/b/AGENTS.md");
    expect(results[1].path).toBe("a/AGENTS.md");
  });

  test("excludes workdir root", () => {
    const workdir = `${tmp.path}/nested5`;
    const subDir = resolve(workdir, "src");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(workdir, "AGENTS.md"), "Root — should be excluded");
    const filePath = resolve(subDir, "file.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(0);
  });

  test("returns empty when no instruction files found", () => {
    const workdir = `${tmp.path}/nested6`;
    const subDir = resolve(workdir, "src");
    mkdirSync(subDir, { recursive: true });
    const filePath = resolve(subDir, "file.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(0);
  });

  test("returns empty when file is at workdir root", () => {
    const workdir = `${tmp.path}/nested7`;
    mkdirSync(workdir, { recursive: true });
    const filePath = resolve(workdir, "file.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(0);
  });

  test("paths are relative to workdir", () => {
    const workdir = `${tmp.path}/nested8`;
    const subDir = resolve(workdir, "packages", "core", "src");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(workdir, "packages", "core", "CLAUDE.md"), "Core instructions");
    const filePath = resolve(subDir, "index.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("packages/core/CLAUDE.md");
  });

  test("skips unreadable instruction files", () => {
    const workdir = `${tmp.path}/nested9`;
    const subDir = resolve(workdir, "pkg");
    mkdirSync(subDir, { recursive: true });
    // Create a directory named AGENTS.md to make readFileSync throw
    mkdirSync(resolve(subDir, "AGENTS.md"), { recursive: true });
    writeFileSync(resolve(subDir, "CLAUDE.md"), "Fallback");
    const filePath = resolve(subDir, "file.ts");

    const results = discoverNestedInstructions(filePath, workdir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Fallback");
  });
});
