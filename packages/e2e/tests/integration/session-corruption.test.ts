import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { startTestServer, createTestClient, connectTestWorker } from "../../helpers/index.js";
import type { TestServer, TestWorker } from "../../helpers/index.js";

// =============================================================================
// Session Corruption Handling: corrupt JSON, verify error and list skips it
// =============================================================================

describe("Session Corruption Handling", () => {
  let server: TestServer;
  let worker: TestWorker;

  beforeAll(async () => {
    server = await startTestServer();
    worker = await connectTestWorker(server.url, server.token, "corruption-worker");
  });

  afterAll(() => {
    worker.cleanup();
    server.cleanup();
  });

  test("loading a corrupt session returns INTERNAL_SERVER_ERROR", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create a valid session
      const session = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Soon-to-be-corrupt",
      });

      // Verify we can load it
      const loaded = await client.trpc.session.load.mutate({
        sessionId: session.sessionId,
      });
      expect(loaded.sessionId).toBe(session.sessionId);

      // Release from memory cache first so it doesn't overwrite our corruption
      await server.instance._ctx.sessionMgr.release(session.sessionId);

      // Now corrupt the JSON file on disk
      const sessionFilePath = resolve(
        server.tmp.path,
        "sessions",
        `${session.sessionId}.json`,
      );
      writeFileSync(sessionFilePath, "{{{{CORRUPT JSON NOT VALID}}}}");

      // Try to load — should throw INTERNAL_SERVER_ERROR
      await expect(
        client.trpc.session.load.mutate({ sessionId: session.sessionId }),
      ).rejects.toThrow(/corrupt/i);
    } finally {
      client.cleanup();
    }
  });

  test("session.list skips corrupt session files", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create two sessions: one valid, one we'll corrupt
      const validSession = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Valid Session",
      });

      const corruptSession = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Will Be Corrupt",
      });

      // Release both from memory
      await server.instance._ctx.sessionMgr.release(validSession.sessionId);
      await server.instance._ctx.sessionMgr.release(corruptSession.sessionId);

      // Corrupt one session file
      const corruptFilePath = resolve(
        server.tmp.path,
        "sessions",
        `${corruptSession.sessionId}.json`,
      );
      writeFileSync(corruptFilePath, "NOT VALID JSON {{{");

      // List sessions — corrupt one should be skipped
      const listed = await client.trpc.session.list.query();
      const sessionIds = listed.sessions.map((s) => s.sessionId);

      // Valid session should appear
      expect(sessionIds).toContain(validSession.sessionId);

      // Corrupt session should be skipped (not cause an error)
      expect(sessionIds).not.toContain(corruptSession.sessionId);
    } finally {
      client.cleanup();
    }
  });

  test("corrupt session does not affect other session operations", async () => {
    const client = createTestClient(server.url, server.token);
    try {
      // Create and corrupt a session
      const corruptSession = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Another Corrupt",
      });

      await server.instance._ctx.sessionMgr.release(corruptSession.sessionId);

      const filePath = resolve(
        server.tmp.path,
        "sessions",
        `${corruptSession.sessionId}.json`,
      );
      writeFileSync(filePath, "BROKEN");

      // Create a new session — should work fine despite corrupt file existing
      const newSession = await client.trpc.session.create.mutate({
        workerId: worker.workerId,
        name: "Fresh Session",
      });
      expect(newSession.sessionId).toBeTruthy();

      // Load the new session — should work fine
      const loaded = await client.trpc.session.load.mutate({
        sessionId: newSession.sessionId,
      });
      expect(loaded.name).toBe("Fresh Session");
    } finally {
      client.cleanup();
    }
  });
});
