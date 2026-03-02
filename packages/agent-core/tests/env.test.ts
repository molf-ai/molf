import { describe, test, expect, afterEach } from "bun:test";
import { Env } from "../src/env.js";

afterEach(() => {
  Env.reset();
});

describe("Env.get", () => {
  test("returns value of existing env var", () => {
    process.env.TEST_ENV_GET = "hello";
    Env.reset(); // force fresh snapshot
    expect(Env.get("TEST_ENV_GET")).toBe("hello");
    delete process.env.TEST_ENV_GET;
  });

  test("returns undefined for missing env var", () => {
    delete process.env.TEST_ENV_MISSING;
    Env.reset();
    expect(Env.get("TEST_ENV_MISSING")).toBeUndefined();
  });
});

describe("Env.all", () => {
  test("returns a record of all env vars", () => {
    const all = Env.all();
    expect(typeof all).toBe("object");
    expect(all.PATH).toBeDefined();
  });
});

describe("Env snapshot isolation", () => {
  test("snapshot is frozen at first access", () => {
    const val1 = Env.get("PATH");
    // Modify process.env after snapshot was taken
    const original = process.env.PATH;
    process.env.PATH = "/modified";
    // Env should still return the original value
    expect(Env.get("PATH")).toBe(val1);
    process.env.PATH = original;
  });

  test("reset clears snapshot, next access picks up new env", () => {
    Env.get("PATH"); // initialize snapshot
    process.env.TEST_ENV_RESET = "new-value";
    Env.reset();
    expect(Env.get("TEST_ENV_RESET")).toBe("new-value");
    delete process.env.TEST_ENV_RESET;
  });
});

describe("Env.set", () => {
  test("sets a value in the snapshot", () => {
    Env.set("TEST_ENV_SET", "hello");
    expect(Env.get("TEST_ENV_SET")).toBe("hello");
  });

  test("does not modify process.env", () => {
    Env.set("TEST_ENV_SET_NO_PROC", "snapshot-only");
    expect(process.env.TEST_ENV_SET_NO_PROC).toBeUndefined();
  });

  test("overwrites existing snapshot value", () => {
    Env.set("TEST_ENV_OVERWRITE", "first");
    Env.set("TEST_ENV_OVERWRITE", "second");
    expect(Env.get("TEST_ENV_OVERWRITE")).toBe("second");
  });
});

describe("Env.delete_", () => {
  test("removes a key from the snapshot", () => {
    Env.set("TEST_ENV_DEL", "to-delete");
    Env.delete_("TEST_ENV_DEL");
    expect(Env.get("TEST_ENV_DEL")).toBeUndefined();
  });

  test("is a no-op for nonexistent key", () => {
    Env.delete_("TEST_ENV_NONEXISTENT_XYZ");
    expect(Env.get("TEST_ENV_NONEXISTENT_XYZ")).toBeUndefined();
  });
});
