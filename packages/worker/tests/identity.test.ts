import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getOrCreateWorkerId } from "../src/identity.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "molf-identity-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("getOrCreateWorkerId", () => {
  test("generates a new UUID on first call", () => {
    const id = getOrCreateWorkerId(testDir);

    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    // UUID v4 format
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("persists the UUID to .molf/worker.json", () => {
    const id = getOrCreateWorkerId(testDir);

    const filePath = join(testDir, ".molf", "worker.json");
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(data.workerId).toBe(id);
  });

  test("reuses existing UUID on subsequent calls", () => {
    const first = getOrCreateWorkerId(testDir);
    const second = getOrCreateWorkerId(testDir);

    expect(second).toBe(first);
  });

  test("creates .molf directory if it does not exist", () => {
    const molfDir = join(testDir, ".molf");
    expect(existsSync(molfDir)).toBe(false);

    getOrCreateWorkerId(testDir);

    expect(existsSync(molfDir)).toBe(true);
  });

  test("different workdirs produce different UUIDs", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "molf-id1-"));
    const dir2 = mkdtempSync(join(tmpdir(), "molf-id2-"));

    try {
      const id1 = getOrCreateWorkerId(dir1);
      const id2 = getOrCreateWorkerId(dir2);

      expect(id1).not.toBe(id2);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
