import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { homedir } from "os";
import { RulesetStorage } from "../../src/approval/ruleset-storage.js";
import { DEFAULT_RULESET } from "../../src/approval/defaults.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

let tmp: TmpDir;

beforeAll(() => {
  tmp = createTmpDir("molf-ruleset-test-");
});

afterAll(() => {
  tmp.cleanup();
});

describe("RulesetStorage", () => {
  test("returns defaults when no file exists", () => {
    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load("nonexistent-worker-id");
    expect(ruleset).toEqual(DEFAULT_RULESET);
  });

  test("loads valid JSONC flat array file", () => {
    const workerId = "worker-jsonc";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, `[
      // This is a comment
      { "permission": "shell_exec", "pattern": "*", "action": "allow" },
      /* multi-line comment */
      { "permission": "shell_exec", "pattern": "rm -rf *", "action": "deny" }
    ]`);

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset).toEqual([
      { permission: "shell_exec", pattern: "*", action: "allow" },
      { permission: "shell_exec", pattern: "rm -rf *", action: "deny" },
    ]);
  });

  test("falls back to defaults on invalid JSON", () => {
    const workerId = "worker-invalid";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, "not json at all {{{");

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset).toEqual(DEFAULT_RULESET);
  });

  test("parses non-array object as compact config format", () => {
    const workerId = "worker-compact";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, '{"shell_exec": "ask", "glob": "allow"}');

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset).toEqual([
      { permission: "shell_exec", pattern: "*", action: "ask" },
      { permission: "glob", pattern: "*", action: "allow" },
    ]);
  });

  test("handles comments inside strings correctly", () => {
    const workerId = "worker-string-comments";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, `[
      { "permission": "shell_exec", "pattern": "echo // this is not a comment", "action": "allow" }
    ]`);

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset).toEqual([
      { permission: "shell_exec", pattern: "echo // this is not a comment", action: "allow" },
    ]);
  });

  test("expands ~/ patterns on load", () => {
    const workerId = "worker-tilde";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, JSON.stringify([
      { permission: "read_file", pattern: "~/secrets/*", action: "deny" },
      { permission: "read_file", pattern: "*", action: "allow" },
    ]));

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    const home = homedir();
    expect(ruleset[0].pattern).toBe(`${home}/secrets/*`);
    expect(ruleset[1].pattern).toBe("*"); // wildcard unchanged
  });

  test("expands $HOME/ patterns on load", () => {
    const workerId = "worker-home-var";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, JSON.stringify([
      { permission: "write_file", pattern: "$HOME/.ssh/*", action: "deny" },
      { permission: "write_file", pattern: "src/*", action: "allow" },
    ]));

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    const home = homedir();
    expect(ruleset[0].pattern).toBe(`${home}/.ssh/*`);
    expect(ruleset[1].pattern).toBe("src/*"); // relative path unchanged
  });

  test("addAllowPatterns writes compact config format on disk", () => {
    const workerId = "worker-compact-save";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, '{ "glob": "allow", "*": "ask" }');

    const storage = new RulesetStorage(tmp.path);
    storage.addAllowPatterns(workerId, "shell_exec", ["git status"]);

    const raw = fs.readFileSync(`${dir}/permissions.jsonc`, "utf-8");
    // Should NOT be flat array format (starts with "[")
    const stripped = raw.replace(/\/\/.*/g, "").trim();
    expect(stripped.startsWith("{")).toBe(true);

    // Parse and verify the new rule is present in compact form
    const parsed = JSON.parse(stripped);
    expect(parsed["glob"]).toBe("allow");
    expect(parsed["*"]).toBe("ask");
    expect(parsed["shell_exec"]).toEqual({ "git status": "allow" });
  });

  test("on-disk file retains ~/syntax after load", () => {
    const workerId = "worker-persist-tilde";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    const original = JSON.stringify([
      { permission: "read_file", pattern: "~/secrets", action: "deny" },
    ]);
    fs.writeFileSync(`${dir}/permissions.jsonc`, original);

    const storage = new RulesetStorage(tmp.path);
    storage.load(workerId);

    // File on disk should NOT be rewritten — still has ~/
    const raw = fs.readFileSync(`${dir}/permissions.jsonc`, "utf-8");
    expect(raw).toContain("~/secrets");
  });
});
