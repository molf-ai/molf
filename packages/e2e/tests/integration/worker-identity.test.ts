import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createTmpDir } from "@molf-ai/test-utils";
import { getOrCreateWorkerId } from "../../../worker/src/identity.js";

/**
 * Integration tests for worker identity persistence.
 *
 * When a worker starts from the same workdir, it should reuse the same
 * UUID stored in .molf/worker.json rather than generating a new one.
 */
describe("Worker identity persistence", () => {
  test("getOrCreateWorkerId returns same ID on subsequent calls from same workdir", () => {
    const tmp = createTmpDir("molf-identity-test-");
    try {
      const firstId = getOrCreateWorkerId(tmp.path);
      const secondId = getOrCreateWorkerId(tmp.path);

      expect(firstId).toBe(secondId);
      expect(firstId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      tmp.cleanup();
    }
  });

  test("identity file is created at .molf/worker.json", () => {
    const tmp = createTmpDir("molf-identity-test-");
    try {
      const workerId = getOrCreateWorkerId(tmp.path);
      const identityPath = resolve(tmp.path, ".molf", "worker.json");

      expect(existsSync(identityPath)).toBe(true);

      const data = JSON.parse(readFileSync(identityPath, "utf-8"));
      expect(data.workerId).toBe(workerId);
    } finally {
      tmp.cleanup();
    }
  });

  test("different workdirs get different worker IDs", () => {
    const tmp1 = createTmpDir("molf-identity-test-");
    const tmp2 = createTmpDir("molf-identity-test-");
    try {
      const id1 = getOrCreateWorkerId(tmp1.path);
      const id2 = getOrCreateWorkerId(tmp2.path);

      expect(id1).not.toBe(id2);
    } finally {
      tmp1.cleanup();
      tmp2.cleanup();
    }
  });
});
