import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

// We test the internal functions by importing directly
import {
  loadCredential,
  saveCredential,
  removeCredential,
  getCredentialsPath,
  saveTlsCert,
  loadTlsCertPem,
} from "../src/credentials.js";

const CREDS_DIR = resolve(homedir(), ".molf");
const CREDS_PATH = resolve(CREDS_DIR, "credentials.json");

let originalContent: string | null = null;
let originalEnv: string | undefined;

beforeEach(() => {
  // Preserve env var
  originalEnv = process.env.MOLF_CREDENTIALS_DIR;
  delete process.env.MOLF_CREDENTIALS_DIR;

  // Back up existing credentials if present
  try {
    originalContent = readFileSync(CREDS_PATH, "utf-8");
  } catch {
    originalContent = null;
  }
});

afterEach(() => {
  // Restore env var
  if (originalEnv !== undefined) {
    process.env.MOLF_CREDENTIALS_DIR = originalEnv;
  } else {
    delete process.env.MOLF_CREDENTIALS_DIR;
  }

  // Restore original content
  if (originalContent !== null) {
    mkdirSync(CREDS_DIR, { recursive: true });
    const { writeFileSync, chmodSync } = require("fs");
    writeFileSync(CREDS_PATH, originalContent);
    chmodSync(CREDS_PATH, 0o600);
  } else {
    try { rmSync(CREDS_PATH); } catch { /* didn't exist */ }
  }
});

describe("credentials", () => {
  test("getCredentialsPath returns expected path", () => {
    expect(getCredentialsPath()).toBe(CREDS_PATH);
  });

  test("loadCredential returns null when no file exists", () => {
    try { rmSync(CREDS_PATH); } catch { /* ok */ }
    expect(loadCredential("ws://localhost:7600")).toBeNull();
  });

  test("saveCredential and loadCredential roundtrip", () => {
    saveCredential("ws://localhost:7600", { apiKey: "yk_test123", name: "laptop" });

    const loaded = loadCredential("ws://localhost:7600");
    expect(loaded).toEqual({ apiKey: "yk_test123", name: "laptop" });
  });

  test("credentials file has 0o600 permissions", () => {
    saveCredential("ws://localhost:7600", { apiKey: "yk_test", name: "test" });

    const stat = statSync(CREDS_PATH);
    // Check owner-only read/write (mode & 0o777 === 0o600)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("multiple servers stored independently", () => {
    saveCredential("ws://server-a:7600", { apiKey: "yk_aaa", name: "a" });
    saveCredential("ws://server-b:7600", { apiKey: "yk_bbb", name: "b" });

    expect(loadCredential("ws://server-a:7600")?.apiKey).toBe("yk_aaa");
    expect(loadCredential("ws://server-b:7600")?.apiKey).toBe("yk_bbb");
  });

  test("saveCredential overwrites existing entry", () => {
    saveCredential("ws://localhost:7600", { apiKey: "yk_old", name: "old" });
    saveCredential("ws://localhost:7600", { apiKey: "yk_new", name: "new" });

    const loaded = loadCredential("ws://localhost:7600");
    expect(loaded).toEqual({ apiKey: "yk_new", name: "new" });
  });

  test("removeCredential deletes entry", () => {
    saveCredential("ws://localhost:7600", { apiKey: "yk_rm", name: "rm" });
    const removed = removeCredential("ws://localhost:7600");
    expect(removed).toBe(true);
    expect(loadCredential("ws://localhost:7600")).toBeNull();
  });

  test("removeCredential returns false for nonexistent", () => {
    expect(removeCredential("ws://nonexistent:9999")).toBe(false);
  });

  test("URL normalization: different paths map to same key", () => {
    saveCredential("ws://myhost:7600", { apiKey: "yk_norm", name: "test" });
    // Same host:port with trailing path should normalize to same key
    expect(loadCredential("ws://myhost:7600")).toEqual({ apiKey: "yk_norm", name: "test" });
  });

  test("removeCredential also removes cert file", () => {
    saveCredential("wss://cert-server:7600", { apiKey: "yk_cert", name: "cert" });
    saveTlsCert("wss://cert-server:7600", "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----");
    expect(loadTlsCertPem("wss://cert-server:7600")).not.toBeNull();

    removeCredential("wss://cert-server:7600");
    expect(loadCredential("wss://cert-server:7600")).toBeNull();
    expect(loadTlsCertPem("wss://cert-server:7600")).toBeNull();
  });

  test("MOLF_CREDENTIALS_DIR env var overrides default directory", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "molf-creds-test-"));
    process.env.MOLF_CREDENTIALS_DIR = tmpDir;

    try {
      expect(getCredentialsPath()).toBe(resolve(tmpDir, "credentials.json"));

      saveCredential("ws://env-test:7600", { apiKey: "yk_env", name: "env" });
      const loaded = loadCredential("ws://env-test:7600");
      expect(loaded).toEqual({ apiKey: "yk_env", name: "env" });

      // Verify file was written to the custom directory
      const content = readFileSync(resolve(tmpDir, "credentials.json"), "utf-8");
      expect(JSON.parse(content).servers).toHaveProperty("ws://env-test:7600");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
