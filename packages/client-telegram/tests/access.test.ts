import { describe, it, expect, vi } from "vitest";
import { parseAllowlist, isUserAllowed, createAccessMiddleware } from "../src/access.js";

describe("parseAllowlist", () => {
  it("parses numeric IDs", () => {
    const result = parseAllowlist(["123456789", "987654321"]);
    expect(result.ids.has(123456789)).toBe(true);
    expect(result.ids.has(987654321)).toBe(true);
    expect(result.usernames.size).toBe(0);
  });

  it("parses @usernames", () => {
    const result = parseAllowlist(["@alice", "@Bob"]);
    expect(result.usernames.has("alice")).toBe(true);
    expect(result.usernames.has("bob")).toBe(true);
    expect(result.ids.size).toBe(0);
  });

  it("parses mixed IDs and usernames", () => {
    const result = parseAllowlist(["123", "@alice", "456", "@bob"]);
    expect(result.ids.has(123)).toBe(true);
    expect(result.ids.has(456)).toBe(true);
    expect(result.usernames.has("alice")).toBe(true);
    expect(result.usernames.has("bob")).toBe(true);
  });

  it("ignores empty entries", () => {
    const result = parseAllowlist(["", "  ", "123"]);
    expect(result.ids.size).toBe(1);
    expect(result.ids.has(123)).toBe(true);
  });

  it("handles empty array", () => {
    const result = parseAllowlist([]);
    expect(result.ids.size).toBe(0);
    expect(result.usernames.size).toBe(0);
  });

  it("treats non-numeric strings without @ as usernames", () => {
    const result = parseAllowlist(["alice"]);
    expect(result.usernames.has("alice")).toBe(true);
  });
});

describe("isUserAllowed", () => {
  it("allows by user ID", () => {
    const allowlist = parseAllowlist(["123"]);
    expect(isUserAllowed(123, undefined, allowlist)).toBe(true);
  });

  it("allows by username", () => {
    const allowlist = parseAllowlist(["@alice"]);
    expect(isUserAllowed(999, "alice", allowlist)).toBe(true);
  });

  it("allows by username case-insensitively", () => {
    const allowlist = parseAllowlist(["@Alice"]);
    expect(isUserAllowed(999, "ALICE", allowlist)).toBe(true);
  });

  it("rejects non-allowed users", () => {
    const allowlist = parseAllowlist(["123", "@alice"]);
    expect(isUserAllowed(999, "bob", allowlist)).toBe(false);
  });

  it("denies everyone when allowlist is empty", () => {
    const allowlist = parseAllowlist([]);
    expect(isUserAllowed(999, "anyone", allowlist)).toBe(false);
  });

  it("rejects when user has no username and ID not in list", () => {
    const allowlist = parseAllowlist(["@alice"]);
    expect(isUserAllowed(999, undefined, allowlist)).toBe(false);
  });
});

describe("createAccessMiddleware", () => {
  it("calls next() for allowed users", async () => {
    const middleware = createAccessMiddleware({ allowedUsers: ["123"] });
    const next = vi.fn(() => Promise.resolve());
    const ctx = { from: { id: 123, username: "alice" } } as any;

    await middleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not call next() for rejected users", async () => {
    const middleware = createAccessMiddleware({ allowedUsers: ["123"] });
    const next = vi.fn(() => Promise.resolve());
    const ctx = { from: { id: 999, username: "bob" } } as any;

    await middleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next() when no user info", async () => {
    const middleware = createAccessMiddleware({ allowedUsers: ["123"] });
    const next = vi.fn(() => Promise.resolve());
    const ctx = { from: undefined } as any;

    await middleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies everyone when allowlist is empty", async () => {
    const middleware = createAccessMiddleware({ allowedUsers: [] });
    const next = vi.fn(() => Promise.resolve());
    const ctx = { from: { id: 999, username: "anyone" } } as any;

    await middleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows by @username in config", async () => {
    const middleware = createAccessMiddleware({ allowedUsers: ["@alice"] });
    const next = vi.fn(() => Promise.resolve());
    const ctx = { from: { id: 999, username: "alice" } } as any;

    await middleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
