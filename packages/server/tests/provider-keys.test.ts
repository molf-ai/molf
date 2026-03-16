import { describe, it, expect } from "vitest";
import { statSync, existsSync } from "fs";
import { join } from "path";
import { createTmpDir } from "@molf-ai/test-utils";
import { ProviderKeyStore } from "../src/provider-keys.js";

describe("ProviderKeyStore", () => {
  it("returns empty object when file does not exist", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    expect(store.getAll()).toEqual({});
  });

  it("returns undefined for missing provider key", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("sets and gets a key", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    store.set("openai", "sk-abc123");
    expect(store.get("openai")).toBe("sk-abc123");
  });

  it("getAll returns all stored keys", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    store.set("openai", "sk-abc");
    store.set("anthropic", "sk-xyz");
    expect(store.getAll()).toEqual({
      openai: "sk-abc",
      anthropic: "sk-xyz",
    });
  });

  it("overwrites an existing key", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    store.set("openai", "old-key");
    store.set("openai", "new-key");
    expect(store.get("openai")).toBe("new-key");
  });

  it("removes an existing key and returns true", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    store.set("openai", "sk-abc");
    expect(store.remove("openai")).toBe(true);
    expect(store.get("openai")).toBeUndefined();
  });

  it("returns false when removing a nonexistent key", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("writes file with 0o600 permissions", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    store.set("openai", "sk-abc");
    const filePath = join(tmp.path, "provider-keys.json");
    const stat = statSync(filePath);
    // 0o600 = owner read/write only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("file exists after write (atomic)", () => {
    const tmp = createTmpDir();
    const store = new ProviderKeyStore(tmp.path);
    store.set("openai", "sk-abc");
    const filePath = join(tmp.path, "provider-keys.json");
    expect(existsSync(filePath)).toBe(true);
  });

  it("persists data across store instances", () => {
    const tmp = createTmpDir();
    const store1 = new ProviderKeyStore(tmp.path);
    store1.set("openai", "sk-abc");

    const store2 = new ProviderKeyStore(tmp.path);
    expect(store2.get("openai")).toBe("sk-abc");
  });
});
