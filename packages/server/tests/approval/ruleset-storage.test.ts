import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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

  test("loads valid JSONC file", () => {
    const workerId = "worker-jsonc";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, `{
      // This is a comment
      "version": 1,
      "rules": {
        "shell_exec": {
          "default": "allow",
          /* multi-line comment */
          "deny": ["rm -rf *"]
        }
      }
    }`);

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset.version).toBe(1);
    expect(ruleset.rules.shell_exec.default).toBe("allow");
    expect(ruleset.rules.shell_exec.deny).toEqual(["rm -rf *"]);
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

  test("falls back to defaults on missing version/rules", () => {
    const workerId = "worker-missing-fields";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, '{"foo": "bar"}');

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset).toEqual(DEFAULT_RULESET);
  });

  test("handles comments inside strings correctly", () => {
    const workerId = "worker-string-comments";
    const dir = `${tmp.path}/workers/${workerId}`;
    const fs = require("fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/permissions.jsonc`, `{
      "version": 1,
      "rules": {
        "shell_exec": {
          "default": "ask",
          "allow": ["echo // this is not a comment"]
        }
      }
    }`);

    const storage = new RulesetStorage(tmp.path);
    const ruleset = storage.load(workerId);
    expect(ruleset.rules.shell_exec.allow).toEqual(["echo // this is not a comment"]);
  });
});
