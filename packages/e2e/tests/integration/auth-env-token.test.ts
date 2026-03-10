import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTestClient, createTestProviderConfig, type TestClient } from "../../helpers/index.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";
import type { ServerInstance } from "../../../server/src/server.js";

// =============================================================================
// Gap 20: Auth token via config (--token / MOLF_TOKEN env var)
//
// Start a server with a fixed token passed via config. Verify:
// 1. Connecting with that token grants access.
// 2. Connecting with the wrong token is rejected.
// =============================================================================

describe("Auth token via config", () => {
  let tmp: TmpDir;
  let server: ServerInstance;
  let url: string;
  const TOKEN = "test-secret-token-12345";

  beforeAll(async () => {
    tmp = createTmpDir("molf-auth-test-");

    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      model: "gemini/test",
      providerConfig: createTestProviderConfig(tmp.path),
      token: TOKEN,
    });

    const addr = server.wss.address() as { port: number };
    url = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    tmp.cleanup();
  });

  test("connection with correct token is authorized", async () => {
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

  test("server token matches the provided token", () => {
    expect(server.token).toBe(TOKEN);
  });
});
