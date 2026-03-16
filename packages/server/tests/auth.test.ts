import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import {
  initAuth,
  verifyCredential,
  generateApiKey,
  addApiKey,
  listApiKeys,
  revokeApiKey,
} from "../src/auth.js";

let tmp: TmpDir;

beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("initAuth", () => {
  test("generates random token and saves to secrets.json", () => {
    const dir = `${tmp.path}/init1`;
    const { token } = initAuth(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const data = JSON.parse(readFileSync(`${dir}/secrets.json`, "utf-8"));
    expect(data.auth.masterTokenHash).toBeTypeOf("string");
    expect(data.auth.apiKeys).toEqual([]);
    expect(data.providerKeys).toEqual({});
  });

  test("uses fixed token when provided", () => {
    const dir = `${tmp.path}/init2`;
    const { token } = initAuth(dir, "my-fixed-token");
    expect(token).toBe("my-fixed-token");
  });

  test("called twice regenerates token but preserves apiKeys", () => {
    const dir = `${tmp.path}/init3`;
    const { token: token1 } = initAuth(dir);

    // Add an API key
    const apiKey = generateApiKey();
    addApiKey(dir, {
      id: "test-id",
      name: "test-device",
      hash: createHash("sha256").update(apiKey).digest("hex"),
      createdAt: Date.now(),
    });

    const { token: token2 } = initAuth(dir);
    expect(token1).not.toBe(token2);

    // API keys should be preserved
    const keys = listApiKeys(dir);
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("test-device");
  });

  test("migrates legacy server.json into secrets.json", () => {
    const dir = `${tmp.path}/migrate`;
    mkdirSync(dir, { recursive: true });

    // Write legacy format
    writeFileSync(`${dir}/server.json`, JSON.stringify({ tokenHash: createHash("sha256").update("old-token").digest("hex") }));

    // initAuth should read via migration and overwrite with new master token
    const { token } = initAuth(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const data = JSON.parse(readFileSync(`${dir}/secrets.json`, "utf-8"));
    expect(data.auth.masterTokenHash).toBeTypeOf("string");
    expect(data.auth.apiKeys).toEqual([]);
  });
});

describe("verifyCredential", () => {
  test("master token returns valid + master type", () => {
    const dir = `${tmp.path}/verify1`;
    const { token } = initAuth(dir);
    const result = verifyCredential(token, dir);
    expect(result).toEqual({ valid: true, type: "master" });
  });

  test("wrong token returns invalid", () => {
    const dir = `${tmp.path}/verify2`;
    initAuth(dir);
    const result = verifyCredential("wrong-token", dir);
    expect(result).toEqual({ valid: false, type: null });
  });

  test("API key returns valid + apiKey type", () => {
    const dir = `${tmp.path}/verify3`;
    initAuth(dir);

    const apiKey = generateApiKey();
    addApiKey(dir, {
      id: "key-1",
      name: "laptop",
      hash: createHash("sha256").update(apiKey).digest("hex"),
      createdAt: Date.now(),
    });

    const result = verifyCredential(apiKey, dir);
    expect(result).toEqual({ valid: true, type: "apiKey", keyId: "key-1", keyName: "laptop" });
  });

  test("revoked API key returns invalid", () => {
    const dir = `${tmp.path}/verify4`;
    initAuth(dir);

    const apiKey = generateApiKey();
    addApiKey(dir, {
      id: "key-revoke",
      name: "old-device",
      hash: createHash("sha256").update(apiKey).digest("hex"),
      createdAt: Date.now(),
    });

    revokeApiKey(dir, "key-revoke");
    const result = verifyCredential(apiKey, dir);
    expect(result).toEqual({ valid: false, type: null });
  });

  test("unknown API key returns invalid", () => {
    const dir = `${tmp.path}/verify5`;
    initAuth(dir);
    const result = verifyCredential("yk_unknown_key_value", dir);
    expect(result).toEqual({ valid: false, type: null });
  });

  test("missing secrets.json returns invalid", () => {
    const result = verifyCredential("any", `${tmp.path}/nonexistent`);
    expect(result).toEqual({ valid: false, type: null });
  });

  test("corrupt secrets.json returns invalid", () => {
    const dir = `${tmp.path}/verify-corrupt`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/secrets.json`, "not json");
    const result = verifyCredential("any", dir);
    expect(result).toEqual({ valid: false, type: null });
  });
});

describe("generateApiKey", () => {
  test("starts with yk_ prefix", () => {
    const key = generateApiKey();
    expect(key.startsWith("yk_")).toBe(true);
  });

  test("is sufficiently long (yk_ + 43 chars base64url)", () => {
    const key = generateApiKey();
    // 32 bytes base64url = 43 chars (no padding)
    expect(key.length).toBe(3 + 43); // "yk_" + 43
  });

  test("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));
    expect(keys.size).toBe(10);
  });
});

describe("API key CRUD", () => {
  test("addApiKey and listApiKeys", () => {
    const dir = `${tmp.path}/crud1`;
    initAuth(dir);

    addApiKey(dir, { id: "a", name: "device-a", hash: "hash-a", createdAt: 1000 });
    addApiKey(dir, { id: "b", name: "device-b", hash: "hash-b", createdAt: 2000 });

    const keys = listApiKeys(dir);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual({ id: "a", name: "device-a", hash: "hash-a", createdAt: 1000, revokedAt: null });
    expect(keys[1]).toEqual({ id: "b", name: "device-b", hash: "hash-b", createdAt: 2000, revokedAt: null });
  });

  test("revokeApiKey sets revokedAt", () => {
    const dir = `${tmp.path}/crud2`;
    initAuth(dir);

    addApiKey(dir, { id: "r1", name: "revokable", hash: "hash-r1", createdAt: 1000 });
    const revoked = revokeApiKey(dir, "r1");
    expect(revoked).toBe(true);

    const keys = listApiKeys(dir);
    expect(keys[0].revokedAt).toBeTypeOf("number");
  });

  test("revokeApiKey returns false for nonexistent key", () => {
    const dir = `${tmp.path}/crud3`;
    initAuth(dir);
    expect(revokeApiKey(dir, "nonexistent")).toBe(false);
  });

  test("revokeApiKey returns false for already-revoked key", () => {
    const dir = `${tmp.path}/crud4`;
    initAuth(dir);

    addApiKey(dir, { id: "r2", name: "device", hash: "hash", createdAt: 1000 });
    revokeApiKey(dir, "r2");
    expect(revokeApiKey(dir, "r2")).toBe(false);
  });

  test("listApiKeys returns empty when no secrets.json", () => {
    expect(listApiKeys(`${tmp.path}/no-dir`)).toEqual([]);
  });
});
