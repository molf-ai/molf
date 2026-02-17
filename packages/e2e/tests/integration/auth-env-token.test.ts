import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestClient, type TestClient } from "../../helpers/index.js";
import { createTmpDir, createEnvGuard, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";
import type { ServerInstance } from "../../../server/src/server.js";

// =============================================================================
// Gap 20: Auth token via MOLF_TOKEN environment variable
//
// Start a server with MOLF_TOKEN set. Verify:
// 1. Connecting with that token grants access.
// 2. Connecting with the wrong token is rejected.
// =============================================================================

describe("Auth token via MOLF_TOKEN env var", () => {
  let tmp: TmpDir;
  let envGuard: EnvGuard;
  let server: ServerInstance;
  let url: string;
  const TOKEN = "test-secret-token-12345";

  beforeAll(() => {
    tmp = createTmpDir("molf-auth-test-");
    envGuard = createEnvGuard();
    envGuard.set("MOLF_TOKEN", TOKEN);

    server = startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      llm: { provider: "gemini", model: "test" },
    });

    const addr = server.wss.address() as { port: number };
    url = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    envGuard.restore();
    tmp.cleanup();
  });

  test("connection with correct MOLF_TOKEN is authorized", async () => {
    const client = createTestClient(url, TOKEN);
    try {
      // Should succeed — correct token
      const result = await client.trpc.session.list.query();
      expect(result.sessions).toBeDefined();
    } finally {
      client.cleanup();
    }
  });

  test("connection with wrong token is rejected with UNAUTHORIZED", async () => {
    const client = createTestClient(url, "wrong-token-value");
    try {
      await expect(
        client.trpc.session.list.query(),
      ).rejects.toThrow(/UNAUTHORIZED|authentication/i);
    } finally {
      client.cleanup();
    }
  });

  test("connection with empty token is rejected", async () => {
    const client = createTestClient(url, "");
    try {
      await expect(
        client.trpc.session.list.query(),
      ).rejects.toThrow(/UNAUTHORIZED|authentication/i);
    } finally {
      client.cleanup();
    }
  });

  test("server token matches the MOLF_TOKEN env var", () => {
    // The server should use the env var token directly
    expect(server.token).toBe(TOKEN);
  });
});
