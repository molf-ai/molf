import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { initAuth, verifyToken } from "../src/auth.js";

let tmp: TmpDir;

beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("auth", () => {
  test("initAuth generates random token and saves hash", () => {
    const dir = `${tmp.path}/auth1`;
    const { token } = initAuth(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(Bun.file(`${dir}/server.json`).size).toBeGreaterThan(0);
  });

  test("verifyToken with correct token", () => {
    const dir = `${tmp.path}/auth2`;
    const { token } = initAuth(dir);
    expect(verifyToken(token, dir)).toBe(true);
  });

  test("verifyToken with wrong token", () => {
    const dir = `${tmp.path}/auth3`;
    initAuth(dir);
    expect(verifyToken("wrong-token", dir)).toBe(false);
  });

  test("initAuth with fixedToken uses that token", () => {
    const dir = `${tmp.path}/auth4`;
    const { token } = initAuth(dir, "my-fixed-token");
    expect(token).toBe("my-fixed-token");
    expect(verifyToken("my-fixed-token", dir)).toBe(true);
  });

  test("initAuth ignores MOLF_TOKEN env var (token only via param)", () => {
    const dir = `${tmp.path}/auth-env-ignored`;
    const origEnv = process.env.MOLF_TOKEN;
    process.env.MOLF_TOKEN = "env-token-should-be-ignored";
    try {
      const { token } = initAuth(dir);
      // Should generate a random token, not use the env var
      expect(token).not.toBe("env-token-should-be-ignored");
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (origEnv === undefined) delete process.env.MOLF_TOKEN;
      else process.env.MOLF_TOKEN = origEnv;
    }
  });

  test("verifyToken when server.json missing", () => {
    expect(verifyToken("any-token", `${tmp.path}/nonexistent`)).toBe(false);
  });

  test("verifyToken when server.json is corrupt", () => {
    const dir = `${tmp.path}/auth-corrupt`;
    const { mkdirSync, writeFileSync } = require("fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/server.json`, "not json");
    expect(verifyToken("any-token", dir)).toBe(false);
  });

  test("initAuth called twice regenerates token", () => {
    const dir = `${tmp.path}/auth-regen`;
    const { token: token1 } = initAuth(dir);
    const { token: token2 } = initAuth(dir);
    expect(token1).not.toBe(token2);
  });
});
