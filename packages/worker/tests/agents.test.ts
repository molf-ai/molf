import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { loadAgents, resolveAgentsDir } from "../src/agents.js";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("resolveAgentsDir", () => {
  test("prefers .agents/agents over .claude/agents", () => {
    const dir = `${tmp.path}/resolve1`;
    mkdirSync(resolve(dir, ".agents/agents"), { recursive: true });
    mkdirSync(resolve(dir, ".claude/agents"), { recursive: true });
    const result = resolveAgentsDir(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(".agents/agents");
  });

  test("falls back to .claude/agents", () => {
    const dir = `${tmp.path}/resolve2`;
    mkdirSync(resolve(dir, ".claude/agents"), { recursive: true });
    const result = resolveAgentsDir(dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe(".claude/agents");
  });

  test("returns null when neither exists", () => {
    const dir = `${tmp.path}/resolve3`;
    mkdirSync(dir, { recursive: true });
    expect(resolveAgentsDir(dir)).toBeNull();
  });
});

describe("loadAgents", () => {
  test("discovers .agents/agents/*.md files", () => {
    const dir = `${tmp.path}/ag1`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code changes\n---\nYou are a code reviewer.",
    );
    const { agents, source } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("reviewer");
    expect(agents[0].description).toBe("Reviews code changes");
    expect(agents[0].content).toBe("You are a code reviewer.");
    expect(source).toBe(".agents/agents");
  });

  test("falls back to .claude/agents", () => {
    const dir = `${tmp.path}/ag2`;
    const agentsDir = resolve(dir, ".claude/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "explorer.md"),
      "---\nname: explorer\ndescription: Explores codebase\n---\nSearch and read.",
    );
    const { agents, source } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("explorer");
    expect(source).toBe(".claude/agents");
  });

  test("parses frontmatter correctly", () => {
    const dir = `${tmp.path}/ag3`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "custom.md"),
      [
        "---",
        "name: custom-agent",
        "description: A custom agent",
        "maxSteps: 25",
        "---",
        "Custom instructions here.",
      ].join("\n"),
    );
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("custom-agent");
    expect(agents[0].description).toBe("A custom agent");
    expect(agents[0].maxSteps).toBe(25);
    expect(agents[0].content).toBe("Custom instructions here.");
  });

  test("permission with nested patterns parsed correctly", () => {
    const dir = `${tmp.path}/ag4`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "restricted.md"),
      [
        "---",
        "name: restricted",
        "description: Restricted agent",
        "permission:",
        '  "*": deny',
        "  read_file:",
        '    "*": allow',
        '    "*.env": deny',
        "  grep: allow",
        "  glob: allow",
        "---",
        "Restricted agent body.",
      ].join("\n"),
    );
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    const perm = agents[0].permission;
    expect(perm).toBeDefined();
    expect(perm!["*"]).toBe("deny");
    expect(perm!["grep"]).toBe("allow");
    expect(perm!["glob"]).toBe("allow");
    // Nested pattern
    const readFile = perm!["read_file"];
    expect(typeof readFile).toBe("object");
    expect((readFile as Record<string, string>)["*"]).toBe("allow");
    expect((readFile as Record<string, string>)["*.env"]).toBe("deny");
  });

  test("name falls back to filename without extension", () => {
    const dir = `${tmp.path}/ag7`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "my-agent.md"),
      "---\ndescription: No name field\n---\nBody content",
    );
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("my-agent");
  });

  test("empty/missing directory returns empty array", () => {
    const dir = `${tmp.path}/ag8`;
    mkdirSync(dir, { recursive: true });
    const { agents, source } = loadAgents(dir);
    expect(agents).toHaveLength(0);
    expect(source).toBeNull();
  });

  test("skips agents missing description", () => {
    const dir = `${tmp.path}/ag9`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    // Agent without description — should be skipped
    writeFileSync(
      resolve(agentsDir, "nodesc.md"),
      "---\nname: nodesc\n---\nBody only",
    );
    // Agent with description — should be loaded
    writeFileSync(
      resolve(agentsDir, "hasdesc.md"),
      "---\nname: hasdesc\ndescription: Has desc\n---\nBody",
    );
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("hasdesc");
  });

  test("multiple agents loaded", () => {
    const dir = `${tmp.path}/ag10`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const name of ["alpha", "beta", "gamma"]) {
      writeFileSync(
        resolve(agentsDir, `${name}.md`),
        `---\nname: ${name}\ndescription: Agent ${name}\n---\n${name} instructions`,
      );
    }
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(3);
    expect(agents.map(a => a.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("no frontmatter — treated as body only, skipped (no description)", () => {
    const dir = `${tmp.path}/ag11`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(resolve(agentsDir, "plain.md"), "Just plain content, no frontmatter");
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(0);
  });

  test("frontmatter-only file (no trailing body) is parsed", () => {
    const dir = `${tmp.path}/ag14`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "minimal.md"),
      "---\nname: minimal\ndescription: No body\n---",
    );
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("minimal");
    expect(agents[0].content).toBe("");
  });

  test("permission without nested patterns", () => {
    const dir = `${tmp.path}/ag13`;
    const agentsDir = resolve(dir, ".agents/agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      resolve(agentsDir, "simple.md"),
      [
        "---",
        "name: simple",
        "description: Simple permission",
        "permission:",
        '  "*": allow',
        "  shell_exec: deny",
        "---",
        "Body",
      ].join("\n"),
    );
    const { agents } = loadAgents(dir);
    expect(agents).toHaveLength(1);
    const perm = agents[0].permission;
    expect(perm!["*"]).toBe("allow");
    expect(perm!["shell_exec"]).toBe("deny");
  });
});
