import { describe, test, expect } from "bun:test";
import { parseShellCommand, prefix } from "../../src/approval/shell-parser.js";

describe("prefix", () => {
  test("arity 1 commands", () => {
    expect(prefix(["cat", "file.txt"])).toEqual(["cat"]);
    expect(prefix(["ls", "-la"])).toEqual(["ls"]);
    expect(prefix(["rm", "-rf", "/"])).toEqual(["rm"]);
  });

  test("arity 2 commands", () => {
    expect(prefix(["git", "push", "origin", "main"])).toEqual(["git", "push"]);
    expect(prefix(["npm", "install", "react"])).toEqual(["npm", "install"]);
    expect(prefix(["bun", "test", "foo"])).toEqual(["bun", "test"]);
    expect(prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"]);
  });

  test("arity 3 commands", () => {
    expect(prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
    expect(prefix(["bun", "run", "test"])).toEqual(["bun", "run", "test"]);
    expect(prefix(["docker", "compose", "up"])).toEqual(["docker", "compose", "up"]);
    expect(prefix(["git", "remote", "add"])).toEqual(["git", "remote", "add"]);
    expect(prefix(["gh", "pr", "list"])).toEqual(["gh", "pr", "list"]);
  });

  test("unknown command falls back to first token", () => {
    expect(prefix(["mycommand", "arg1", "arg2"])).toEqual(["mycommand"]);
  });

  test("single token command", () => {
    expect(prefix(["pwd"])).toEqual(["pwd"]);
    expect(prefix(["whoami"])).toEqual(["whoami"]);
  });
});

describe("parseShellCommand", () => {
  test("simple command", async () => {
    const result = await parseShellCommand("git push origin main");
    expect(result.patterns).toEqual(["git push origin main"]);
    expect(result.always).toEqual(["git push *"]);
  });

  test("simple command without args", async () => {
    const result = await parseShellCommand("pwd");
    expect(result.patterns).toEqual(["pwd"]);
    expect(result.always).toEqual(["pwd"]);
  });

  test("pipeline", async () => {
    const result = await parseShellCommand("cat file.txt | grep error | wc -l");
    expect(result.patterns).toHaveLength(3);
    expect(result.patterns[0]).toBe("cat file.txt");
    expect(result.patterns[1]).toBe("grep error");
    expect(result.patterns[2]).toBe("wc -l");
    expect(result.always[0]).toBe("cat *");
    expect(result.always[1]).toBe("grep *");
    expect(result.always[2]).toBe("wc *");
  });

  test("&& chain", async () => {
    const result = await parseShellCommand("git add . && git commit -m 'fix'");
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns[0]).toBe("git add .");
    expect(result.patterns[1]).toContain("git commit");
    expect(result.always[0]).toBe("git add *");
    expect(result.always[1]).toBe("git commit *");
  });

  test("|| chain", async () => {
    const result = await parseShellCommand("cd /tmp || exit 1");
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns[0]).toBe("cd /tmp");
  });

  test("semicolon separated", async () => {
    const result = await parseShellCommand("echo hello; ls");
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns[0]).toBe("echo hello");
    expect(result.patterns[1]).toBe("ls");
  });

  test("npm run (arity 3)", async () => {
    const result = await parseShellCommand("npm run build");
    expect(result.patterns).toEqual(["npm run build"]);
    expect(result.always).toEqual(["npm run build"]);
  });

  test("npm run with extra args", async () => {
    const result = await parseShellCommand("npm run test -- --coverage");
    expect(result.patterns).toHaveLength(1);
    expect(result.always[0]).toBe("npm run test *");
  });

  test("command with quoted string", async () => {
    const result = await parseShellCommand('git commit -m "fix bug"');
    expect(result.patterns).toHaveLength(1);
    expect(result.always[0]).toBe("git commit *");
  });

  test("bunx tsc", async () => {
    const result = await parseShellCommand("bunx tsc --noEmit");
    expect(result.patterns).toHaveLength(1);
    expect(result.always[0]).toBe("bunx tsc *");
  });

  test("complex pipeline with chains", async () => {
    const result = await parseShellCommand("git status && git diff | head -20");
    // tree-sitter should parse this as: (git status) && (git diff | head -20)
    expect(result.patterns.length).toBeGreaterThanOrEqual(3);
  });
});
