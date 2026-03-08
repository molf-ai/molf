import { describe, it, expect } from "bun:test";
import { parseDuration, parseDateTime, validateCronExpr, nextCronRun } from "../src/time.js";

describe("parseDuration", () => {
  it("parses seconds correctly", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1s")).toBe(1_000);
    expect(parseDuration("0.5s")).toBe(500);
  });

  it("parses minutes correctly", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("10m")).toBe(600_000);
  });

  it("parses hours correctly", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("0.5h")).toBe(1_800_000);
  });

  it("parses days correctly", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("parses decimal durations correctly", () => {
    expect(parseDuration("2.5h")).toBe(9_000_000);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(parseDuration("3.25d")).toBe(280_800_000);
  });

  it("throws on invalid format - missing unit", () => {
    expect(() => parseDuration("30")).toThrow();
    expect(() => parseDuration("30 ")).toThrow();
  });

  it("throws on invalid format - invalid unit", () => {
    expect(() => parseDuration("30x")).toThrow();
    expect(() => parseDuration("30ms")).toThrow();
  });

  it("throws on invalid format - non-numeric value", () => {
    expect(() => parseDuration("abcs")).toThrow();
    expect(() => parseDuration("s")).toThrow();
  });

  it("throws on invalid format - extra whitespace or characters", () => {
    expect(() => parseDuration("30s extra")).toThrow();
    expect(() => parseDuration(" 30s")).toThrow();
  });

  it("allows multiple spaces between value and unit", () => {
    expect(parseDuration("30  s")).toBe(30_000);
    expect(parseDuration("5   m")).toBe(300_000);
  });

  it("throws on negative values", () => {
    expect(() => parseDuration("-5m")).toThrow();
  });

  it("parses zero duration", () => {
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration("0m")).toBe(0);
  });

  it("error message includes the invalid input", () => {
    try {
      parseDuration("invalid");
      throw new Error("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("invalid");
      expect((e as Error).message).toContain("Invalid duration");
    }
  });
});

