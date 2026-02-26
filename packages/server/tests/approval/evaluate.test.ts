import { describe, test, expect } from "bun:test";
import { evaluate, patternMatches, extractPatterns } from "../../src/approval/evaluate.js";
import { DEFAULT_RULESET } from "../../src/approval/defaults.js";
import type { GroupedRuleset } from "../../src/approval/types.js";

describe("patternMatches", () => {
  test("exact match", () => {
    expect(patternMatches("cat foo.txt", "cat foo.txt")).toBe(true);
  });

  test("wildcard match", () => {
    expect(patternMatches("cat foo.txt", "cat *")).toBe(true);
    expect(patternMatches("git push origin main", "git push *")).toBe(true);
  });

  test("no match", () => {
    expect(patternMatches("git push origin main", "git pull *")).toBe(false);
  });

  test("glob with multiple wildcards", () => {
    expect(patternMatches("git push --force origin main", "git push *--force*")).toBe(true);
  });

  test("file path patterns", () => {
    expect(patternMatches(".env", "*.env")).toBe(true);
    expect(patternMatches(".env.local", "*.env.*")).toBe(true);
    expect(patternMatches(".env.example", "*.env.example")).toBe(true);
    expect(patternMatches("config/credentials.json", "*credentials*")).toBe(true);
  });
});

describe("extractPatterns", () => {
  test("read_file extracts path", () => {
    expect(extractPatterns("read_file", { path: "/home/user/file.txt" })).toEqual(["/home/user/file.txt"]);
  });

  test("write_file extracts path", () => {
    expect(extractPatterns("write_file", { path: "output.txt" })).toEqual(["output.txt"]);
  });

  test("edit_file extracts file_path", () => {
    expect(extractPatterns("edit_file", { file_path: "src/index.ts" })).toEqual(["src/index.ts"]);
  });

  test("glob extracts pattern", () => {
    expect(extractPatterns("glob", { pattern: "**/*.ts" })).toEqual(["**/*.ts"]);
  });

  test("grep extracts path", () => {
    expect(extractPatterns("grep", { path: "src/" })).toEqual(["src/"]);
  });

  test("skill extracts name", () => {
    expect(extractPatterns("skill", { name: "deploy" })).toEqual(["deploy"]);
  });

  test("skill with no name returns empty", () => {
    expect(extractPatterns("skill", {})).toEqual([]);
  });

  test("mcp tool returns full name", () => {
    expect(extractPatterns("mcp:filesystem:read", {})).toEqual(["mcp:filesystem:read"]);
  });

  test("unknown tool returns empty", () => {
    expect(extractPatterns("unknown_tool", { foo: "bar" })).toEqual([]);
  });
});

