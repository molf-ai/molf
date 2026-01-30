import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initAuth, verifyToken } from "../src/auth.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "molf-auth-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.MOLF_TOKEN;
});

describe("initAuth", () => {
  test("generates a token and saves hash", () => {
    const { token } = initAuth(testDir);

    expect(token).toBeDefined();
    expect(token.length).toBe(64); // 32 bytes hex
    expect(typeof token).toBe("string");
  });

  test("generated token can be verified", () => {
    const { token } = initAuth(testDir);
    expect(verifyToken(token, testDir)).toBe(true);
  });

  test("wrong token fails verification", () => {
    initAuth(testDir);
    expect(verifyToken("wrong-token", testDir)).toBe(false);
  });

  test("uses MOLF_TOKEN env var when set", () => {
    process.env.MOLF_TOKEN = "my-custom-token";
    const { token } = initAuth(testDir);

    expect(token).toBe("my-custom-token");
    expect(verifyToken("my-custom-token", testDir)).toBe(true);
  });

  test("regenerates token on restart without env var", () => {
    const first = initAuth(testDir);
    const second = initAuth(testDir);

    // Each call generates a new token (since we can't recover the old one)
    expect(first.token).not.toBe(second.token);
    // Only the latest token should verify
    expect(verifyToken(second.token, testDir)).toBe(true);
  });
});

describe("verifyToken", () => {
  test("returns false when no server.json exists", () => {
    expect(verifyToken("any-token", testDir)).toBe(false);
  });

  test("returns false for empty token", () => {
    initAuth(testDir);
    expect(verifyToken("", testDir)).toBe(false);
  });

  test("returns false for corrupted server.json", () => {
    const { writeFileSync, mkdirSync } = require("fs");
    const { resolve } = require("path");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(resolve(testDir, "server.json"), "NOT VALID JSON{{{");
    expect(verifyToken("any-token", testDir)).toBe(false);
  });
});
