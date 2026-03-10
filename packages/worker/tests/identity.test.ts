import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { getOrCreateWorkerId } from "../src/identity.js";
import { writeFileSync, mkdirSync, statSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("getOrCreateWorkerId", () => {
  test("first call creates UUID", () => {
    const dir = `${tmp.path}/id1`;
    mkdirSync(dir, { recursive: true });
    const id = getOrCreateWorkerId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const file = resolve(dir, ".molf", "worker.json");
    expect(statSync(file).size).toBeGreaterThan(0);
  });

  test("second call returns same UUID", () => {
    const dir = `${tmp.path}/id2`;
    mkdirSync(dir, { recursive: true });
    const id1 = getOrCreateWorkerId(dir);
    const id2 = getOrCreateWorkerId(dir);
    expect(id1).toBe(id2);
  });

  test("corrupt file regenerates UUID", () => {
    const dir = `${tmp.path}/id3`;
    const molfDir = resolve(dir, ".molf");
    mkdirSync(molfDir, { recursive: true });
    writeFileSync(resolve(molfDir, "worker.json"), "not json");
    const id = getOrCreateWorkerId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("creates .molf/ directory if missing", () => {
    const dir = `${tmp.path}/id4`;
    mkdirSync(dir, { recursive: true });
    getOrCreateWorkerId(dir);
    expect(statSync(resolve(dir, ".molf", "worker.json")).size).toBeGreaterThan(0);
  });
});
