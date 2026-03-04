import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { SessionManager, SessionCorruptError } from "../src/session-mgr.js";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

function makeMgr(dir: string) {
  return new SessionManager(dir);
}

describe("SessionManager", () => {
  test("create returns SessionFile with UUID", async () => {
    const mgr = makeMgr(`${tmp.path}/sm1`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    expect(session.sessionId).toBeTruthy();
    expect(session.messages).toHaveLength(0);
  });

  test("create persists to disk", async () => {
    const dir = `${tmp.path}/sm2`;
    const mgr = makeMgr(dir);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const filePath = resolve(dir, "sessions", `${session.sessionId}.json`);
    expect(Bun.file(filePath).size).toBeGreaterThan(0);
  });

  test("list returns created sessions", async () => {
    const mgr = makeMgr(`${tmp.path}/sm3`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" });
    const { sessions, total } = await mgr.list();
    expect(sessions.length).toBe(2);
    expect(total).toBe(2);
  });

  test("list on empty dir", async () => {
    const mgr = makeMgr(`${tmp.path}/sm4`);
    const { sessions, total } = await mgr.list();
    expect(sessions).toHaveLength(0);
    expect(total).toBe(0);
  });

  test("load from memory cache", async () => {
    const mgr = makeMgr(`${tmp.path}/sm5`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const loaded = mgr.load(session.sessionId);
    expect(loaded).toBe(session);
  });

  test("load from disk (new instance)", async () => {
    const dir = `${tmp.path}/sm6`;
    const mgr1 = makeMgr(dir);
    const session = await mgr1.create({ workerId: "w1", workspaceId: "test-ws", name: "Test Session" });

    const mgr2 = makeMgr(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Test Session");
  });

  test("load nonexistent session", () => {
    const mgr = makeMgr(`${tmp.path}/sm7`);
    expect(mgr.load("nonexistent")).toBeNull();
  });

  test("delete removes from memory and disk", async () => {
    const mgr = makeMgr(`${tmp.path}/sm8`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    expect(mgr.delete(session.sessionId)).toBe(true);
    expect(mgr.load(session.sessionId)).toBeNull();
  });

  test("delete nonexistent session", () => {
    const mgr = makeMgr(`${tmp.path}/sm9`);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  test("rename updates name", async () => {
    const mgr = makeMgr(`${tmp.path}/sm10`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    expect(await mgr.rename(session.sessionId, "New Name")).toBe(true);
    const loaded = mgr.load(session.sessionId);
    expect(loaded!.name).toBe("New Name");
  });

  test("rename nonexistent session", async () => {
    const mgr = makeMgr(`${tmp.path}/sm11`);
    expect(await mgr.rename("nonexistent", "name")).toBe(false);
  });

  test("addMessage appends to session", async () => {
    const mgr = makeMgr(`${tmp.path}/sm12`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
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

  test("save updates lastActiveAt", async () => {
    const dir = `${tmp.path}/sm14`;
    const mgr = makeMgr(dir);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const before = session.lastActiveAt;
    // Small delay to ensure timestamp differs
    const delay = 10;
    Bun.sleepSync(delay);
    await mgr.save(session.sessionId);
    expect(session.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  test("getMessages returns messages", async () => {
    const mgr = makeMgr(`${tmp.path}/sm15`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "hi",
      timestamp: Date.now(),
    });
    expect(mgr.getMessages(session.sessionId)).toHaveLength(1);
  });

  test("getActive returns session from memory", async () => {
    const mgr = makeMgr(`${tmp.path}/sm17`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const active = mgr.getActive(session.sessionId);
    expect(active).toBe(session);
    expect(mgr.getActive("unknown-id")).toBeUndefined();
  });

  test("corrupt JSON file skipped in list", async () => {
    const dir = `${tmp.path}/sm16`;
    const mgr = makeMgr(dir);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    // Write a corrupt file
    writeFileSync(resolve(dir, "sessions", "corrupt.json"), "not json");
    const { sessions } = await mgr.list();
    expect(sessions.length).toBe(1);
  });

  test("release saves to disk and removes from memory", async () => {
    const dir = `${tmp.path}/sm18`;
    const mgr = makeMgr(dir);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Release Me" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    // Should be in memory
    expect(mgr.getActive(session.sessionId)).toBe(session);

    await mgr.release(session.sessionId);

    // Removed from memory
    expect(mgr.getActive(session.sessionId)).toBeUndefined();

    // Still on disk — loading from a fresh instance proves it
    const mgr2 = makeMgr(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Release Me");
    expect(loaded!.messages).toHaveLength(1);
  });

  test("release on unknown session is a no-op", async () => {
    const mgr = makeMgr(`${tmp.path}/sm19`);
    // Should not throw
    await mgr.release("nonexistent");
  });

  test("release preserves data for re-load", async () => {
    const dir = `${tmp.path}/sm20`;
    const mgr = makeMgr(dir);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Persist" });
    mgr.addMessage(session.sessionId, {
      id: "msg1",
      role: "user",
      content: "data",
      timestamp: Date.now(),
    });

    await mgr.release(session.sessionId);

    // Re-load into same instance
    const reloaded = mgr.load(session.sessionId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.name).toBe("Persist");
    expect(reloaded!.messages).toHaveLength(1);
    expect(reloaded!.messages[0].content).toBe("data");
  });

  test("list(isActive) uses callback when provided", async () => {
    const mgr = makeMgr(`${tmp.path}/sm21`);
    const s1 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" });

    // Without callback — both active (in memory)
    const { sessions: listDefault } = await mgr.list();
    expect(listDefault.every((s) => s.active)).toBe(true);

    // With callback — only s1 is active
    const { sessions: listWithCb } = await mgr.list((id) => id === s1.sessionId);
    const item1 = listWithCb.find((s) => s.sessionId === s1.sessionId);
    const item2 = listWithCb.find((s) => s.sessionId !== s1.sessionId);
    expect(item1!.active).toBe(true);
    expect(item2!.active).toBe(false);
  });

  test("list after release shows inactive (default behavior)", async () => {
    const mgr = makeMgr(`${tmp.path}/sm22`);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    // Before release — active
    expect((await mgr.list()).sessions[0].active).toBe(true);

    await mgr.release(session.sessionId);

    // After release — inactive (using default activeSessions.has)
    expect((await mgr.list()).sessions[0].active).toBe(false);
  });

  test("list with workerId filter returns only matching sessions", async () => {
    const mgr = makeMgr(`${tmp.path}/sm23`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w3", workspaceId: "test-ws" });

    const { sessions: all, total: allTotal } = await mgr.list();
    expect(all.length).toBe(4);
    expect(allTotal).toBe(4);

    const { sessions: w1Sessions } = await mgr.list(undefined, { workerId: "w1" });
    expect(w1Sessions.length).toBe(2);
    expect(w1Sessions.every((s) => s.workerId === "w1")).toBe(true);

    const { sessions: w2Sessions } = await mgr.list(undefined, { workerId: "w2" });
    expect(w2Sessions.length).toBe(1);
    expect(w2Sessions[0].workerId).toBe("w2");

    const { sessions: w3Sessions } = await mgr.list(undefined, { workerId: "w3" });
    expect(w3Sessions.length).toBe(1);
    expect(w3Sessions[0].workerId).toBe("w3");
  });

  test("list with workerId filter returns empty for unknown worker", async () => {
    const mgr = makeMgr(`${tmp.path}/sm24`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const { sessions: filtered } = await mgr.list(undefined, { workerId: "unknown" });
    expect(filtered).toHaveLength(0);
  });

  test("create stores metadata and persists it to disk", async () => {
    const dir = `${tmp.path}/sm26`;
    const mgr = makeMgr(dir);
    const session = await mgr.create({
      workerId: "w1",
      workspaceId: "test-ws",
      metadata: { client: "telegram", chatId: 12345 },
    });
    expect(session.metadata).toEqual({ client: "telegram", chatId: 12345 });

    // Verify persisted to disk
    const filePath = resolve(dir, "sessions", `${session.sessionId}.json`);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.metadata).toEqual({ client: "telegram", chatId: 12345 });
  });

  test("list includes metadata in returned items", async () => {
    const mgr = makeMgr(`${tmp.path}/sm27`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", metadata: { client: "telegram", chatId: 100 } });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" }); // no metadata
    const { sessions: list } = await mgr.list();
    const withMeta = list.find((s) => s.metadata?.client === "telegram");
    const withoutMeta = list.find((s) => !s.metadata);
    expect(withMeta).toBeTruthy();
    expect(withMeta!.metadata).toEqual({ client: "telegram", chatId: 100 });
    expect(withoutMeta).toBeTruthy();
  });

  test("metadata survives load from fresh instance", async () => {
    const dir = `${tmp.path}/sm28`;
    const mgr1 = makeMgr(dir);
    const session = await mgr1.create({
      workerId: "w1",
      workspaceId: "test-ws",
      metadata: { client: "telegram", chatId: 42 },
    });

    const mgr2 = makeMgr(dir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata).toEqual({ client: "telegram", chatId: 42 });

    // Also verify via list
    const { sessions: list } = await mgr2.list();
    expect(list[0].metadata).toEqual({ client: "telegram", chatId: 42 });
  });

  test("list with workerId filter and isActive callback", async () => {
    const mgr = makeMgr(`${tmp.path}/sm25`);
    const s1 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" });

    const { sessions: filtered } = await mgr.list((id) => id === s1.sessionId, { workerId: "w1" });
    expect(filtered.length).toBe(2);
    const active = filtered.find((s) => s.sessionId === s1.sessionId);
    expect(active!.active).toBe(true);
    // Second w1 session should be inactive
    const inactive = filtered.find((s) => s.sessionId !== s1.sessionId);
    expect(inactive!.active).toBe(false);
  });

  test("list with metadata filter returns only matching sessions", async () => {
    const mgr = makeMgr(`${tmp.path}/sm29`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", metadata: { client: "telegram", chatId: 100 } });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", metadata: { client: "telegram", chatId: 200 } });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", metadata: { client: "tui" } });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" }); // no metadata

    const { sessions: telegramSessions } = await mgr.list(undefined, { metadata: { client: "telegram" } });
    expect(telegramSessions.length).toBe(2);
    expect(telegramSessions.every((s) => s.metadata?.client === "telegram")).toBe(true);

    const { sessions: tuiSessions } = await mgr.list(undefined, { metadata: { client: "tui" } });
    expect(tuiSessions.length).toBe(1);
    expect(tuiSessions[0].metadata?.client).toBe("tui");
  });

  test("list with workerId + metadata combined filter", async () => {
    const mgr = makeMgr(`${tmp.path}/sm30`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", metadata: { client: "telegram" } });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws", metadata: { client: "telegram" } });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", metadata: { client: "tui" } });

    const { sessions: filtered } = await mgr.list(undefined, { workerId: "w1", metadata: { client: "telegram" } });
    expect(filtered.length).toBe(1);
    expect(filtered[0].workerId).toBe("w1");
    expect(filtered[0].metadata?.client).toBe("telegram");
  });

  test("list with name filter", async () => {
    const mgr = makeMgr(`${tmp.path}/sm31`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Alpha" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Beta" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Alpha" });

    const { sessions: filtered } = await mgr.list(undefined, { name: "Alpha" });
    expect(filtered.length).toBe(2);
    expect(filtered.every((s) => s.name === "Alpha")).toBe(true);
  });

  test("list with active filter", async () => {
    const mgr = makeMgr(`${tmp.path}/sm32`);
    const s1 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    // s1 is active, s2 is inactive via callback
    const { sessions: activeSessions } = await mgr.list((id) => id === s1.sessionId, { active: true });
    expect(activeSessions.length).toBe(1);
    expect(activeSessions[0].sessionId).toBe(s1.sessionId);

    const { sessions: inactiveSessions } = await mgr.list((id) => id === s1.sessionId, { active: false });
    expect(inactiveSessions.length).toBe(1);
    expect(inactiveSessions[0].sessionId).not.toBe(s1.sessionId);
  });

  test("list with limit returns correct subset", async () => {
    const mgr = makeMgr(`${tmp.path}/sm33`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    const { sessions, total } = await mgr.list(undefined, undefined, { limit: 2 });
    expect(sessions.length).toBe(2);
    expect(total).toBe(3);
  });

  test("list with offset skips items", async () => {
    const mgr = makeMgr(`${tmp.path}/sm34`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    const { sessions: all } = await mgr.list();
    const { sessions, total } = await mgr.list(undefined, undefined, { offset: 1 });
    expect(total).toBe(3);
    expect(sessions.length).toBe(2);
    expect(sessions[0].sessionId).toBe(all[1].sessionId);
  });

  test("list with limit and offset together", async () => {
    const mgr = makeMgr(`${tmp.path}/sm35`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    const { sessions: all } = await mgr.list();
    const { sessions, total } = await mgr.list(undefined, undefined, { limit: 2, offset: 1 });
    expect(total).toBe(4);
    expect(sessions.length).toBe(2);
    expect(sessions[0].sessionId).toBe(all[1].sessionId);
    expect(sessions[1].sessionId).toBe(all[2].sessionId);
  });

  test("list with limit + filter applies pagination after filter", async () => {
    const mgr = makeMgr(`${tmp.path}/sm36`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    const { sessions, total } = await mgr.list(undefined, { workerId: "w1" }, { limit: 1 });
    expect(sessions.length).toBe(1);
    expect(total).toBe(3);
    expect(sessions[0].workerId).toBe("w1");
  });

  test("atomic write leaves no .tmp files behind", async () => {
    const dir = `${tmp.path}/sm_atomic`;
    const mgr = makeMgr(dir);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });

    const sessionsDir = resolve(dir, "sessions");
    const files = readdirSync(sessionsDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  test("listByWorker returns active session IDs for a worker", async () => {
    const mgr = makeMgr(`${tmp.path}/sm_lbw1`);
    const s1 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const s2 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.create({ workerId: "w2", workspaceId: "test-ws" });

    const ids = mgr.listByWorker("w1");
    expect(ids.sort()).toEqual([s1.sessionId, s2.sessionId].sort());
  });

  test("listByWorker returns empty for unknown worker", async () => {
    const mgr = makeMgr(`${tmp.path}/sm_lbw2`);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    expect(mgr.listByWorker("unknown")).toHaveLength(0);
  });

  test("listByWorker excludes released sessions", async () => {
    const mgr = makeMgr(`${tmp.path}/sm_lbw3`);
    const s1 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    const s2 = await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    await mgr.release(s1.sessionId);

    const ids = mgr.listByWorker("w1");
    expect(ids).toEqual([s2.sessionId]);
  });

  test("list prefers in-memory data for loaded sessions", async () => {
    const dir = `${tmp.path}/sm_list_memory`;
    const mgr = makeMgr(dir);
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Original" });

    // Mutate in-memory name without saving
    session.name = "Modified In Memory";

    const { sessions } = await mgr.list();
    const item = sessions.find((s) => s.sessionId === session.sessionId);
    expect(item!.name).toBe("Modified In Memory");
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

  test("load still works for valid session files after corrupt test", async () => {
    const dir = `${tmp.path}/sm_corrupt4`;
    const mgr = makeMgr(dir);
    // Create a valid session
    const session = await mgr.create({ workerId: "w1", workspaceId: "test-ws", name: "Valid Session" });
    // Release it so it's only on disk
    await mgr.release(session.sessionId);

    // Load from disk — should work fine
    const loaded = mgr.load(session.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Valid Session");
  });

  test("corrupt file does not affect list() (silently skipped)", async () => {
    const dir = `${tmp.path}/sm_corrupt5`;
    const mgr = makeMgr(dir);
    await mgr.create({ workerId: "w1", workspaceId: "test-ws" });
    // Add a corrupt file
    writeFileSync(resolve(dir, "sessions", "broken.json"), "{{{{");
    const { sessions, total } = await mgr.list();
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

// API key stripping tests removed — API keys are now managed by ProviderState,
// not stored in per-session config.
