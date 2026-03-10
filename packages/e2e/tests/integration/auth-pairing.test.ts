import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  createTestClient,
  createUnauthClient,
  createTestProviderConfig,
  type TestClient,
} from "../../helpers/index.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";
import type { ServerInstance } from "../../../server/src/server.js";

describe("Pairing code flow", () => {
  let tmp: TmpDir;
  let server: ServerInstance;
  let url: string;
  const TOKEN = "master-token-for-pairing-test";

  beforeAll(async () => {
    tmp = createTmpDir("molf-pairing-test-");
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

  test("create pairing code and redeem it", async () => {
    // Admin creates a pairing code
    const admin = createTestClient(url, TOKEN, "admin");
    let code: string;
    try {
      const result = await admin.trpc.auth.createPairingCode.mutate({ name: "office-laptop" });
      code = result.code;
      expect(code).toMatch(/^\d{6}$/);
    } finally {
      admin.cleanup();
    }

    // Unauthenticated client redeems the code
    const unauth = createUnauthClient(url, "new-device");
    let apiKey: string;
    try {
      const result = await unauth.trpc.auth.redeemPairingCode.mutate({ code });
      apiKey = result.apiKey;
      expect(apiKey.startsWith("yk_")).toBe(true);
      expect(result.name).toBe("office-laptop");
    } finally {
      unauth.cleanup();
    }

    // The new API key should work for authenticated requests
    const authedClient = createTestClient(url, apiKey, "paired-device");
    try {
      const sessions = await authedClient.trpc.session.list.query();
      expect(sessions.sessions).toBeDefined();
    } finally {
      authedClient.cleanup();
    }
  });

  test("redeem with wrong code fails", async () => {
    const unauth = createUnauthClient(url, "bad-device");
    try {
      await expect(
        unauth.trpc.auth.redeemPairingCode.mutate({ code: "999999" }),
      ).rejects.toThrow(/UNAUTHORIZED|invalid|expired/i);
    } finally {
      unauth.cleanup();
    }
  });

  test("code is single-use", async () => {
    const admin = createTestClient(url, TOKEN);
    const { code } = await admin.trpc.auth.createPairingCode.mutate({ name: "single-use-test" });
    admin.cleanup();

    // First redeem succeeds
    const client1 = createUnauthClient(url);
    const result = await client1.trpc.auth.redeemPairingCode.mutate({ code });
    expect(result.apiKey).toBeTruthy();
    client1.cleanup();

    // Second redeem fails
    const client2 = createUnauthClient(url);
    try {
      await expect(
        client2.trpc.auth.redeemPairingCode.mutate({ code }),
      ).rejects.toThrow(/UNAUTHORIZED|invalid|expired/i);
    } finally {
      client2.cleanup();
    }
  });

  test("unauthenticated client cannot create pairing codes", async () => {
    const unauth = createUnauthClient(url);
    try {
      await expect(
        unauth.trpc.auth.createPairingCode.mutate({ name: "hacker" }),
      ).rejects.toThrow(/UNAUTHORIZED|authentication/i);
    } finally {
      unauth.cleanup();
    }
  });
});