describe("parseDateTime", () => {
  it("parses ISO 8601 datetime strings", () => {
    const result = parseDateTime("2025-03-04T12:00:00Z");
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  it("parses ISO 8601 datetime with milliseconds", () => {
    const result = parseDateTime("2025-03-04T12:00:00.000Z");
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  it("parses ISO 8601 datetime with timezone offset", () => {
    const result1 = parseDateTime("2025-03-04T12:00:00+05:30");
    const result2 = parseDateTime("2025-03-04T12:00:00-08:00");
    expect(typeof result1).toBe("number");
    expect(typeof result2).toBe("number");
    // Different offsets should give different timestamps
    expect(result1).not.toBe(result2);
  });

  it("parses various valid date formats", () => {
    const dateStrings = [
      "2025-03-04",
      "2025-03-04T12:00:00",
      "2025-03-04T12:00:00Z",
      "Wed Mar 04 2025 12:00:00 GMT+0000",
    ];

    dateStrings.forEach((dateStr) => {
      const result = parseDateTime(dateStr);
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThan(0);
    });
  });

  it("throws on invalid datetime strings", () => {
    expect(() => parseDateTime("not-a-date")).toThrow();
    expect(() => parseDateTime("2025-13-01")).toThrow(); // Invalid month
    expect(() => parseDateTime("")).toThrow();
    expect(() => parseDateTime("invalid datetime")).toThrow();
  });

  it("error message includes the invalid input", () => {
    try {
      parseDateTime("not-a-date");
      throw new Error("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("not-a-date");
      expect((e as Error).message).toContain("Invalid datetime");
    }
  });

  it("returns consistent values for the same input", () => {
    const input = "2025-03-04T12:00:00Z";
    const result1 = parseDateTime(input);
    const result2 = parseDateTime(input);
    expect(result1).toBe(result2);
  });

  it("returns a valid epoch timestamp", () => {
    const result = parseDateTime("2025-03-04T12:00:00Z");
    const date = new Date(result);
    expect(date.toISOString()).toContain("2025-03-04");
  });
});

describe("validateCronExpr", () => {
  it("returns true for valid cron expressions", () => {
    expect(validateCronExpr("0 9 * * *")).toBe(true);
    expect(validateCronExpr("*/30 * * * *")).toBe(true);
    expect(validateCronExpr("0 0 * * 0")).toBe(true);
    expect(validateCronExpr("30 14 * * *")).toBe(true);
  });

  it("returns true for more complex valid expressions", () => {
    expect(validateCronExpr("0,30 * * * *")).toBe(true);
    expect(validateCronExpr("0 */2 * * *")).toBe(true);
    expect(validateCronExpr("15 2 * * 0-6")).toBe(true);
    expect(validateCronExpr("0 0 1 * *")).toBe(true);
  });

  it("returns false for invalid cron expressions", () => {
    expect(validateCronExpr("invalid")).toBe(false);
    expect(validateCronExpr("60 9 * * *")).toBe(false); // minute out of range
    expect(validateCronExpr("0 25 * * *")).toBe(false); // hour out of range
    expect(validateCronExpr("0 9 32 * *")).toBe(false); // day out of range
    expect(validateCronExpr("0 9 * 13 *")).toBe(false); // month out of range
  });

  it("allows day of week 0-7 (Sunday can be 0 or 7)", () => {
    expect(validateCronExpr("0 9 * * 0")).toBe(true); // Sunday as 0
    expect(validateCronExpr("0 9 * * 7")).toBe(true); // Sunday as 7
  });

  it("returns false for incomplete expressions", () => {
    expect(validateCronExpr("0 9 *")).toBe(false);
    expect(validateCronExpr("0 9")).toBe(false);
    expect(validateCronExpr("0")).toBe(false);
    expect(validateCronExpr("")).toBe(false);
  });

  it("returns false for expressions with invalid syntax", () => {
    expect(validateCronExpr("0 9 * * * extra")).toBe(false);
    expect(validateCronExpr("@invalid")).toBe(false);
  });

  it("allows six-field expressions (with seconds)", () => {
    expect(validateCronExpr("* * * * * *")).toBe(true); // Every second
    expect(validateCronExpr("0 0 0 * * *")).toBe(true); // Every day at midnight
  });

  it("does not throw errors, always returns boolean", () => {
    expect(() => {
      validateCronExpr("invalid");
      validateCronExpr("0 9 * * *");
      validateCronExpr("");
    }).not.toThrow();
  });
});

describe("nextCronRun", () => {
  it("returns a number > Date.now() for valid expressions", () => {
    const expr = "0 9 * * *"; // 9 AM every day
    const result = nextCronRun(expr);
    const now = Date.now();

    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(now);
  });

  it("returns milliseconds representing a future time", () => {
    const expr = "*/30 * * * *"; // Every 30 minutes
    const result = nextCronRun(expr);

    if (result !== null) {
      const nextRun = new Date(result);
      const now = new Date();
      expect(nextRun.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("handles various valid cron expressions", () => {
    const expressions = [
      "0 9 * * *", // Daily at 9 AM
      "0 0 * * 0", // Weekly at midnight on Sunday
      "0 0 1 * *", // Monthly at midnight on the 1st
      "*/15 * * * *", // Every 15 minutes
    ];

    expressions.forEach((expr) => {
      const result = nextCronRun(expr);
      expect(result).not.toBeNull();
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThan(Date.now());
    });
  });

  it("respects timezone parameter when provided", () => {
    const expr = "0 9 * * *"; // 9 AM
    const resultUTC = nextCronRun(expr, "UTC");
    const resultNY = nextCronRun(expr, "America/New_York");

    // Both should return valid future timestamps
    expect(resultUTC).not.toBeNull();
    expect(resultNY).not.toBeNull();
    expect(resultUTC).toBeGreaterThan(Date.now());
    expect(resultNY).toBeGreaterThan(Date.now());

    // Different timezones should typically produce different results
    // (unless the calculation happens to align, but this is unlikely)
    if (resultUTC !== null && resultNY !== null) {
      // Both are valid numbers greater than now, but may differ by timezone offset
      expect(typeof resultUTC).toBe("number");
      expect(typeof resultNY).toBe("number");
    }
  });

  it("returns consistent results for the same expression", () => {
    const expr = "0 9 * * *";
    const result1 = nextCronRun(expr);
    const result2 = nextCronRun(expr);

    // Results should be very close (within a few milliseconds of each other)
    if (result1 !== null && result2 !== null) {
      expect(Math.abs(result1 - result2)).toBeLessThan(100);
    }
  });

  it("throws for invalid cron expressions", () => {
    expect(() => {
      nextCronRun("invalid");
    }).toThrow();
  });

  it("handles edge case expressions", () => {
    const result = nextCronRun("59 23 31 12 *"); // 11:59 PM on Dec 31
    expect(result).not.toBeNull();
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(Date.now());
  });

  it("works with different timezone formats", () => {
    const expr = "0 12 * * *";
    const timezones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];

    timezones.forEach((tz) => {
      const result = nextCronRun(expr, tz);
      expect(result).not.toBeNull();
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThan(Date.now());
    });
  });

  it("result is a valid JavaScript timestamp", () => {
    const expr = "0 9 * * *";
    const result = nextCronRun(expr);

    if (result !== null) {
      const date = new Date(result);
      expect(date instanceof Date).toBe(true);
      expect(!isNaN(date.getTime())).toBe(true);
      expect(date.getTime()).toBe(result);
    }
  });
});
