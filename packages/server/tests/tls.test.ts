import { describe, test, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { createTmpDir, createEnvGuard, type TmpDir, type EnvGuard } from "@molf-ai/test-utils";
import { generateSelfSignedCert, computeFingerprint, checkCertExpiry, validateSan } from "../src/tls.js";
import { resolveServerConfig, parseServerArgs } from "../src/config.js";

let tmp: TmpDir;
let env: EnvGuard;
beforeAll(() => { tmp = createTmpDir("tls-test-"); });
afterAll(() => { tmp.cleanup(); });
beforeEach(() => { env = createEnvGuard(); });
afterEach(() => { env.restore(); });

function subDir(name: string): string {
  const dir = join(tmp.path, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("generateSelfSignedCert", () => {
  test("creates cert.pem and key.pem", () => {
    const dataDir = subDir("gen-cert");
    const { certPath, keyPath } = generateSelfSignedCert(dataDir);

    const cert = readFileSync(certPath, "utf-8");
    const key = readFileSync(keyPath, "utf-8");

    expect(cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(key).toContain("-----BEGIN");
    expect(certPath).toBe(join(dataDir, "tls", "cert.pem"));
    expect(keyPath).toBe(join(dataDir, "tls", "key.pem"));
  });

  test("exits when cert exists but key is missing", () => {
    const dataDir = subDir("cert-no-key");
    const tlsDir = join(dataDir, "tls");
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(join(tlsDir, "cert.pem"), "fake cert");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => generateSelfSignedCert(dataDir)).toThrow("process.exit");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Incomplete TLS files"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cert.pem but not key.pem"));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("exits when key exists but cert is missing", () => {
    const dataDir = subDir("key-no-cert");
    const tlsDir = join(dataDir, "tls");
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(join(tlsDir, "key.pem"), "fake key");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => generateSelfSignedCert(dataDir)).toThrow("process.exit");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Incomplete TLS files"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("key.pem but not cert.pem"));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("key.pem has 0600 permissions", () => {
    const dataDir = subDir("key-perms");
    const { keyPath } = generateSelfSignedCert(dataDir);

    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("returns existing cert when both files present", () => {
    const dataDir = subDir("existing-cert");
    const first = generateSelfSignedCert(dataDir);
    const certContent = readFileSync(first.certPath, "utf-8");

    const second = generateSelfSignedCert(dataDir);
    expect(second.certPath).toBe(first.certPath);
    expect(readFileSync(second.certPath, "utf-8")).toBe(certContent);
  });
});

describe("computeFingerprint", () => {
  test("returns colon-separated uppercase hex", () => {
    const dataDir = subDir("fingerprint");
    const { certPath } = generateSelfSignedCert(dataDir);
    const certPem = readFileSync(certPath, "utf-8");

    const fingerprint = computeFingerprint(certPem);
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  test("same cert produces same fingerprint", () => {
    const dataDir = subDir("fingerprint-stable");
    const { certPath } = generateSelfSignedCert(dataDir);
    const certPem = readFileSync(certPath, "utf-8");

    expect(computeFingerprint(certPem)).toBe(computeFingerprint(certPem));
  });
});

describe("checkCertExpiry", () => {
  test("returns positive days for fresh cert", () => {
    const dataDir = subDir("expiry");
    const { certPath } = generateSelfSignedCert(dataDir);
    const certPem = readFileSync(certPath, "utf-8");

    const days = checkCertExpiry(certPem);
    expect(days).toBeGreaterThan(300);
    expect(days).toBeLessThanOrEqual(366);
  });
});

describe("TLS config validation", () => {
  test("--tls-cert without --tls-key errors", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
    expect(() =>
      resolveServerConfig({
        config: `${tmp.path}/nonexistent.yaml`,
        "tls-cert": "/tmp/cert.pem",
      } as ReturnType<typeof parseServerArgs>),
    ).toThrow("--tls-cert and --tls-key must both be provided");
  });

  test("--tls-key without --tls-cert errors", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
    expect(() =>
      resolveServerConfig({
        config: `${tmp.path}/nonexistent.yaml`,
        "tls-key": "/tmp/key.pem",
      } as ReturnType<typeof parseServerArgs>),
    ).toThrow("--tls-cert and --tls-key must both be provided");
  });

  test("--no-tls with --tls-cert errors", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
    expect(() =>
      resolveServerConfig({
        config: `${tmp.path}/nonexistent.yaml`,
        "no-tls": true,
        "tls-cert": "/tmp/cert.pem",
        "tls-key": "/tmp/key.pem",
      } as ReturnType<typeof parseServerArgs>),
    ).toThrow("--no-tls cannot be combined with --tls-cert/--tls-key");
  });

  test("tls defaults to true", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
    const config = resolveServerConfig({
      config: `${tmp.path}/nonexistent.yaml`,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.tls).toBe(true);
  });

  test("--no-tls sets tls to false", () => {
    env.set("MOLF_DEFAULT_MODEL", "gemini/test");
    const config = resolveServerConfig({
      config: `${tmp.path}/nonexistent.yaml`,
      "no-tls": true,
    } as ReturnType<typeof parseServerArgs>);
    expect(config.tls).toBe(false);
  });
});

describe("validateSan", () => {
  test("accepts valid IP and DNS entries", () => {
    expect(() => validateSan("IP:127.0.0.1,DNS:localhost")).not.toThrow();
    expect(() => validateSan("IP:192.168.1.1")).not.toThrow();
    expect(() => validateSan("DNS:example.com")).not.toThrow();
    expect(() => validateSan("IP:127.0.0.1,DNS:localhost,DNS:my-host.local")).not.toThrow();
  });

  test("accepts IPv6 addresses", () => {
    expect(() => validateSan("IP:::1")).not.toThrow();
    expect(() => validateSan("IP:fe80::1")).not.toThrow();
  });

  test("rejects malformed entries", () => {
    expect(() => validateSan("INVALID")).toThrow("Invalid MOLF_TLS_SAN entry");
    expect(() => validateSan("IP:127.0.0.1,BOGUS:foo")).toThrow("Invalid MOLF_TLS_SAN entry");
    expect(() => validateSan("email:test@example.com")).toThrow("Invalid MOLF_TLS_SAN entry");
    expect(() => validateSan("IP:127.0.0.1; rm -rf /")).toThrow("Invalid MOLF_TLS_SAN entry");
  });
});
