import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager, SessionCorruptError } from "../src/session-mgr.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

function makeMgr(dir: string) {
  return new SessionManager(dir);
}

describe("SessionManager", () => {
  test("create returns SessionFile with UUID", () => {
    const mgr = makeMgr(`${tmp.path}/sm1`);
    const session = mgr.create({ workerId: "w1" });
    expect(session.sessionId).toBeTruthy();
    expect(session.messages).toHaveLength(0);
  });

  test("create persists to disk", () => {
    const dir = `${tmp.path}/sm2`;
    const mgr = makeMgr(dir);
    const session = mgr.create({ workerId: "w1" });
    const filePath = resolve(dir, "sessions", `${session.sessionId}.json`);
    expect(Bun.file(filePath).size).toBeGreaterThan(0);
  });

  test("list returns created sessions", () => {
    const mgr = makeMgr(`${tmp.path}/sm3`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });
    const { sessions, total } = mgr.list();
    expect(sessions.length).toBe(2);
    expect(total).toBe(2);
  });

  test("list on empty dir", () => {
    const mgr = makeMgr(`${tmp.path}/sm4`);
    const { sessions, total } = mgr.list();
    expect(sessions).toHaveLength(0);
    expect(total).toBe(0);
  });

  test("load from memory cache", () => {
    const mgr = makeMgr(`${tmp.path}/sm5`);
    const session = mgr.create({ workerId: "w1" });
    const loaded = mgr.load(session.sessionId);
    expect(loaded).toBe(session);
  });

  test("load from disk (new instance)", () => {
    const dir = `${tmp.path}/sm6`;
    const mgr1 = makeMgr(dir);
    const session = mgr1.create({ workerId: "w1", name: "Test Session" });

    const mgr2 = makeMgr(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Test Session");
  });

  test("load nonexistent session", () => {
    const mgr = makeMgr(`${tmp.path}/sm7`);
    expect(mgr.load("nonexistent")).toBeNull();
  });

  test("delete removes from memory and disk", () => {
    const mgr = makeMgr(`${tmp.path}/sm8`);
    const session = mgr.create({ workerId: "w1" });
    expect(mgr.delete(session.sessionId)).toBe(true);
    expect(mgr.load(session.sessionId)).toBeNull();
  });

  test("delete nonexistent session", () => {
    const mgr = makeMgr(`${tmp.path}/sm9`);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  test("rename updates name", () => {
    const mgr = makeMgr(`${tmp.path}/sm10`);
    const session = mgr.create({ workerId: "w1" });
    expect(mgr.rename(session.sessionId, "New Name")).toBe(true);
    const loaded = mgr.load(session.sessionId);
    expect(loaded!.name).toBe("New Name");
  });

  test("rename nonexistent session", () => {
    const mgr = makeMgr(`${tmp.path}/sm11`);
    expect(mgr.rename("nonexistent", "name")).toBe(false);
  });

  test("addMessage appends to session", () => {
    const mgr = makeMgr(`${tmp.path}/sm12`);
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
    const mgr = makeMgr(`${tmp.path}/sm13`);
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
    const mgr = makeMgr(dir);
    const session = mgr.create({ workerId: "w1" });
    const before = session.lastActiveAt;
    // Small delay to ensure timestamp differs
    const delay = 10;
    Bun.sleepSync(delay);
    mgr.save(session.sessionId);
    expect(session.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  test("getMessages returns messages", () => {
    const mgr = makeMgr(`${tmp.path}/sm15`);
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
    const mgr = makeMgr(`${tmp.path}/sm17`);
    const session = mgr.create({ workerId: "w1" });
    const active = mgr.getActive(session.sessionId);
    expect(active).toBe(session);
    expect(mgr.getActive("unknown-id")).toBeUndefined();
  });

  test("corrupt JSON file skipped in list", () => {
    const dir = `${tmp.path}/sm16`;
    const mgr = makeMgr(dir);
    mgr.create({ workerId: "w1" });
    // Write a corrupt file
    writeFileSync(resolve(dir, "sessions", "corrupt.json"), "not json");
    const { sessions } = mgr.list();
    expect(sessions.length).toBe(1);
  });

  test("release saves to disk and removes from memory", () => {
    const dir = `${tmp.path}/sm18`;
    const mgr = makeMgr(dir);
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
    const mgr2 = makeMgr(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Release Me");
    expect(loaded!.messages).toHaveLength(1);
  });

  test("release on unknown session is a no-op", () => {
    const mgr = makeMgr(`${tmp.path}/sm19`);
    // Should not throw
    mgr.release("nonexistent");
  });

  test("release preserves data for re-load", () => {
    const dir = `${tmp.path}/sm20`;
    const mgr = makeMgr(dir);
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
    const mgr = makeMgr(`${tmp.path}/sm21`);
    const s1 = mgr.create({ workerId: "w1" });
    const s2 = mgr.create({ workerId: "w2" });

    // Without callback — both active (in memory)
    const { sessions: listDefault } = mgr.list();
    expect(listDefault.every((s) => s.active)).toBe(true);

    // With callback — only s1 is active
    const { sessions: listWithCb } = mgr.list((id) => id === s1.sessionId);
    const item1 = listWithCb.find((s) => s.sessionId === s1.sessionId);
    const item2 = listWithCb.find((s) => s.sessionId === s2.sessionId);
    expect(item1!.active).toBe(true);
    expect(item2!.active).toBe(false);
  });

  test("list after release shows inactive (default behavior)", () => {
    const mgr = makeMgr(`${tmp.path}/sm22`);
    const session = mgr.create({ workerId: "w1" });

    // Before release — active
    expect(mgr.list().sessions[0].active).toBe(true);

    mgr.release(session.sessionId);

    // After release — inactive (using default activeSessions.has)
    expect(mgr.list().sessions[0].active).toBe(false);
  });

  test("list with workerId filter returns only matching sessions", () => {
    const mgr = makeMgr(`${tmp.path}/sm23`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });
    mgr.create({ workerId: "w3" });

    const { sessions: all, total: allTotal } = mgr.list();
    expect(all.length).toBe(4);
    expect(allTotal).toBe(4);

    const { sessions: w1Sessions } = mgr.list(undefined, { workerId: "w1" });
    expect(w1Sessions.length).toBe(2);
    expect(w1Sessions.every((s) => s.workerId === "w1")).toBe(true);

    const { sessions: w2Sessions } = mgr.list(undefined, { workerId: "w2" });
    expect(w2Sessions.length).toBe(1);
    expect(w2Sessions[0].workerId).toBe("w2");

    const { sessions: w3Sessions } = mgr.list(undefined, { workerId: "w3" });
    expect(w3Sessions.length).toBe(1);
    expect(w3Sessions[0].workerId).toBe("w3");
  });

  test("list with workerId filter returns empty for unknown worker", () => {
    const mgr = makeMgr(`${tmp.path}/sm24`);
    mgr.create({ workerId: "w1" });
    const { sessions: filtered } = mgr.list(undefined, { workerId: "unknown" });
    expect(filtered).toHaveLength(0);
  });

  test("create stores metadata and persists it to disk", () => {
    const dir = `${tmp.path}/sm26`;
    const mgr = makeMgr(dir);
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
    const mgr = makeMgr(`${tmp.path}/sm27`);
    mgr.create({ workerId: "w1", metadata: { client: "telegram", chatId: 100 } });
    mgr.create({ workerId: "w2" }); // no metadata
    const { sessions: list } = mgr.list();
    const withMeta = list.find((s) => s.metadata?.client === "telegram");
    const withoutMeta = list.find((s) => !s.metadata);
    expect(withMeta).toBeTruthy();
    expect(withMeta!.metadata).toEqual({ client: "telegram", chatId: 100 });
    expect(withoutMeta).toBeTruthy();
  });

  test("metadata survives load from fresh instance", () => {
    const dir = `${tmp.path}/sm28`;
    const mgr1 = makeMgr(dir);
    const session = mgr1.create({
      workerId: "w1",
      metadata: { client: "telegram", chatId: 42 },
    });

    const mgr2 = makeMgr(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata).toEqual({ client: "telegram", chatId: 42 });

    // Also verify via list
    const { sessions: list } = mgr2.list();
    expect(list[0].metadata).toEqual({ client: "telegram", chatId: 42 });
  });

  test("list with workerId filter and isActive callback", () => {
    const mgr = makeMgr(`${tmp.path}/sm25`);
    const s1 = mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });

    const { sessions: filtered } = mgr.list((id) => id === s1.sessionId, { workerId: "w1" });
    expect(filtered.length).toBe(2);
    const active = filtered.find((s) => s.sessionId === s1.sessionId);
    expect(active!.active).toBe(true);
    // Second w1 session should be inactive
    const inactive = filtered.find((s) => s.sessionId !== s1.sessionId);
    expect(inactive!.active).toBe(false);
  });

  test("list with metadata filter returns only matching sessions", () => {
    const mgr = makeMgr(`${tmp.path}/sm29`);
    mgr.create({ workerId: "w1", metadata: { client: "telegram", chatId: 100 } });
    mgr.create({ workerId: "w1", metadata: { client: "telegram", chatId: 200 } });
    mgr.create({ workerId: "w1", metadata: { client: "tui" } });
    mgr.create({ workerId: "w1" }); // no metadata

    const { sessions: telegramSessions } = mgr.list(undefined, { metadata: { client: "telegram" } });
    expect(telegramSessions.length).toBe(2);
    expect(telegramSessions.every((s) => s.metadata?.client === "telegram")).toBe(true);

    const { sessions: tuiSessions } = mgr.list(undefined, { metadata: { client: "tui" } });
    expect(tuiSessions.length).toBe(1);
    expect(tuiSessions[0].metadata?.client).toBe("tui");
  });

  test("list with workerId + metadata combined filter", () => {
    const mgr = makeMgr(`${tmp.path}/sm30`);
    mgr.create({ workerId: "w1", metadata: { client: "telegram" } });
    mgr.create({ workerId: "w2", metadata: { client: "telegram" } });
    mgr.create({ workerId: "w1", metadata: { client: "tui" } });

    const { sessions: filtered } = mgr.list(undefined, { workerId: "w1", metadata: { client: "telegram" } });
    expect(filtered.length).toBe(1);
    expect(filtered[0].workerId).toBe("w1");
    expect(filtered[0].metadata?.client).toBe("telegram");
  });

  test("list with name filter", () => {
    const mgr = makeMgr(`${tmp.path}/sm31`);
    mgr.create({ workerId: "w1", name: "Alpha" });
    mgr.create({ workerId: "w1", name: "Beta" });
    mgr.create({ workerId: "w1", name: "Alpha" });

    const { sessions: filtered } = mgr.list(undefined, { name: "Alpha" });
    expect(filtered.length).toBe(2);
    expect(filtered.every((s) => s.name === "Alpha")).toBe(true);
  });

  test("list with active filter", () => {
    const mgr = makeMgr(`${tmp.path}/sm32`);
    const s1 = mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });

    // s1 is active, s2 is inactive via callback
    const { sessions: activeSessions } = mgr.list((id) => id === s1.sessionId, { active: true });
    expect(activeSessions.length).toBe(1);
    expect(activeSessions[0].sessionId).toBe(s1.sessionId);

    const { sessions: inactiveSessions } = mgr.list((id) => id === s1.sessionId, { active: false });
    expect(inactiveSessions.length).toBe(1);
    expect(inactiveSessions[0].sessionId).not.toBe(s1.sessionId);
  });

  test("list with limit returns correct subset", () => {
    const mgr = makeMgr(`${tmp.path}/sm33`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });

    const { sessions, total } = mgr.list(undefined, undefined, { limit: 2 });
    expect(sessions.length).toBe(2);
    expect(total).toBe(3);
  });

  test("list with offset skips items", () => {
    const mgr = makeMgr(`${tmp.path}/sm34`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });

    const { sessions: all } = mgr.list();
    const { sessions, total } = mgr.list(undefined, undefined, { offset: 1 });
    expect(total).toBe(3);
    expect(sessions.length).toBe(2);
    expect(sessions[0].sessionId).toBe(all[1].sessionId);
  });

  test("list with limit and offset together", () => {
    const mgr = makeMgr(`${tmp.path}/sm35`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });

    const { sessions: all } = mgr.list();
    const { sessions, total } = mgr.list(undefined, undefined, { limit: 2, offset: 1 });
    expect(total).toBe(4);
    expect(sessions.length).toBe(2);
    expect(sessions[0].sessionId).toBe(all[1].sessionId);
    expect(sessions[1].sessionId).toBe(all[2].sessionId);
  });

  test("list with limit + filter applies pagination after filter", () => {
    const mgr = makeMgr(`${tmp.path}/sm36`);
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w1" });
    mgr.create({ workerId: "w2" });
    mgr.create({ workerId: "w1" });

    const { sessions, total } = mgr.list(undefined, { workerId: "w1" }, { limit: 1 });
    expect(sessions.length).toBe(1);
    expect(total).toBe(3);
    expect(sessions[0].workerId).toBe("w1");
  });
});

