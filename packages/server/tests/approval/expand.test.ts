import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import { expand } from "../../src/approval/expand.js";

describe("expand", () => {
  const home = homedir();

  test("expands ~/path to homedir/path", () => {
    expect(expand("~/Documents")).toBe(`${home}/Documents`);
    expect(expand("~/.config/app")).toBe(`${home}/.config/app`);
  });

  test("expands bare ~ to homedir", () => {
    expect(expand("~")).toBe(home);
  });

  test("expands $HOME/path to homedir/path", () => {
    expect(expand("$HOME/Documents")).toBe(`${home}/Documents`);
    expect(expand("$HOME/.ssh/id_rsa")).toBe(`${home}/.ssh/id_rsa`);
  });

  test("expands bare $HOME to homedir", () => {
    expect(expand("$HOME")).toBe(home);
  });

  test("does not expand absolute paths", () => {
    expect(expand("/usr/local/bin")).toBe("/usr/local/bin");
  });

  test("does not expand relative paths", () => {
    expect(expand("src/index.ts")).toBe("src/index.ts");
  });

  test("does not expand wildcards", () => {
    expect(expand("*.env")).toBe("*.env");
    expect(expand("*secret*")).toBe("*secret*");
  });

  test("does not expand ~ in the middle of a string", () => {
    expect(expand("foo~bar")).toBe("foo~bar");
  });

  test("does not expand $HOME in the middle of a string", () => {
    expect(expand("foo$HOME/bar")).toBe("foo$HOME/bar");
  });
});