describe("evaluate", () => {
  const staticRuleset: GroupedRuleset = {
    version: 1,
    rules: {
      read_file: {
        default: "allow",
        deny: ["*.env", "*secret*"],
        allow: ["*.env.example"],
      },
      shell_exec: {
        default: "ask",
        allow: ["cat *", "ls *"],
        deny: ["rm -rf *"],
      },
      "*": {
        default: "ask",
      },
    },
  };

  test("allow by default", () => {
    expect(evaluate("read_file", ["src/index.ts"], staticRuleset)).toBe("allow");
  });

  test("deny matches deny pattern", () => {
    expect(evaluate("read_file", [".env"], staticRuleset)).toBe("deny");
    expect(evaluate("read_file", ["config/secret.json"], staticRuleset)).toBe("deny");
  });

  test("allow overrides default ask", () => {
    expect(evaluate("shell_exec", ["cat file.txt"], staticRuleset)).toBe("allow");
    expect(evaluate("shell_exec", ["ls -la"], staticRuleset)).toBe("allow");
  });

  test("deny wins over allow", () => {
    // .env matches deny but not allow (unless .env.example)
    expect(evaluate("read_file", [".env"], staticRuleset)).toBe("deny");
  });

  test("allow exceptions work when deny pattern doesn't match", () => {
    // .env.example doesn't match deny *.env (which requires ending with .env)
    // but it does match allow *.env.example → allowed
    expect(evaluate("read_file", [".env.example"], staticRuleset)).toBe("allow");
  });

  test("fall back to default when no pattern matches", () => {
    expect(evaluate("shell_exec", ["python script.py"], staticRuleset)).toBe("ask");
  });

  test("wildcard tool catches unknown tools", () => {
    expect(evaluate("custom_tool", ["anything"], staticRuleset)).toBe("ask");
  });

  test("no patterns uses default", () => {
    expect(evaluate("read_file", [], staticRuleset)).toBe("allow");
    expect(evaluate("shell_exec", [], staticRuleset)).toBe("ask");
  });

  test("multi-pattern: any deny → deny", () => {
    expect(evaluate("shell_exec", ["cat file.txt", "rm -rf /"], staticRuleset)).toBe("deny");
  });

  test("multi-pattern: any ask → ask", () => {
    expect(evaluate("shell_exec", ["cat file.txt", "python script.py"], staticRuleset)).toBe("ask");
  });

  test("multi-pattern: all allow → allow", () => {
    expect(evaluate("shell_exec", ["cat file.txt", "ls -la"], staticRuleset)).toBe("allow");
  });

  describe("cross-layer evaluation", () => {
    const runtimeRuleset: GroupedRuleset = {
      version: 1,
      rules: {
        shell_exec: {
          default: "ask",
          allow: ["python *"],
        },
      },
    };

    test("runtime allow overrides default ask", () => {
      expect(evaluate("shell_exec", ["python script.py"], staticRuleset, runtimeRuleset)).toBe("allow");
    });

    test("static deny cannot be overridden by runtime allow", () => {
      const runtimeWithDenyOverride: GroupedRuleset = {
        version: 1,
        rules: {
          shell_exec: {
            default: "ask",
            allow: ["rm -rf *"],
          },
        },
      };
      expect(evaluate("shell_exec", ["rm -rf /"], staticRuleset, runtimeWithDenyOverride)).toBe("deny");
    });

    test("runtime layer is checked after static for allow (later wins)", () => {
      expect(evaluate("shell_exec", ["python script.py"], staticRuleset, runtimeRuleset)).toBe("allow");
    });
  });

  describe("with DEFAULT_RULESET", () => {
    test("read_file is allowed by default", () => {
      expect(evaluate("read_file", ["src/app.ts"], DEFAULT_RULESET)).toBe("allow");
    });

    test("read_file denies .env", () => {
      expect(evaluate("read_file", [".env"], DEFAULT_RULESET)).toBe("deny");
    });

    test("glob is allowed", () => {
      expect(evaluate("glob", ["**/*.ts"], DEFAULT_RULESET)).toBe("allow");
    });

    test("shell_exec asks by default", () => {
      expect(evaluate("shell_exec", ["python script.py"], DEFAULT_RULESET)).toBe("ask");
    });

    test("shell_exec asks for all commands (empty allow/deny lists)", () => {
      expect(evaluate("shell_exec", ["cat file.txt"], DEFAULT_RULESET)).toBe("ask");
      expect(evaluate("shell_exec", ["git status"], DEFAULT_RULESET)).toBe("ask");
      expect(evaluate("shell_exec", ["bun test foo"], DEFAULT_RULESET)).toBe("ask");
      expect(evaluate("shell_exec", ["rm -rf /"], DEFAULT_RULESET)).toBe("ask");
      expect(evaluate("shell_exec", ["git push --force origin main"], DEFAULT_RULESET)).toBe("ask");
    });

    test("skill asks by default", () => {
      expect(evaluate("skill", ["deploy"], DEFAULT_RULESET)).toBe("ask");
    });

    test("skill with no patterns uses default", () => {
      expect(evaluate("skill", [], DEFAULT_RULESET)).toBe("ask");
    });

    test("unknown tool asks", () => {
      expect(evaluate("mystery_tool", [], DEFAULT_RULESET)).toBe("ask");
    });
  });
});
