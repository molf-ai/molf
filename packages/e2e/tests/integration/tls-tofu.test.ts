import { describe, test, expect, afterEach } from "vitest";
import WebSocket from "ws";
import type { TLSSocket } from "tls";
import { startTestServer, type TestServer } from "../../helpers/test-server.js";
import { computeFingerprintFromDer, derToPem, computeFingerprintFromPem } from "../../../protocol/src/cert-trust.js";

let server: TestServer;

afterEach(() => {
  server?.cleanup();
});

describe("TLS TOFU fingerprint", () => {
  test("peer fingerprint matches server fingerprint on upgrade", async () => {
    server = await startTestServer({ tls: true });

    const fingerprint = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(
        `${server.url}?token=${server.token}&name=tofu-test`,
        { rejectUnauthorized: false },
      );

      ws.on("upgrade", (res) => {
        const socket = res.socket as TLSSocket;
        const cert = socket.getPeerCertificate();
        const fp = computeFingerprintFromDer(cert.raw);
        ws.close();
        resolve(fp);
      });

      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5_000);
    });

    expect(fingerprint).toBe(server.tlsFingerprint);
  });

  test("captured cert PEM round-trips to matching fingerprint", async () => {
    server = await startTestServer({ tls: true });

    const { fingerprint, certPem } = await new Promise<{ fingerprint: string; certPem: string }>((resolve, reject) => {
      const ws = new WebSocket(
        `${server.url}?token=${server.token}&name=pem-test`,
        { rejectUnauthorized: false },
      );

      ws.on("upgrade", (res) => {
        const socket = res.socket as TLSSocket;
        const cert = socket.getPeerCertificate();
        const fp = computeFingerprintFromDer(cert.raw);
        const pem = derToPem(cert.raw);
        ws.close();
        resolve({ fingerprint: fp, certPem: pem });
      });

      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5_000);
    });

    // Fingerprint from captured PEM matches original
    expect(computeFingerprintFromPem(certPem)).toBe(fingerprint);
    expect(fingerprint).toBe(server.tlsFingerprint);

    // PEM matches what the test server provides
    expect(certPem).toContain("-----BEGIN CERTIFICATE-----");
    expect(certPem).toContain("-----END CERTIFICATE-----");
  });

  test("pinned cert PEM can be used as CA for subsequent connections", async () => {
    server = await startTestServer({ tls: true });

    // Step 1: Capture cert PEM via TOFU
    const capturedPem = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(
        `${server.url}?token=${server.token}&name=tofu-capture`,
        { rejectUnauthorized: false },
      );

      ws.on("upgrade", (res) => {
        const socket = res.socket as TLSSocket;
        const cert = socket.getPeerCertificate();
        ws.close();
        resolve(derToPem(cert.raw));
      });

      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5_000);
    });

    // Step 2: Use captured PEM as CA with rejectUnauthorized: true
    const connected = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(
        `${server.url}?token=${server.token}&name=pinned-test`,
        {
          ca: capturedPem,
          rejectUnauthorized: true,
          checkServerIdentity: () => undefined,
        },
      );

      ws.on("open", () => {
        ws.close();
        resolve(true);
      });

      ws.on("error", (err) => {
        resolve(false);
      });

      setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 5_000);
    });

    expect(connected).toBe(true);
  });

  test("same server produces consistent fingerprint across connections", async () => {
    server = await startTestServer({ tls: true });

    async function getFingerprint(): Promise<string> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${server.url}?token=${server.token}&name=consistent-test`,
          { rejectUnauthorized: false },
        );

        ws.on("upgrade", (res) => {
          const socket = res.socket as TLSSocket;
          const cert = socket.getPeerCertificate();
          const fp = computeFingerprintFromDer(cert.raw);
          ws.close();
          resolve(fp);
        });

        ws.on("error", reject);
        setTimeout(() => reject(new Error("timeout")), 5_000);
      });
    }

    const fp1 = await getFingerprint();
    const fp2 = await getFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(server.tlsFingerprint);
  });
});
