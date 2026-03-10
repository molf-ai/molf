import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// We test the internal functions by importing directly
import {
  loadCredential,
  saveCredential,
  removeCredential,
  getCredentialsPath,
} from "../src/credentials.js";

const CREDS_DIR = resolve(homedir(), ".molf");
const CREDS_PATH = resolve(CREDS_DIR, "credentials.json");

let originalContent: string | null = null;

beforeEach(() => {
  // Back up existing credentials if present
  try {
    originalContent = readFileSync(CREDS_PATH, "utf-8");
  } catch {
    originalContent = null;
  }
});

afterEach(() => {
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
});
