import { describe, test, expect } from "bun:test";
import { isBinaryResult } from "../src/types.js";

describe("isBinaryResult", () => {
  test("returns true for valid BinaryResult", () => {
    expect(
      isBinaryResult({
        type: "binary",
        data: "base64data==",
        mimeType: "image/png",
        path: "/tmp/file.png",
        size: 1234,
      }),
    ).toBe(true);
  });

  test("returns true with minimal required fields", () => {
    // Only type, data, mimeType are checked by the function
    expect(
      isBinaryResult({
        type: "binary",
        data: "",
        mimeType: "text/plain",
      }),
    ).toBe(true);
  });

  test("returns false for null", () => {
    expect(isBinaryResult(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isBinaryResult(undefined)).toBe(false);
  });

  test("returns false for string", () => {
    expect(isBinaryResult("binary")).toBe(false);
  });

  test("returns false for number", () => {
    expect(isBinaryResult(42)).toBe(false);
  });

  test("returns false for empty object", () => {
    expect(isBinaryResult({})).toBe(false);
  });

  test("returns false for wrong type field", () => {
    expect(
      isBinaryResult({
        type: "text",
        data: "abc",
        mimeType: "text/plain",
      }),
    ).toBe(false);
  });

  test("returns false when data is not a string", () => {
    expect(
      isBinaryResult({
        type: "binary",
        data: 12345,
        mimeType: "image/png",
      }),
    ).toBe(false);
  });

  test("returns false when mimeType is not a string", () => {
    expect(
      isBinaryResult({
        type: "binary",
        data: "abc",
        mimeType: null,
      }),
    ).toBe(false);
  });

  test("returns false when type is missing", () => {
    expect(
      isBinaryResult({
        data: "abc",
        mimeType: "image/png",
      }),
    ).toBe(false);
  });

  test("returns false for array", () => {
    expect(isBinaryResult(["binary", "data", "mimeType"])).toBe(false);
  });

  test("returns false for plain JSON tool result", () => {
    expect(
      isBinaryResult({
        stdout: "Hello world",
        exitCode: 0,
      }),
    ).toBe(false);
  });
});
