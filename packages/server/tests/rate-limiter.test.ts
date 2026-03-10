import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RateLimiter } from "../src/rate-limiter.js";

let limiter: RateLimiter;

beforeEach(() => {
  limiter = new RateLimiter({
    perIpLimit: 3,
    perIpWindowMs: 1000,
    globalLimit: 10,
    globalWindowMs: 1000,
    lockoutMs: 2000,
    pruneIntervalMs: 0, // disable auto-prune in tests
  });
});

afterEach(() => { limiter.close(); });

describe("RateLimiter", () => {
  test("allows requests under the limit", () => {
    for (let i = 0; i < 3; i++) {
      const result = limiter.check("1.2.3.4");
      expect(result.allowed).toBe(true);
      limiter.record("1.2.3.4");
    }
  });

  test("blocks after per-IP limit exceeded", () => {
    for (let i = 0; i < 3; i++) {
      limiter.check("1.2.3.4");
      limiter.record("1.2.3.4");
    }

    const result = limiter.check("1.2.3.4");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("per_ip");
  });

  test("lockout prevents further requests", () => {
    // Exhaust limit
    for (let i = 0; i < 3; i++) {
      limiter.check("1.2.3.4");
      limiter.record("1.2.3.4");
    }
    limiter.check("1.2.3.4"); // triggers lockout

    // Subsequent checks should be locked
    const result = limiter.check("1.2.3.4");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("locked");
  });

  test("different IPs have independent limits", () => {
    for (let i = 0; i < 3; i++) {
      limiter.check("1.1.1.1");
      limiter.record("1.1.1.1");
    }

    // 1.1.1.1 is now limited
    expect(limiter.check("1.1.1.1").allowed).toBe(false);

    // 2.2.2.2 should be fine
    expect(limiter.check("2.2.2.2").allowed).toBe(true);
  });

  test("loopback IPs are exempt from per-IP limit", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const freshLimiter = new RateLimiter({
        perIpLimit: 1,
        perIpWindowMs: 1000,
        globalLimit: 100,
        globalWindowMs: 1000,
        lockoutMs: 2000,
        pruneIntervalMs: 0,
      });

      // Should allow more than perIpLimit for loopback
      freshLimiter.check(ip);
      freshLimiter.record(ip);
      freshLimiter.check(ip);
      freshLimiter.record(ip);

      expect(freshLimiter.check(ip).allowed).toBe(true);
      freshLimiter.close();
    }
  });

  test("global limit applies across all IPs", () => {
    const globalLimiter = new RateLimiter({
      perIpLimit: 100, // high per-IP limit
      perIpWindowMs: 1000,
      globalLimit: 5,
      globalWindowMs: 1000,
      lockoutMs: 2000,
      pruneIntervalMs: 0,
    });

    for (let i = 0; i < 5; i++) {
      globalLimiter.check(`10.0.0.${i}`);
      globalLimiter.record(`10.0.0.${i}`);
    }

    const result = globalLimiter.check("10.0.0.99");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("global");
    globalLimiter.close();
  });

  test("close stops prune interval without error", () => {
    const withPrune = new RateLimiter({ pruneIntervalMs: 100 });
    withPrune.close();
    // Should not throw
  });
});
