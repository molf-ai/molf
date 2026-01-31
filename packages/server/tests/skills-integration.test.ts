import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/protocol";
import { startServer } from "../src/server.js";
import type { ServerInstance } from "../src/server.js";
import { ConnectionRegistry } from "../src/connection-registry.js";
import type { WorkerRegistration } from "../src/connection-registry.js";
import { buildAgentSystemPrompt, buildSkillTool } from "../src/agent-runner.js";
import { loadSkills, loadAgentsDoc } from "../../worker/src/skills.js";
import { getDefaultSystemPrompt } from "@molf-ai/agent-core";

// =============================================================================
// buildAgentSystemPrompt — the actual function AgentRunner.prompt() calls
// =============================================================================

describe("buildAgentSystemPrompt", () => {
  function makeWorker(skills: WorkerRegistration["skills"]): WorkerRegistration {
    return {
      role: "worker",
      id: "test-worker",
      name: "test",
      connectedAt: Date.now(),
      tools: [],
      skills,
    };
  }

  test("includes default prompt when worker has no skills", () => {
    const prompt = buildAgentSystemPrompt(makeWorker([]));

    expect(prompt).toBe(getDefaultSystemPrompt());
  });

  test("includes skill hint when worker has skills", () => {
    const worker = makeWorker([
      { name: "deploy", description: "Deploy app", content: "Run kubectl apply" },
    ]);
    const prompt = buildAgentSystemPrompt(worker);

    expect(prompt).toContain(getDefaultSystemPrompt());
    expect(prompt).toContain("'skill' tool available");
  });

  test("does NOT inject full skill content into prompt", () => {
    const worker = makeWorker([
      { name: "deploy", description: "Deploy app", content: "Run kubectl apply" },
      { name: "logs", description: "View logs", content: "Query Loki for logs" },
    ]);
    const prompt = buildAgentSystemPrompt(worker);

    expect(prompt).not.toContain("## Skill: deploy");
    expect(prompt).not.toContain("Run kubectl apply");
    expect(prompt).not.toContain("## Skill: logs");
    expect(prompt).not.toContain("Query Loki for logs");
  });

  test("default prompt comes before skill hint", () => {
    const worker = makeWorker([
      { name: "deploy", description: "Deploy", content: "Run deploy" },
    ]);
    const prompt = buildAgentSystemPrompt(worker);

    const defaultIdx = prompt.indexOf("Molf");
    const hintIdx = prompt.indexOf("'skill' tool available");

    expect(defaultIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThan(defaultIdx);
  });

  test("session config does not affect prompt", () => {
    const worker = makeWorker([
      { name: "deploy", description: "Deploy", content: "Run kubectl apply" },
    ]);

    const withConfig = buildAgentSystemPrompt(worker, {
      behavior: { systemPrompt: "Custom prompt that should not appear" },
    });
    const withoutConfig = buildAgentSystemPrompt(worker);

    expect(withConfig).toContain("'skill' tool available");
    expect(withConfig).toBe(withoutConfig);
  });
});

// =============================================================================
// buildSkillTool — on-demand skill loading tool
// =============================================================================

describe("buildSkillTool", () => {
  function makeWorker(skills: WorkerRegistration["skills"]): WorkerRegistration {
    return {
      role: "worker",
      id: "test-worker",
      name: "test",
      connectedAt: Date.now(),
      tools: [],
      skills,
    };
  }

  test("returns null when worker has no skills", () => {
    expect(buildSkillTool(makeWorker([]))).toBeNull();
  });

  test("returns tool with name 'skill'", () => {
    const tool = buildSkillTool(makeWorker([
      { name: "deploy", description: "Deploy app", content: "Run kubectl apply" },
    ]));

    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("skill");
  });

  test("description contains XML listing of all skills", () => {
    const skillTool = buildSkillTool(makeWorker([
      { name: "logs", description: "Query logs from Loki", content: "..." },
      { name: "postgres", description: "Query PostgreSQL", content: "..." },
    ]));

    const desc = skillTool!.toolDef.description!;
    expect(desc).toContain("<skills>");
    expect(desc).toContain('name="logs"');
    expect(desc).toContain("Query logs from Loki");
    expect(desc).toContain('name="postgres"');
    expect(desc).toContain("Query PostgreSQL");
    expect(desc).toContain("</skills>");
  });

  test("input schema has enum constraint listing valid skill names", () => {
    const skillTool = buildSkillTool(makeWorker([
      { name: "logs", description: "Logs", content: "..." },
      { name: "deploy", description: "Deploy", content: "..." },
    ]));

    // The inputSchema is wrapped by jsonSchema() — access the raw JSON Schema via .jsonSchema
    const schema = (skillTool!.toolDef.inputSchema as any).jsonSchema;
    expect(schema.properties.name.enum).toEqual(["logs", "deploy"]);
    expect(schema.required).toEqual(["name"]);
  });

  test("execute returns object with content for valid name", async () => {
    const skillTool = buildSkillTool(makeWorker([
      { name: "deploy", description: "Deploy app", content: "Run kubectl apply -f manifest.yaml" },
    ]));

    const execute = (skillTool!.toolDef as any).execute;
    const result = await execute({ name: "deploy" });
    expect(result).toEqual({ content: "Run kubectl apply -f manifest.yaml" });
  });

  test("execute returns error object for unknown skill name", async () => {
    const skillTool = buildSkillTool(makeWorker([
      { name: "deploy", description: "Deploy app", content: "Run kubectl apply" },
    ]));

    const execute = (skillTool!.toolDef as any).execute;
    const result = await execute({ name: "nonexistent" });
    expect(result.error).toContain('Unknown skill "nonexistent"');
    expect(result.error).toContain("deploy");
  });

  test("preserves rich markdown content in execute result", async () => {
    const content = `# Logs Retrieval

\`\`\`python
from debug_kit import loki
loki.query_logs("my-service", "1h")
\`\`\`

- Supports **regex** patterns
- Rate limit: 100 req/min`;

    const skillTool = buildSkillTool(makeWorker([
      { name: "logs", description: "Logs", content },
    ]));

    const execute = (skillTool!.toolDef as any).execute;
    const result = await execute({ name: "logs" });
    expect(result.content).toContain("debug_kit");
    expect(result.content).toContain("loki.query_logs");
    expect(result.content).toContain("Supports **regex** patterns");
    expect(result.content).toContain("Rate limit: 100 req/min");
  });
});

// =============================================================================
// Full pipeline: disk → loadSkills → ConnectionRegistry → buildAgentSystemPrompt
// =============================================================================

describe("Full pipeline: disk → loadSkills → registry → buildAgentSystemPrompt", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "molf-skills-pipe-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test("skills from disk are NOT in system prompt but ARE accessible via skill tool", async () => {
    // 1. Create skills on disk
    const logsDir = join(workdir, "skills", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "SKILL.md"),
      `---
name: logs
description: Query logs from Loki
---

# Logs Skill

Use \`debug_kit.loki.query_logs(service, timerange)\` to fetch logs.
`,
    );

    const pgDir = join(workdir, "skills", "postgres");
    mkdirSync(pgDir, { recursive: true });
    writeFileSync(
      join(pgDir, "SKILL.md"),
      `---
name: postgres
description: Query PostgreSQL
---

# Postgres Skill

Use the \`psql\` CLI or write SQL.
`,
    );

    // 2. Load from disk (worker does this)
    const skills = loadSkills(workdir);
    expect(skills).toHaveLength(2);

    // 3. Store in registry (server does this on worker.register)
    const registry = new ConnectionRegistry();
    registry.registerWorker({
      id: "pipe-worker",
      name: "pipe",
      connectedAt: Date.now(),
      tools: [],
      skills,
    });

    const worker = registry.getWorker("pipe-worker")!;

    // 4. System prompt has hint but NOT full content
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain(getDefaultSystemPrompt());
    expect(prompt).toContain("'skill' tool available");
    expect(prompt).not.toContain("## Skill: logs");
    expect(prompt).not.toContain("debug_kit.loki.query_logs");
    expect(prompt).not.toContain("## Skill: postgres");

    // 5. Skill tool provides content on demand
    const skillTool = buildSkillTool(worker)!;
    expect(skillTool).not.toBeNull();
    const execute = (skillTool.toolDef as any).execute;
    const logsResult = await execute({ name: "logs" });
    expect(logsResult.content).toContain("debug_kit.loki.query_logs(service, timerange)");
    const pgResult = await execute({ name: "postgres" });
    expect(pgResult.content).toContain("psql");
  });

  test("no skills directory → empty skills → default-only prompt", () => {
    const skills = loadSkills(workdir);
    expect(skills).toHaveLength(0);

    const registry = new ConnectionRegistry();
    registry.registerWorker({
      id: "no-skills",
      name: "bare",
      connectedAt: Date.now(),
      tools: [],
      skills,
    });

    const worker = registry.getWorker("no-skills")!;
    const prompt = buildAgentSystemPrompt(worker);

    expect(prompt).toBe(getDefaultSystemPrompt());
  });

  test("skill without frontmatter uses directory name and is loadable via tool", async () => {
    const skillDir = join(workdir, "skills", "custom-tool");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Plain content, no frontmatter.");

    const skills = loadSkills(workdir);
    expect(skills[0].name).toBe("custom-tool");

    const registry = new ConnectionRegistry();
    registry.registerWorker({
      id: "w",
      name: "w",
      connectedAt: Date.now(),
      tools: [],
      skills,
    });

    const worker = registry.getWorker("w")!;
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("'skill' tool available");
    expect(prompt).not.toContain("Plain content, no frontmatter.");

    const skillTool = buildSkillTool(worker)!;
    const execute = (skillTool.toolDef as any).execute;
    const result = await execute({ name: "custom-tool" });
    expect(result.content).toContain("Plain content, no frontmatter.");
  });

  test("extra frontmatter fields (allowed-tools, version) do not break flow", async () => {
    const skillDir = join(workdir, "skills", "extended");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: extended
description: Has extra fields
allowed-tools: Bash, Read, Write
version: 2.0
author: test
---

Extended skill body.
`,
    );

    const skills = loadSkills(workdir);
    const registry = new ConnectionRegistry();
    registry.registerWorker({
      id: "w",
      name: "w",
      connectedAt: Date.now(),
      tools: [],
      skills,
    });

    const worker = registry.getWorker("w")!;
    const prompt = buildAgentSystemPrompt(worker);
    expect(prompt).toContain("'skill' tool available");
    expect(prompt).not.toContain("Extended skill body.");

    const skillTool = buildSkillTool(worker)!;
    const execute = (skillTool.toolDef as any).execute;
    const result = await execute({ name: "extended" });
    expect(result.content).toContain("Extended skill body.");
  });

  test("mixed valid/invalid skill dirs: only valid skills are loadable via tool", async () => {
    // Valid
    const validDir = join(workdir, "skills", "valid");
    mkdirSync(validDir, { recursive: true });
    writeFileSync(
      join(validDir, "SKILL.md"),
      `---
name: valid
description: Works
---

Valid body.
`,
    );

    // Dir without SKILL.md
    mkdirSync(join(workdir, "skills", "empty-dir"), { recursive: true });

    // Plain file (not a directory)
    writeFileSync(join(workdir, "skills", "README.md"), "Not a skill");

    // Another valid
    const anotherDir = join(workdir, "skills", "another");
    mkdirSync(anotherDir, { recursive: true });
    writeFileSync(join(anotherDir, "SKILL.md"), "Another body");

    const skills = loadSkills(workdir);
    expect(skills).toHaveLength(2);

    const registry = new ConnectionRegistry();
    registry.registerWorker({
      id: "w",
      name: "w",
      connectedAt: Date.now(),
      tools: [],
      skills,
    });

    const worker = registry.getWorker("w")!;
    const skillTool = buildSkillTool(worker)!;
    const execute = (skillTool.toolDef as any).execute;

    const validResult = await execute({ name: "valid" });
    expect(validResult.content).toContain("Valid body.");
    const anotherResult = await execute({ name: "another" });
    expect(anotherResult.content).toContain("Another body");

    // Invalid entries should not be loadable
    const schema = (skillTool.toolDef.inputSchema as any).jsonSchema;
    expect(schema.properties.name.enum).not.toContain("empty-dir");
    expect(schema.properties.name.enum).not.toContain("README");
  });
});

// =============================================================================
// tRPC round-trip: skills survive wire serialization
// =============================================================================

describe("Skills tRPC round-trip", () => {
  let testDir: string;
  let server: ServerInstance;
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
  let wsClient: ReturnType<typeof createWSClient>;

  const TEST_PORT = 17610;

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "molf-skills-trpc-"));
    process.env.MOLF_TOKEN = "test-skills-token";

    server = startServer({
      host: "127.0.0.1",
      port: TEST_PORT,
      dataDir: testDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const url = new URL(`ws://127.0.0.1:${TEST_PORT}`);
    url.searchParams.set("token", server.token);
    url.searchParams.set("name", "skills-test-client");

    wsClient = createWSClient({ url: url.toString() });
    trpc = createTRPCClient<AppRouter>({
      links: [wsLink({ client: wsClient })],
    });
  });

  afterAll(() => {
    wsClient?.close();
    server?.close();
    delete process.env.MOLF_TOKEN;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("skills survive worker.register → agent.list round-trip", async () => {
    const workerId = "550e8400-e29b-41d4-a716-446655440010";

    await trpc.worker.register.mutate({
      workerId,
      name: "skills-worker",
      tools: [],
      skills: [
        { name: "deploy", description: "Deploy app", content: "Run deploy" },
        { name: "logs", description: "View logs", content: "Query Loki" },
      ],
    });

    const result = await trpc.agent.list.query();
    const worker = result.workers.find((w) => w.workerId === workerId);

    expect(worker).toBeDefined();
    expect(worker!.skills).toHaveLength(2);
    expect(worker!.skills[0]).toEqual({
      name: "deploy",
      description: "Deploy app",
      content: "Run deploy",
    });
    expect(worker!.skills[1]).toEqual({
      name: "logs",
      description: "View logs",
      content: "Query Loki",
    });
  });

  test("omitting skills field defaults to empty array", async () => {
    const workerId = "550e8400-e29b-41d4-a716-446655440011";

    await trpc.worker.register.mutate({
      workerId,
      name: "no-skills-worker",
      tools: [],
    });

    const result = await trpc.agent.list.query();
    const worker = result.workers.find((w) => w.workerId === workerId);

    expect(worker).toBeDefined();
    expect(worker!.skills).toHaveLength(0);
  });

  test("rich markdown with code blocks and special chars survives wire", async () => {
    const workerId = "550e8400-e29b-41d4-a716-446655440012";

    const richContent = `# Postgres Skill

## Usage

\`\`\`sql
SELECT * FROM users WHERE active = true;
\`\`\`

### Notes
- Use read replicas for queries
- Connection pool limit: 20
- Special chars: <>&"'`;

    await trpc.worker.register.mutate({
      workerId,
      name: "rich-skills-worker",
      tools: [],
      skills: [
        { name: "postgres", description: "DB queries", content: richContent },
      ],
    });

    const result = await trpc.agent.list.query();
    const worker = result.workers.find((w) => w.workerId === workerId);

    expect(worker).toBeDefined();
    expect(worker!.skills[0].content).toBe(richContent);
  });
});
