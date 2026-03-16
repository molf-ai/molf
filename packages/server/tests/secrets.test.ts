import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { createTmpDir } from "@molf-ai/test-utils";
import { readSecrets, writeSecrets } from "../src/secrets.js";

describe("readSecrets / writeSecrets", () => {
  test("returns null when no files exist", () => {
    const tmp = createTmpDir();
    expect(readSecrets(join(tmp.path, "empty"))).toBeNull();
  });

  test("round-trips data", () => {
    const tmp = createTmpDir();
    const data = {
      auth: { masterTokenHash: "abc123", apiKeys: [] },
      providerKeys: { openai: "sk-test" },
    };
    writeSecrets(tmp.path, data);
    expect(readSecrets(tmp.path)).toEqual(data);
  });

  test("writes with 0o600 permissions", () => {
    const tmp = createTmpDir();
    writeSecrets(tmp.path, {
      auth: { masterTokenHash: "x", apiKeys: [] },
      providerKeys: {},
    });
    const stat = statSync(join(tmp.path, "secrets.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("returns null for corrupt secrets.json", () => {
    const tmp = createTmpDir();
    writeFileSync(join(tmp.path, "secrets.json"), "not json");
    expect(readSecrets(tmp.path)).toBeNull();
  });
});

describe("migration from legacy files", () => {
  test("migrates server.json + provider-keys.json → secrets.json", () => {
    const tmp = createTmpDir();
    const dir = join(tmp.path, "migrate-both");
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "server.json"), JSON.stringify({
      masterTokenHash: "hash123",
      apiKeys: [{ id: "k1", name: "dev", hash: "h1", createdAt: 1000, revokedAt: null }],
    }));
    writeFileSync(join(dir, "provider-keys.json"), JSON.stringify({
      openai: "sk-openai",
      anthropic: "sk-anthropic",
    }));

    const result = readSecrets(dir);
    expect(result).toEqual({
      auth: {
        masterTokenHash: "hash123",
        apiKeys: [{ id: "k1", name: "dev", hash: "h1", createdAt: 1000, revokedAt: null }],
      },
      providerKeys: { openai: "sk-openai", anthropic: "sk-anthropic" },
    });

    // Legacy files should be deleted
    expect(existsSync(join(dir, "server.json"))).toBe(false);
    expect(existsSync(join(dir, "provider-keys.json"))).toBe(false);

    // secrets.json should exist
    expect(existsSync(join(dir, "secrets.json"))).toBe(true);
  });

  test("migrates server.json only", () => {
    const tmp = createTmpDir();
    const dir = join(tmp.path, "migrate-server");
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "server.json"), JSON.stringify({
      masterTokenHash: "hash456",
      apiKeys: [],
    }));

    const result = readSecrets(dir);
    expect(result).toEqual({
      auth: { masterTokenHash: "hash456", apiKeys: [] },
      providerKeys: {},
    });
    expect(existsSync(join(dir, "server.json"))).toBe(false);
  });

  test("migrates provider-keys.json only", () => {
    const tmp = createTmpDir();
    const dir = join(tmp.path, "migrate-keys");
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "provider-keys.json"), JSON.stringify({ gemini: "key-g" }));

    const result = readSecrets(dir);
    expect(result).toEqual({
      auth: { masterTokenHash: "", apiKeys: [] },
      providerKeys: { gemini: "key-g" },
    });
    expect(existsSync(join(dir, "provider-keys.json"))).toBe(false);
  });

  test("migrates old tokenHash format from server.json", () => {
    const tmp = createTmpDir();
    const dir = join(tmp.path, "migrate-old");
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "server.json"), JSON.stringify({ tokenHash: "oldhash" }));

    const result = readSecrets(dir);
    expect(result?.auth.masterTokenHash).toBe("oldhash");
  });

  test("does not re-migrate when secrets.json already exists", () => {
    const tmp = createTmpDir();
    const dir = join(tmp.path, "no-remigrate");
    mkdirSync(dir, { recursive: true });

    // Write secrets.json
    writeSecrets(dir, {
      auth: { masterTokenHash: "current", apiKeys: [] },
      providerKeys: { openai: "sk-current" },
    });

    // Write a legacy file that should be ignored
    writeFileSync(join(dir, "server.json"), JSON.stringify({ masterTokenHash: "stale" }));

    const result = readSecrets(dir);
    expect(result?.auth.masterTokenHash).toBe("current");
    // Legacy file should still exist (not deleted because secrets.json was found first)
    expect(existsSync(join(dir, "server.json"))).toBe(true);
  });
});
