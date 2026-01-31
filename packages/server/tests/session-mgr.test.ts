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
});
