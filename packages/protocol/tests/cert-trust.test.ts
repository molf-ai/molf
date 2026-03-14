import { describe, test, expect } from "vitest";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveTlsTrust,
  tlsTrustToWsOpts,
  computeFingerprintFromDer,
  computeFingerprintFromPem,
  derToPem,
  checkPinnedCertExpiry,
} from "../src/cert-trust.js";
import type { TlsTrust } from "../src/cert-trust.js";

// A real-ish self-signed cert PEM for testing (generated from fixed DER data)
const FAKE_DER = Buffer.from("test-certificate-data");
const FAKE_PEM = derToPem(FAKE_DER);
const FAKE_FINGERPRINT = computeFingerprintFromDer(FAKE_DER);

describe("resolveTlsTrust", () => {
  test("returns null for ws:// URLs", () => {
    const result = resolveTlsTrust({ serverUrl: "ws://localhost:7600" });
    expect(result).toBeNull();
  });

  test("returns ca mode when tlsCaPath is provided", () => {
    const { writeFileSync, mkdirSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = join(tmpdir(), `cert-trust-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----");

    const result = resolveTlsTrust({
      serverUrl: "wss://localhost:7600",
      tlsCaPath: caPath,
    });
    expect(result).toEqual({
      mode: "ca",
      ca: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
    });

    const { rmSync } = require("fs");
    rmSync(dir, { recursive: true });
  });

  test("savedCertPem resolves to pinned mode with fingerprint", () => {
    const result = resolveTlsTrust({
      serverUrl: "wss://localhost:7600",
      savedCertPem: FAKE_PEM,
    });
    expect(result).toEqual({
      mode: "pinned",
      certPem: FAKE_PEM,
      fingerprint: FAKE_FINGERPRINT,
    });
  });

  test("no savedCertPem falls back to tofu", () => {
    const result = resolveTlsTrust({
      serverUrl: "wss://localhost:7600",
    });
    expect(result).toEqual({ mode: "tofu" });
  });

  test("tlsCaPath takes priority over savedCertPem", () => {
    const { writeFileSync, mkdirSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = join(tmpdir(), `cert-trust-priority-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const caPath = join(dir, "ca.pem");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nca-cert\n-----END CERTIFICATE-----");

    const result = resolveTlsTrust({
      serverUrl: "wss://localhost:7600",
      tlsCaPath: caPath,
      savedCertPem: FAKE_PEM,
    });
    expect(result!.mode).toBe("ca");

    const { rmSync } = require("fs");
    rmSync(dir, { recursive: true });
  });
});

describe("tlsTrustToWsOpts", () => {
  test("ca mode sets ca and rejectUnauthorized true", () => {
    const trust: TlsTrust = { mode: "ca", ca: "cert-content" };
    expect(tlsTrustToWsOpts(trust)).toEqual({
      ca: "cert-content",
      rejectUnauthorized: true,
    });
  });

  test("pinned mode sets ca, rejectUnauthorized true, and checkServerIdentity", () => {
    const trust: TlsTrust = { mode: "pinned", certPem: FAKE_PEM, fingerprint: FAKE_FINGERPRINT };
    const opts = tlsTrustToWsOpts(trust);
    expect(opts.ca).toBe(FAKE_PEM);
    expect(opts.rejectUnauthorized).toBe(true);
    expect(typeof opts.checkServerIdentity).toBe("function");
    // checkServerIdentity should return undefined (Node.js success convention)
    expect(opts.checkServerIdentity!("", {} as any)).toBeUndefined();
  });

  test("tofu mode sets rejectUnauthorized false", () => {
    const trust: TlsTrust = { mode: "tofu" };
    expect(tlsTrustToWsOpts(trust)).toEqual({ rejectUnauthorized: false });
  });
});

describe("computeFingerprintFromDer", () => {
  test("produces colon-separated uppercase hex from DER buffer", () => {
    const fakeDer = Buffer.from("test-certificate-data");
    const fingerprint = computeFingerprintFromDer(fakeDer);

    // SHA-256 = 32 bytes = 64 hex chars = 32 pairs with 31 colons
    expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    // Verify it matches manual computation
    const expected = createHash("sha256")
      .update(fakeDer)
      .digest("hex")
      .match(/.{2}/g)!
      .join(":")
      .toUpperCase();
    expect(fingerprint).toBe(expected);
  });

  test("same input produces same fingerprint", () => {
    const data = Buffer.from("consistent");
    expect(computeFingerprintFromDer(data)).toBe(computeFingerprintFromDer(data));
  });

  test("different input produces different fingerprint", () => {
    const a = computeFingerprintFromDer(Buffer.from("aaa"));
    const b = computeFingerprintFromDer(Buffer.from("bbb"));
    expect(a).not.toBe(b);
  });
});

describe("derToPem", () => {
  test("round-trips DER → PEM → fingerprint", () => {
    const der = Buffer.from("some-certificate-der-bytes-here");
    const pem = derToPem(der);

    expect(pem).toContain("-----BEGIN CERTIFICATE-----");
    expect(pem).toContain("-----END CERTIFICATE-----");

    // Fingerprint from PEM should match fingerprint from original DER
    const fpFromDer = computeFingerprintFromDer(der);
    const fpFromPem = computeFingerprintFromPem(pem);
    expect(fpFromPem).toBe(fpFromDer);
  });

  test("PEM lines are at most 64 characters", () => {
    const der = Buffer.alloc(200, 0x42); // large enough to need wrapping
    const pem = derToPem(der);
    const lines = pem.split("\n");
    for (const line of lines) {
      if (line.startsWith("-----")) continue;
      expect(line.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("checkPinnedCertExpiry", () => {
  function generateTestCert(days: number): string {
    const tmpCert = join(tmpdir(), `test-cert-${crypto.randomUUID()}.pem`);
    try {
      execFileSync("openssl", [
        "req", "-x509",
        "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-keyout", "/dev/null",
        "-out", tmpCert,
        "-days", String(days),
        "-nodes",
        "-subj", "/CN=test",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      return readFileSync(tmpCert, "utf-8");
    } finally {
      try { unlinkSync(tmpCert); } catch {}
    }
  }

  test("returns positive daysRemaining for valid cert", () => {
    const certPem = generateTestCert(365);
    const result = checkPinnedCertExpiry(certPem);
    expect(result.expired).toBe(false);
    expect(result.daysRemaining).toBeGreaterThan(300);
  });

  test("returns correct structure with expired/daysRemaining fields", () => {
    const certPem = generateTestCert(10);
    const result = checkPinnedCertExpiry(certPem);
    expect(result).toHaveProperty("expired");
    expect(result).toHaveProperty("daysRemaining");
    expect(typeof result.expired).toBe("boolean");
    expect(typeof result.daysRemaining).toBe("number");
    // A 10-day cert should not be expired and have ~9-10 days remaining
    expect(result.expired).toBe(false);
    expect(result.daysRemaining).toBeLessThanOrEqual(10);
    expect(result.daysRemaining).toBeGreaterThanOrEqual(8);
  });
});
