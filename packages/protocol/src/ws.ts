import WebSocket from "ws";
import type { ClientOptions } from "ws";
import * as tls from "tls";
import { computeFingerprintFromDer, derToPem } from "./cert-trust.js";

export function createAuthWebSocket(
  token: string,
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">,
) {
  return class AuthWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, {
        headers: { Authorization: `Bearer ${token}` },
        ...tlsOpts,
      });
    }
  } as unknown as typeof globalThis.WebSocket;
}

/**
 * Create an unauthenticated WebSocket subclass that applies TLS opts
 * but sends no auth header and captures no certs.
 * Used by pairing flows after trust is established.
 */
export function createUnauthWebSocket(
  tlsOpts?: Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">,
) {
  return class UnauthWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { ...tlsOpts });
    }
  } as unknown as typeof globalThis.WebSocket;
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe a WSS server's TLS certificate using a raw TLS connection.
 * Only performs a TLS handshake — no WebSocket upgrade or HTTP traffic.
 */
export function probeServerCert(
  serverUrl: string,
): Promise<{ fingerprint: string; certPem: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const host = url.hostname;
    const port = parseInt(url.port || "443", 10);

    const socket = tls.connect({ host, port, rejectUnauthorized: false });

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`));
    }, PROBE_TIMEOUT_MS);

    socket.on("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (cert?.raw) {
        clearTimeout(timeout);
        const fingerprint = computeFingerprintFromDer(cert.raw);
        const certPem = derToPem(cert.raw);
        socket.destroy();
        resolve({ fingerprint, certPem });
      } else {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error("Could not obtain server TLS certificate"));
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
