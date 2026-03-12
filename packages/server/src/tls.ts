import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { X509Certificate } from "crypto";
import which from "which";
import { computeFingerprintFromDer } from "@molf-ai/protocol";

/**
 * Resolve TLS certificate paths.
 * If user-provided paths exist, returns them.
 * Otherwise generates a self-signed certificate.
 */
export function resolveTlsCertPaths(config: {
  dataDir: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}): { certPath: string; keyPath: string } {
  if (config.tlsCertPath && config.tlsKeyPath) {
    return { certPath: config.tlsCertPath, keyPath: config.tlsKeyPath };
  }
  return generateSelfSignedCert(config.dataDir);
}

export function generateSelfSignedCert(dataDir: string): { certPath: string; keyPath: string } {
  const tlsDir = join(dataDir, "tls");
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");

  const certExists = existsSync(certPath);
  const keyExists = existsSync(keyPath);

  if (certExists && keyExists) {
    return { certPath, keyPath };
  }

  // One exists without the other -- corrupt/incomplete state
  if (certExists !== keyExists) {
    console.error(`Error: Incomplete TLS files in ${tlsDir}.`);
    console.error("Found " + (certExists ? "cert.pem but not key.pem" : "key.pem but not cert.pem") + ".");
    console.error("");
    console.error("To fix this, either:");
    console.error(`  1. Delete ${tlsDir} and restart (will regenerate both)`);
    console.error("  2. Provide your own certificate: --tls-cert cert.pem --tls-key key.pem");
    process.exit(1);
  }

  // Pre-check: is openssl available?
  const opensslPath = which.sync("openssl", { nothrow: true });
  if (!opensslPath) {
    console.error("Error: TLS is enabled but 'openssl' is not installed.");
    console.error("");
    console.error("To fix this, either:");
    console.error("  1. Install OpenSSL (e.g. apt install openssl, brew install openssl)");
    console.error("  2. Provide your own certificate: --tls-cert cert.pem --tls-key key.pem");
    console.error("  3. Disable TLS (not recommended): --no-tls");
    process.exit(1);
  }

  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });

  const san = process.env.MOLF_TLS_SAN ?? "IP:127.0.0.1,DNS:localhost";
  validateSan(san);

  try {
    execFileSync(opensslPath, [
      "req", "-x509",
      "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "365",
      "-nodes",
      "-subj", "/CN=molf-server",
      "-addext", `subjectAltName=${san}`,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    chmodSync(keyPath, 0o600);
  } catch (err: unknown) {
    const stderr = err instanceof Error && "stderr" in err
      ? (err as { stderr: Buffer }).stderr?.toString() ?? ""
      : String(err);
    console.error(`Error: Failed to generate TLS certificate: ${stderr}`);
    console.error("");
    console.error("You can provide your own certificate instead:");
    console.error("  --tls-cert cert.pem --tls-key key.pem");
    process.exit(1);
  }

  return { certPath, keyPath };
}

const SAN_ENTRY_RE = /^(IP:\d{1,3}(\.\d{1,3}){3}|IP:[0-9a-fA-F:]+|DNS:[a-zA-Z0-9._-]+)$/;

export function validateSan(san: string): void {
  const entries = san.split(",").map(s => s.trim());
  for (const entry of entries) {
    if (!SAN_ENTRY_RE.test(entry)) {
      throw new Error(
        `Invalid MOLF_TLS_SAN entry: "${entry}". ` +
        "Each entry must be IP:<address> or DNS:<hostname>, comma-separated.",
      );
    }
  }
}

export function computeFingerprint(certPem: string): string {
  const x509 = new X509Certificate(certPem);
  return computeFingerprintFromDer(x509.raw);
}

export function checkCertExpiry(certPem: string): number {
  const x509 = new X509Certificate(certPem);
  const expiryMs = new Date(x509.validTo).getTime() - Date.now();
  return Math.floor(expiryMs / (1000 * 60 * 60 * 24));
}
