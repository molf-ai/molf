import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { createEnvGuard, type EnvGuard } from "@molf-ai/test-utils";
import { initAuth, verifyToken } from "../src/auth.js";

let tmp: TmpDir;
let env: EnvGuard;

beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

describe("auth", () => {
  test("initAuth generates token and saves hash", () => {
    const dir = `${tmp.path}/auth1`;
    env.delete("MOLF_TOKEN");
    const { token } = initAuth(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(Bun.file(`${dir}/server.json`).size).toBeGreaterThan(0);
  });

  test("verifyToken with correct token", () => {
    const dir = `${tmp.path}/auth2`;
    env.delete("MOLF_TOKEN");
    const { token } = initAuth(dir);
    expect(verifyToken(token, dir)).toBe(true);
  });

  test("verifyToken with wrong token", () => {
    const dir = `${tmp.path}/auth3`;
    env.delete("MOLF_TOKEN");
    initAuth(dir);
    expect(verifyToken("wrong-token", dir)).toBe(false);
  });

  test("initAuth with MOLF_TOKEN env var", () => {
    const dir = `${tmp.path}/auth4`;
    env.set("MOLF_TOKEN", "my-env-token");
    const { token } = initAuth(dir);
    expect(token).toBe("my-env-token");
    expect(verifyToken("my-env-token", dir)).toBe(true);
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
    env.delete("MOLF_TOKEN");
    const { token: token1 } = initAuth(dir);
    const { token: token2 } = initAuth(dir);
    expect(token1).not.toBe(token2);
  });
});
