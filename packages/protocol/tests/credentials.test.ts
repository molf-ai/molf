import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

import {
  loadServer,
  saveServer,
  removeServer,
  getServersPath,
  saveTlsCert,
  loadTlsCertPem,
} from "../src/credentials.js";

const CLIENT_DIR = resolve(homedir(), ".molf");
const SERVERS_PATH = resolve(CLIENT_DIR, "servers.json");

let originalContent: string | null = null;
let originalEnv: string | undefined;

beforeEach(() => {
  // Preserve env var
  originalEnv = process.env.MOLF_CLIENT_DIR;
  delete process.env.MOLF_CLIENT_DIR;

  // Back up existing servers file if present
  try {
    originalContent = readFileSync(SERVERS_PATH, "utf-8");
  } catch {
    originalContent = null;
  }
});

afterEach(() => {
  // Restore env var
  if (originalEnv !== undefined) {
    process.env.MOLF_CLIENT_DIR = originalEnv;
  } else {
    delete process.env.MOLF_CLIENT_DIR;
  }

  // Restore original content
  if (originalContent !== null) {
    mkdirSync(CLIENT_DIR, { recursive: true });
    const { writeFileSync, chmodSync } = require("fs");
    writeFileSync(SERVERS_PATH, originalContent);
    chmodSync(SERVERS_PATH, 0o600);
  } else {
    try { rmSync(SERVERS_PATH); } catch { /* didn't exist */ }
  }
});

describe("servers (credentials)", () => {
  test("getServersPath returns expected path", () => {
    expect(getServersPath()).toBe(SERVERS_PATH);
  });

  test("loadServer returns null when no file exists", () => {
    try { rmSync(SERVERS_PATH); } catch { /* ok */ }
    expect(loadServer("ws://localhost:7600")).toBeNull();
  });

  test("saveServer and loadServer roundtrip", () => {
    saveServer("ws://localhost:7600", { apiKey: "yk_test123", name: "laptop" });

    const loaded = loadServer("ws://localhost:7600");
    expect(loaded).toEqual({ apiKey: "yk_test123", name: "laptop" });
  });

  test("servers file has 0o600 permissions", () => {
    saveServer("ws://localhost:7600", { apiKey: "yk_test", name: "test" });

    const stat = statSync(SERVERS_PATH);
    // Check owner-only read/write (mode & 0o777 === 0o600)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("multiple servers stored independently", () => {
    saveServer("ws://server-a:7600", { apiKey: "yk_aaa", name: "a" });
    saveServer("ws://server-b:7600", { apiKey: "yk_bbb", name: "b" });

    expect(loadServer("ws://server-a:7600")?.apiKey).toBe("yk_aaa");
    expect(loadServer("ws://server-b:7600")?.apiKey).toBe("yk_bbb");
  });

  test("saveServer overwrites existing entry", () => {
    saveServer("ws://localhost:7600", { apiKey: "yk_old", name: "old" });
    saveServer("ws://localhost:7600", { apiKey: "yk_new", name: "new" });

    const loaded = loadServer("ws://localhost:7600");
    expect(loaded).toEqual({ apiKey: "yk_new", name: "new" });
  });

  test("removeServer deletes entry", () => {
    saveServer("ws://localhost:7600", { apiKey: "yk_rm", name: "rm" });
    const removed = removeServer("ws://localhost:7600");
    expect(removed).toBe(true);
    expect(loadServer("ws://localhost:7600")).toBeNull();
  });

  test("removeServer returns false for nonexistent", () => {
    expect(removeServer("ws://nonexistent:9999")).toBe(false);
  });

  test("URL normalization: different paths map to same key", () => {
    saveServer("ws://myhost:7600", { apiKey: "yk_norm", name: "test" });
    // Same host:port with trailing path should normalize to same key
    expect(loadServer("ws://myhost:7600")).toEqual({ apiKey: "yk_norm", name: "test" });
  });

  test("removeServer also removes cert file", () => {
    saveServer("wss://cert-server:7600", { apiKey: "yk_cert", name: "cert" });
    saveTlsCert("wss://cert-server:7600", "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----");
    expect(loadTlsCertPem("wss://cert-server:7600")).not.toBeNull();

    removeServer("wss://cert-server:7600");
    expect(loadServer("wss://cert-server:7600")).toBeNull();
    expect(loadTlsCertPem("wss://cert-server:7600")).toBeNull();
  });

  test("MOLF_CLIENT_DIR env var overrides default directory", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "molf-servers-test-"));
    process.env.MOLF_CLIENT_DIR = tmpDir;

    try {
      expect(getServersPath()).toBe(resolve(tmpDir, "servers.json"));

      saveServer("ws://env-test:7600", { apiKey: "yk_env", name: "env" });
      const loaded = loadServer("ws://env-test:7600");
      expect(loaded).toEqual({ apiKey: "yk_env", name: "env" });

      // Verify file was written to the custom directory
      const content = readFileSync(resolve(tmpDir, "servers.json"), "utf-8");
      expect(JSON.parse(content).servers).toHaveProperty("ws://env-test:7600");
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
