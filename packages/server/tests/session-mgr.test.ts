import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager } from "../src/session-mgr.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

describe("SessionManager", () => {
  test("create returns SessionFile with UUID", () => {
    const mgr = new SessionManager(`${tmp.path}/sm1`);
    const session = mgr.create({ workerId: "w1" });
    expect(session.sessionId).toBeTruthy();
    expect(session.messages).toHaveLength(0);
  });

  test("create persists to disk", () => {
    const dir = `${tmp.path}/sm2`;
    const mgr = new SessionManager(dir);
    const session = mgr.create({ workerId: "w1" });
    const filePath = resolve(dir, "sessions", `${session.sessionId}.json`);
    expect(Bun.file(filePath).size).toBeGreaterThan(0);
  });

  test("list returns created sessions", () => {
    const mgr = new SessionManager(`${tmp.path}/sm3`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });
    const list = mgr.list();
    expect(list.length).toBe(2);
  });

  test("list on empty dir", () => {
    const mgr = new SessionManager(`${tmp.path}/sm4`);
    expect(mgr.list()).toHaveLength(0);
  });

  test("load from memory cache", () => {
    const mgr = new SessionManager(`${tmp.path}/sm5`);
    const session = mgr.create({ workerId: "w1" });
    const loaded = mgr.load(session.sessionId);
    expect(loaded).toBe(session);
  });

  test("load from disk (new instance)", () => {
    const dir = `${tmp.path}/sm6`;
    const mgr1 = new SessionManager(dir);
    const session = mgr1.create({ workerId: "w1", name: "Test Session" });

    const mgr2 = new SessionManager(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Test Session");
  });

  test("load nonexistent session", () => {
    const mgr = new SessionManager(`${tmp.path}/sm7`);
    expect(mgr.load("nonexistent")).toBeNull();
  });

  test("delete removes from memory and disk", () => {
    const mgr = new SessionManager(`${tmp.path}/sm8`);
    const session = mgr.create({ workerId: "w1" });
    expect(mgr.delete(session.sessionId)).toBe(true);
    expect(mgr.load(session.sessionId)).toBeNull();
  });

  test("delete nonexistent session", () => {
    const mgr = new SessionManager(`${tmp.path}/sm9`);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  test("rename updates name", () => {
    const mgr = new SessionManager(`${tmp.path}/sm10`);
    const session = mgr.create({ workerId: "w1" });
    expect(mgr.rename(session.sessionId, "New Name")).toBe(true);
    const loaded = mgr.load(session.sessionId);
    expect(loaded!.name).toBe("New Name");
  });

  test("rename nonexistent session", () => {
    const mgr = new SessionManager(`${tmp.path}/sm11`);
    expect(mgr.rename("nonexistent", "name")).toBe(false);
  });

  test("addMessage appends to session", () => {
    const mgr = new SessionManager(`${tmp.path}/sm12`);
    const session = mgr.create({ workerId: "w1" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    expect(session.messages).toHaveLength(1);
  });

  test("addMessage on unloaded session throws", () => {
    const mgr = new SessionManager(`${tmp.path}/sm13`);
    expect(() =>
      mgr.addMessage("unknown", {
        id: "msg1",
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      }),
    ).toThrow("not loaded");
  });

  test("save updates lastActiveAt", () => {
    const dir = `${tmp.path}/sm14`;
    const mgr = new SessionManager(dir);
    const session = mgr.create({ workerId: "w1" });
    const before = session.lastActiveAt;
    // Small delay to ensure timestamp differs
    const delay = 10;
    Bun.sleepSync(delay);
    mgr.save(session.sessionId);
    expect(session.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  test("getMessages returns messages", () => {
    const mgr = new SessionManager(`${tmp.path}/sm15`);
    const session = mgr.create({ workerId: "w1" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "hi",
      timestamp: Date.now(),
    });
    expect(mgr.getMessages(session.sessionId)).toHaveLength(1);
  });

  test("getActive returns session from memory", () => {
    const mgr = new SessionManager(`${tmp.path}/sm17`);
    const session = mgr.create({ workerId: "w1" });
    const active = mgr.getActive(session.sessionId);
    expect(active).toBe(session);
    expect(mgr.getActive("unknown-id")).toBeUndefined();
  });

  test("corrupt JSON file skipped in list", () => {
    const dir = `${tmp.path}/sm16`;
    const mgr = new SessionManager(dir);
    mgr.create({ workerId: "w1" });
    // Write a corrupt file
    writeFileSync(resolve(dir, "sessions", "corrupt.json"), "not json");
    const list = mgr.list();
    expect(list.length).toBe(1);
  });

  test("release saves to disk and removes from memory", () => {
    const dir = `${tmp.path}/sm18`;
    const mgr = new SessionManager(dir);
    const session = mgr.create({ workerId: "w1", name: "Release Me" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    // Should be in memory
    expect(mgr.getActive(session.sessionId)).toBe(session);

    mgr.release(session.sessionId);

    // Removed from memory
    expect(mgr.getActive(session.sessionId)).toBeUndefined();

    // Still on disk — loading from a fresh instance proves it
    const mgr2 = new SessionManager(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Release Me");
    expect(loaded!.messages).toHaveLength(1);
  });

  test("release on unknown session is a no-op", () => {
    const mgr = new SessionManager(`${tmp.path}/sm19`);
    // Should not throw
    mgr.release("nonexistent");
  });

  test("release preserves data for re-load", () => {
    const dir = `${tmp.path}/sm20`;
    const mgr = new SessionManager(dir);
    const session = mgr.create({ workerId: "w1", name: "Persist" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "data",
      timestamp: Date.now(),
    });

    mgr.release(session.sessionId);

    // Re-load into same instance
    const reloaded = mgr.load(session.sessionId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.name).toBe("Persist");
    expect(reloaded!.messages).toHaveLength(1);
    expect(reloaded!.messages[0].content).toBe("data");
  });

  test("list(isActive) uses callback when provided", () => {
    const mgr = new SessionManager(`${tmp.path}/sm21`);
    const s1 = mgr.create({ workerId: "w1" });
    const s2 = mgr.create({ workerId: "w2" });

    // Without callback — both active (in memory)
    const listDefault = mgr.list();
    expect(listDefault.every((s) => s.active)).toBe(true);

    // With callback — only s1 is active
    const listWithCb = mgr.list((id) => id === s1.sessionId);
    const item1 = listWithCb.find((s) => s.sessionId === s1.sessionId);
    const item2 = listWithCb.find((s) => s.sessionId === s2.sessionId);
    expect(item1!.active).toBe(true);
    expect(item2!.active).toBe(false);
  });

  test("list after release shows inactive (default behavior)", () => {
    const mgr = new SessionManager(`${tmp.path}/sm22`);
    const session = mgr.create({ workerId: "w1" });

    // Before release — active
    expect(mgr.list()[0].active).toBe(true);

    mgr.release(session.sessionId);

    // After release — inactive (using default activeSessions.has)
    expect(mgr.list()[0].active).toBe(false);
  });

  test("list with workerId filter returns only matching sessions", () => {
    const mgr = new SessionManager(`${tmp.path}/sm23`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });
    mgr.create({ workerId: "w3" });

    const all = mgr.list();
    expect(all.length).toBe(4);

    const w1Sessions = mgr.list(undefined, "w1");
    expect(w1Sessions.length).toBe(2);
    expect(w1Sessions.every((s) => s.workerId === "w1")).toBe(true);

    const w2Sessions = mgr.list(undefined, "w2");
    expect(w2Sessions.length).toBe(1);
    expect(w2Sessions[0].workerId).toBe("w2");

    const w3Sessions = mgr.list(undefined, "w3");
    expect(w3Sessions.length).toBe(1);
    expect(w3Sessions[0].workerId).toBe("w3");
  });

  test("list with workerId filter returns empty for unknown worker", () => {
    const mgr = new SessionManager(`${tmp.path}/sm24`);
    mgr.create({ workerId: "w1" });
    const filtered = mgr.list(undefined, "unknown");
    expect(filtered).toHaveLength(0);
  });

  test("create stores metadata and persists it to disk", () => {
    const dir = `${tmp.path}/sm26`;
    const mgr = new SessionManager(dir);
    const session = mgr.create({
      workerId: "w1",
      metadata: { client: "telegram", chatId: 12345 },
    });
    expect(session.metadata).toEqual({ client: "telegram", chatId: 12345 });

    // Verify persisted to disk
    const filePath = resolve(dir, "sessions", `${session.sessionId}.json`);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.metadata).toEqual({ client: "telegram", chatId: 12345 });
  });

  test("list includes metadata in returned items", () => {
    const mgr = new SessionManager(`${tmp.path}/sm27`);
    mgr.create({ workerId: "w1", metadata: { client: "telegram", chatId: 100 } });
    mgr.create({ workerId: "w2" }); // no metadata
    const list = mgr.list();
    const withMeta = list.find((s) => s.metadata?.client === "telegram");
    const withoutMeta = list.find((s) => !s.metadata);
    expect(withMeta).toBeTruthy();
    expect(withMeta!.metadata).toEqual({ client: "telegram", chatId: 100 });
    expect(withoutMeta).toBeTruthy();
  });

  test("metadata survives load from fresh instance", () => {
    const dir = `${tmp.path}/sm28`;
    const mgr1 = new SessionManager(dir);
    const session = mgr1.create({
      workerId: "w1",
      metadata: { client: "telegram", chatId: 42 },
    });

    const mgr2 = new SessionManager(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata).toEqual({ client: "telegram", chatId: 42 });

    // Also verify via list
    const list = mgr2.list();
    expect(list[0].metadata).toEqual({ client: "telegram", chatId: 42 });
  });

  test("list with workerId filter and isActive callback", () => {
    const mgr = new SessionManager(`${tmp.path}/sm25`);
    const s1 = mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });

    const filtered = mgr.list((id) => id === s1.sessionId, "w1");
    expect(filtered.length).toBe(2);
    const active = filtered.find((s) => s.sessionId === s1.sessionId);
    expect(active!.active).toBe(true);
    // Second w1 session should be inactive
    const inactive = filtered.find((s) => s.sessionId !== s1.sessionId);
    expect(inactive!.active).toBe(false);
  });
});
