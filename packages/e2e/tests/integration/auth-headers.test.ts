import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  createTestClient,
  createTestProviderConfig,
  connectTestWorker,
} from "../../helpers/index.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { startServer } from "../../../server/src/server.js";
import type { ServerInstance } from "../../../server/src/server.js";

describe("Authorization header auth", () => {
  let tmp: TmpDir;
  let server: ServerInstance;
  let url: string;
  const TOKEN = "header-auth-test-token";

  beforeAll(async () => {
    tmp = createTmpDir("molf-header-auth-test-");
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

  test("client connects via Authorization header", async () => {
    // createTestClient now uses Authorization header internally
    const client = createTestClient(url, TOKEN);
    try {
      const result = await client.client.session.list({});
      expect(result.sessions).toBeDefined();
    } finally {
      client.cleanup();
    }
  });

  test("worker connects via Authorization header", async () => {
    // connectTestWorker uses worker connection which now uses Authorization header
    const worker = await connectTestWorker(url, TOKEN, "header-worker");
    try {
      // If we get here, registration succeeded (requires auth)
      expect(worker.workerId).toBeTruthy();
    } finally {
      worker.cleanup();
    }
  });

  test("wrong token via header is rejected", async () => {
    const client = createTestClient(url, "wrong-token");
    try {
      await expect(
        client.client.session.list({}),
      ).rejects.toThrow(/UNAUTHORIZED|authentication/i);
    } finally {
      client.cleanup();
    }
  });
});