describe("SessionCorruptError", () => {
  test("load throws SessionCorruptError for corrupt JSON file", () => {
    const dir = `${tmp.path}/sm_corrupt1`;
    const mgr = makeMgr(dir);
    // Write a corrupt JSON file directly
    writeFileSync(resolve(dir, "sessions", "bad-session.json"), "not valid json");
    expect(() => mgr.load("bad-session")).toThrow(SessionCorruptError);
  });

  test("SessionCorruptError contains sessionId and cause", () => {
    const dir = `${tmp.path}/sm_corrupt2`;
    const mgr = makeMgr(dir);
    writeFileSync(resolve(dir, "sessions", "corrupt-id.json"), "{invalid");
    try {
      mgr.load("corrupt-id");
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(SessionCorruptError);
      const corruptErr = err as SessionCorruptError;
      expect(corruptErr.sessionId).toBe("corrupt-id");
      expect(corruptErr.message).toBe("Session corrupt-id is corrupt");
      expect(corruptErr.name).toBe("SessionCorruptError");
      expect(corruptErr.cause).toBeDefined();
      expect(corruptErr.cause).toBeInstanceOf(SyntaxError); // JSON.parse error
    }
  });

  test("load returns null for missing session (not SessionCorruptError)", () => {
    const mgr = makeMgr(`${tmp.path}/sm_corrupt3`);
    const result = mgr.load("does-not-exist");
    expect(result).toBeNull();
  });

  test("load still works for valid session files after corrupt test", () => {
    const dir = `${tmp.path}/sm_corrupt4`;
    const mgr = makeMgr(dir);
    // Create a valid session
    const session = mgr.create({ workerId: "w1", name: "Valid Session" });
    // Release it so it's only on disk
    mgr.release(session.sessionId);

    // Load from disk — should work fine
    const loaded = mgr.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Valid Session");
  });

  test("corrupt file does not affect list() (silently skipped)", () => {
    const dir = `${tmp.path}/sm_corrupt5`;
    const mgr = makeMgr(dir);
    mgr.create({ workerId: "w1" });
    // Add a corrupt file
    writeFileSync(resolve(dir, "sessions", "broken.json"), "{{{{");
    const { sessions, total } = mgr.list();
    // Only the valid session appears
    expect(sessions.length).toBe(1);
    expect(total).toBe(1);
  });

  test("SessionCorruptError is an instance of Error", () => {
    const err = new SessionCorruptError("test-id", new SyntaxError("bad json"));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SessionCorruptError);
  });
});
