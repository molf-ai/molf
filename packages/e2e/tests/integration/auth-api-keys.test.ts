import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  createTestClient,
  createUnauthClient,
  createTestProviderConfig,
} from "../../helpers/index.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";
import type { ServerInstance } from "../../../server/src/server.js";

describe("API key management", () => {
  let tmp: TmpDir;
  let server: ServerInstance;
  let url: string;
  const TOKEN = "master-token-for-keys-test";

  beforeAll(async () => {
    tmp = createTmpDir("molf-keys-test-");
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: tmp.path,
      model: "gemini/test",
      providerConfig: createTestProviderConfig(tmp.path),
      tls: false,
      token: TOKEN,
    });
    url = `ws://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.close();
    tmp.cleanup();
  });

  test("list keys is empty initially", async () => {
    const admin = createTestClient(url, TOKEN);
    try {
      const keys = await admin.trpc.auth.listApiKeys.query();
      expect(keys).toEqual([]);
    } finally {
      admin.cleanup();
    }
  });

  test("list keys shows paired devices", async () => {
    // Pair a device
    const admin = createTestClient(url, TOKEN);
    const { code } = await admin.trpc.auth.createPairingCode.mutate({ name: "test-laptop" });
    admin.cleanup();

    const unauth = createUnauthClient(url);
    await unauth.trpc.auth.redeemPairingCode.mutate({ code });
    unauth.cleanup();

    // Check key list
    const admin2 = createTestClient(url, TOKEN);
    try {
      const keys = await admin2.trpc.auth.listApiKeys.query();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const laptop = keys.find((k) => k.name === "test-laptop");
      expect(laptop).toBeTruthy();
      expect(laptop!.revokedAt).toBeNull();
      // Hashes should not be exposed
      expect((laptop as any).hash).toBeUndefined();
    } finally {
      admin2.cleanup();
    }
  });

  test("revoke key prevents future auth", async () => {
    // Pair a device
    const admin = createTestClient(url, TOKEN);
    const { code } = await admin.trpc.auth.createPairingCode.mutate({ name: "revoke-target" });
    admin.cleanup();

    const unauth = createUnauthClient(url);
    const { apiKey } = await unauth.trpc.auth.redeemPairingCode.mutate({ code });
    unauth.cleanup();

    // Verify key works before revocation
    const authed = createTestClient(url, apiKey);
    const sessions = await authed.trpc.session.list.query();
    expect(sessions.sessions).toBeDefined();
    authed.cleanup();

    // Revoke
    const admin2 = createTestClient(url, TOKEN);
    const keys = await admin2.trpc.auth.listApiKeys.query();
    const target = keys.find((k) => k.name === "revoke-target");
    expect(target).toBeTruthy();

    const { revoked } = await admin2.trpc.auth.revokeApiKey.mutate({ id: target!.id });
    expect(revoked).toBe(true);
    admin2.cleanup();

    // Verify key no longer works (new connection)
    const rejected = createTestClient(url, apiKey, "revoked-device");
    try {
      await expect(
        rejected.trpc.session.list.query(),
      ).rejects.toThrow(/UNAUTHORIZED|authentication/i);
    } finally {
      rejected.cleanup();
    }
  });
});
