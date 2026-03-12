import { describe, test, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startTestServer, type TestServer } from "../../helpers/test-server.js";
import { createTestClient } from "../../helpers/test-client.js";
import { connectTestWorker, type TestWorker } from "../../helpers/test-worker.js";

let server: TestServer;
let server2: TestServer | undefined;
let worker: TestWorker | undefined;

afterEach(() => {
  worker?.cleanup();
  worker = undefined;
  server2?.cleanup();
  server2 = undefined;
  server?.cleanup();
});

describe("TLS connection", () => {
  test("WSS server + worker + client round-trip", async () => {
    server = await startTestServer({ tls: true });
    expect(server.url).toMatch(/^wss:\/\//);
    expect(server.tlsFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    // Connect worker with CA trust (using the server's self-signed cert)
    const tlsOpts = { ca: server.certPem!, rejectUnauthorized: true };
    worker = await connectTestWorker(
      server.url,
      server.token,
      "tls-worker",
      { echo: { description: "echo tool" } },
      [],
      { tlsOpts },
    );

    // Connect client and verify it can list sessions
    const client = createTestClient(server.url, server.token, "tls-client", tlsOpts);
    try {
      const result = await client.trpc.session.list.query();
      expect(result.sessions).toBeDefined();
    } finally {
      client.cleanup();
    }
  }, 30_000);

  test("WSS server rejects plaintext ws:// connection attempt", async () => {
    server = await startTestServer({ tls: true });

    // Try to connect with ws:// to a wss:// server — should fail
    const wsUrl = server.url.replace("wss://", "ws://");
    const ws = new WebSocket(`${wsUrl}?token=${server.token}&name=test`);

    const failed = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(false));
      ws.addEventListener("error", () => resolve(true));
      setTimeout(() => resolve(true), 3_000);
    });

    expect(failed).toBe(true);
    ws.close();
  });

  test("--no-tls server works with plain ws://", async () => {
    server = await startTestServer({ tls: false });
    expect(server.url).toMatch(/^ws:\/\//);
    expect(server.tlsFingerprint).toBeUndefined();

    const client = createTestClient(server.url, server.token);
    try {
      const result = await client.trpc.session.list.query();
      expect(result.sessions).toBeDefined();
    } finally {
      client.cleanup();
    }
  });

  test("pinned mode with cert PEM validates at TLS layer", async () => {
    server = await startTestServer({ tls: true });

    // Pinned mode: use server's cert as CA, skip hostname check
    const tlsOpts = {
      ca: server.certPem!,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    };
    const client = createTestClient(server.url, server.token, "pinned-client", tlsOpts);
    try {
      const result = await client.trpc.session.list.query();
      expect(result.sessions).toBeDefined();
    } finally {
      client.cleanup();
    }
  });

  test("pinned mode rejects MITM before leaking auth token", async () => {
    // Start two TLS servers with different certs
    server = await startTestServer({ tls: true });
    server2 = await startTestServer({ tls: true });

    // Attempt to connect to server2 (the "MITM") using server1's cert as pinned CA
    // This should fail at the TLS handshake level — before any HTTP data is sent
    const tlsOpts = {
      ca: server.certPem!,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    };

    const connectAttempt = new Promise<string>((resolve) => {
      const ws = new WebSocket(server2!.url, {
        headers: { Authorization: `Bearer ${server.token}` },
        ...tlsOpts,
      });

      ws.on("open", () => {
        ws.close();
        resolve("connected"); // Bad — MITM succeeded
      });

      ws.on("error", (err) => {
        resolve(err.message);
      });

      setTimeout(() => {
        ws.terminate();
        resolve("timeout");
      }, 5_000);
    });

    const result = await connectAttempt;
    // Should get a TLS error, not a successful connection
    expect(result).not.toBe("connected");
    expect(result).not.toBe("timeout");
    // The error should be a TLS verification failure
    expect(result).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed/i);
  }, 15_000);

  test("TLS server returns fingerprint in ServerInstance", async () => {
    server = await startTestServer({ tls: true });
    expect(server.instance.tlsFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(server.instance.tlsFingerprint).toBe(server.tlsFingerprint);
  });
});
