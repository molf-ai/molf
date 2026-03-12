import { createHash, X509Certificate } from "crypto";
import { readFileSync } from "fs";
import type { ClientOptions } from "ws";

export type TlsTrust =
  | { mode: "ca"; ca: string }
  | { mode: "pinned"; certPem: string; fingerprint: string }
  | { mode: "tofu" };

/**
 * Resolve TLS trust for a server URL.
 *
 * Priority:
 * 1. Explicit CA file (--tls-ca flag)
 * 2. Saved cert PEM from known_certs/ (pinned via TOFU)
 * 3. No prior trust -> TOFU
 *
 * Returns null for ws:// URLs (no TLS needed).
 */
export function resolveTlsTrust(opts: {
  serverUrl: string;
  tlsCaPath?: string;
  savedCertPem?: string;
}): TlsTrust | null {
  const url = new URL(opts.serverUrl);
  if (url.protocol === "ws:") return null;

  if (opts.tlsCaPath) {
    return { mode: "ca", ca: readFileSync(opts.tlsCaPath, "utf-8") };
  }

  if (opts.savedCertPem) {
    const fingerprint = computeFingerprintFromPem(opts.savedCertPem);
    return { mode: "pinned", certPem: opts.savedCertPem, fingerprint };
  }

  return { mode: "tofu" };
}

export function tlsTrustToWsOpts(trust: TlsTrust): Pick<ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity"> {
  switch (trust.mode) {
    case "ca":     return { ca: trust.ca, rejectUnauthorized: true };
    case "pinned": return {
      ca: trust.certPem,
      rejectUnauthorized: true,
      // Skip hostname check — we trust the cert identity directly.
      // Node.js expects undefined for success; @types/ws incorrectly types this as boolean.
      checkServerIdentity: (() => undefined) as unknown as () => boolean,
    };
    case "tofu":   return { rejectUnauthorized: false };
  }
}

export function computeFingerprintFromDer(raw: Buffer): string {
  const hash = createHash("sha256").update(raw).digest("hex");
  return hash.match(/.{2}/g)!.join(":").toUpperCase();
}

export function computeFingerprintFromPem(pem: string): string {
  const der = pemToDer(pem);
  return computeFingerprintFromDer(der);
}

/** Convert a DER-encoded certificate buffer to PEM format. */
export function derToPem(raw: Buffer): string {
  const b64 = raw.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Check whether a pinned certificate PEM has expired.
 * Returns `{ expired, daysRemaining }` so callers can warn the user.
 */
export function checkPinnedCertExpiry(certPem: string): { expired: boolean; daysRemaining: number } {
  const x509 = new X509Certificate(certPem);
  const expiryMs = new Date(x509.validTo).getTime() - Date.now();
  const daysRemaining = Math.floor(expiryMs / (1000 * 60 * 60 * 24));
  return { expired: daysRemaining < 0, daysRemaining };
}

/** Convert a PEM-encoded certificate to DER buffer. */
function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  return Buffer.from(b64, "base64");
}
