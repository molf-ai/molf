import { describe, test, expect } from "bun:test";
import { isParseError, isMessageNotModified } from "../src/telegram-errors.js";

describe("isParseError", () => {
  test("returns true for parse entities error", () => {
    expect(isParseError(new Error("can't parse entities"))).toBe(true);
  });

  test("returns true when message contains the phrase", () => {
    expect(isParseError(new Error("Bad Request: can't parse entities: something"))).toBe(true);
  });

  test("returns false for unrelated error", () => {
    expect(isParseError(new Error("network timeout"))).toBe(false);
  });

  test("returns false for non-Error", () => {
    expect(isParseError("can't parse entities")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isParseError(null)).toBe(false);
  });
});

describe("isMessageNotModified", () => {
  test("returns true for message not modified error", () => {
    expect(isMessageNotModified(new Error("message is not modified"))).toBe(true);
  });

  test("returns true when message contains the phrase", () => {
    expect(isMessageNotModified(new Error("Bad Request: message is not modified: same text"))).toBe(true);
  });

  test("returns false for unrelated error", () => {
    expect(isMessageNotModified(new Error("network timeout"))).toBe(false);
  });

  test("returns false for non-Error", () => {
    expect(isMessageNotModified("message is not modified")).toBe(false);
  });

  test("returns false for null", () => {
    expect(isMessageNotModified(null)).toBe(false);
  });
});
