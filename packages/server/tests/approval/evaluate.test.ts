import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import { evaluate, patternMatches, extractPatterns, findMatchingRules, fromConfig, toConfig } from "../../src/approval/evaluate.js";
import { DEFAULT_RULESET } from "../../src/approval/defaults.js";
import type { Ruleset, CompactPermission } from "../../src/approval/types.js";

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
  const staticRuleset: Ruleset = [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read_file", pattern: "*", action: "allow" },
    { permission: "read_file", pattern: "*.env", action: "deny" },
    { permission: "read_file", pattern: "*secret*", action: "deny" },
    { permission: "read_file", pattern: "*.env.example", action: "allow" },
    { permission: "shell_exec", pattern: "*", action: "ask" },
    { permission: "shell_exec", pattern: "cat *", action: "allow" },
    { permission: "shell_exec", pattern: "ls *", action: "allow" },
    { permission: "shell_exec", pattern: "rm -rf *", action: "deny" },
  ];

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

  test("last match wins — allow after deny overrides deny", () => {
    // .env.example matches deny "*.env" but ALSO matches allow "*.env.example"
    // which comes later in the array, so last match wins → allow
    expect(evaluate("read_file", [".env.example"], staticRuleset)).toBe("allow");
  });

  test("deny is last match for .env (no subsequent allow matches)", () => {
    // .env matches deny "*.env" and there's no later allow that matches → deny
    expect(evaluate("read_file", [".env"], staticRuleset)).toBe("deny");
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
    const runtimeRuleset: Ruleset = [
      { permission: "shell_exec", pattern: "python *", action: "allow" },
    ];

    test("runtime allow overrides static ask (last match wins)", () => {
      expect(evaluate("shell_exec", ["python script.py"], staticRuleset, runtimeRuleset)).toBe("allow");
    });

    test("runtime allow overrides static deny (last match wins across merged arrays)", () => {
      const runtimeWithDenyOverride: Ruleset = [
        { permission: "shell_exec", pattern: "rm -rf *", action: "allow" },
      ];
      // static has deny for "rm -rf *", but runtime comes after static in the merge,
      // so the runtime allow is the last match → allow
      expect(evaluate("shell_exec", ["rm -rf /"], staticRuleset, runtimeWithDenyOverride)).toBe("allow");
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

    test("read_file allows .env.example (last match wins over .env deny)", () => {
      expect(evaluate("read_file", [".env.example"], DEFAULT_RULESET)).toBe("allow");
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

describe("findMatchingRules", () => {
  const ruleset: Ruleset = [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read_file", pattern: "*", action: "allow" },
    { permission: "read_file", pattern: "*.env", action: "deny" },
    { permission: "shell_exec", pattern: "git *", action: "allow" },
  ];

  test("returns all matching rules for a permission+pattern", () => {
    const rules = findMatchingRules("read_file", ".env", ruleset);
    // Matches: "*/*" catch-all, "read_file/*" allow, "read_file/*.env" deny
    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "ask" });
    expect(rules[1]).toEqual({ permission: "read_file", pattern: "*", action: "allow" });
    expect(rules[2]).toEqual({ permission: "read_file", pattern: "*.env", action: "deny" });
  });

  test("returns empty array when no rules match", () => {
    const rules = findMatchingRules("unknown_tool", "specific_pattern", ruleset);
    // Only the catch-all matches
    expect(rules).toHaveLength(1);
    expect(rules[0].permission).toBe("*");
  });

  test("works across multiple rulesets", () => {
    const runtime: Ruleset = [
      { permission: "read_file", pattern: "*.env", action: "allow" },
    ];
    const rules = findMatchingRules("read_file", ".env", ruleset, runtime);
    // 3 from static + 1 from runtime
    expect(rules).toHaveLength(4);
    expect(rules[3]).toEqual({ permission: "read_file", pattern: "*.env", action: "allow" });
  });

  test("returns empty for completely unmatched permission+pattern", () => {
    const narrow: Ruleset = [
      { permission: "shell_exec", pattern: "git *", action: "allow" },
    ];
    const rules = findMatchingRules("read_file", "foo.txt", narrow);
    expect(rules).toHaveLength(0);
  });
});

describe("fromConfig", () => {
  test("converts simple action to wildcard pattern rule", () => {
    const config: CompactPermission = { glob: "allow" };
    const ruleset = fromConfig(config);
    expect(ruleset).toEqual([
      { permission: "glob", pattern: "*", action: "allow" },
    ]);
  });

  test("converts detailed patterns to individual rules", () => {
    const config: CompactPermission = {
      read_file: { "*": "allow", "*.env": "deny" },
    };
    const ruleset = fromConfig(config);
    expect(ruleset).toEqual([
      { permission: "read_file", pattern: "*", action: "allow" },
      { permission: "read_file", pattern: "*.env", action: "deny" },
    ]);
  });

  test("converts mixed simple and detailed", () => {
    const config: CompactPermission = {
      "*": "ask",
      glob: "allow",
      read_file: { "*": "allow", "*.env": "deny" },
    };
    const ruleset = fromConfig(config);
    expect(ruleset).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "read_file", pattern: "*", action: "allow" },
      { permission: "read_file", pattern: "*.env", action: "deny" },
    ]);
  });

  test("expands ~/ and $HOME/ in patterns", () => {
    const home = homedir();
    const config: CompactPermission = {
      read_file: { "~/secrets": "deny", "$HOME/.ssh/*": "deny", "*": "allow" },
    };
    const ruleset = fromConfig(config);
    expect(ruleset).toEqual([
      { permission: "read_file", pattern: `${home}/secrets`, action: "deny" },
      { permission: "read_file", pattern: `${home}/.ssh/*`, action: "deny" },
      { permission: "read_file", pattern: "*", action: "allow" },
    ]);
  });

  test("integrates with evaluate()", () => {
    const config: CompactPermission = {
      "*": "ask",
      read_file: { "*": "allow", "*.env": "deny" },
      shell_exec: "ask",
    };
    const ruleset = fromConfig(config);
    expect(evaluate("read_file", ["src/index.ts"], ruleset)).toBe("allow");
    expect(evaluate("read_file", [".env"], ruleset)).toBe("deny");
    expect(evaluate("shell_exec", ["git status"], ruleset)).toBe("ask");
    expect(evaluate("unknown", ["foo"], ruleset)).toBe("ask");
  });
});

describe("toConfig", () => {
  test("collapses wildcard-only rule to simple action", () => {
    const config = toConfig([
      { permission: "glob", pattern: "*", action: "allow" },
    ]);
    expect(config).toEqual({ glob: "allow" });
  });

  test("non-wildcard pattern uses object form", () => {
    const config = toConfig([
      { permission: "read_file", pattern: "*.env", action: "deny" },
    ]);
    expect(config).toEqual({ read_file: { "*.env": "deny" } });
  });

  test("multiple patterns for same permission use object form", () => {
    const config = toConfig([
      { permission: "read_file", pattern: "*", action: "allow" },
      { permission: "read_file", pattern: "*.env", action: "deny" },
    ]);
    expect(config).toEqual({
      read_file: { "*": "allow", "*.env": "deny" },
    });
  });

  test("promotes simple action to object when second pattern arrives", () => {
    const config = toConfig([
      { permission: "shell_exec", pattern: "*", action: "ask" },
      { permission: "shell_exec", pattern: "git *", action: "allow" },
    ]);
    expect(config).toEqual({
      shell_exec: { "*": "ask", "git *": "allow" },
    });
  });

  test("roundtrip: fromConfig → toConfig preserves config", () => {
    const original: CompactPermission = {
      "*": "ask",
      glob: "allow",
      read_file: { "*": "allow", "*.env": "deny" },
      shell_exec: "ask",
    };
    expect(toConfig(fromConfig(original))).toEqual(original);
  });

  test("roundtrip: toConfig → fromConfig preserves evaluation", () => {
    const ruleset = [
      { permission: "*", pattern: "*", action: "ask" as const },
      { permission: "read_file", pattern: "*", action: "allow" as const },
      { permission: "read_file", pattern: "*.env", action: "deny" as const },
    ];
    const roundtripped = fromConfig(toConfig(ruleset));
    expect(evaluate("read_file", ["src/index.ts"], roundtripped)).toBe("allow");
    expect(evaluate("read_file", [".env"], roundtripped)).toBe("deny");
    expect(evaluate("unknown", ["foo"], roundtripped)).toBe("ask");
  });
});
