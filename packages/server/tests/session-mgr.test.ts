import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../src/session-mgr.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "molf-session-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("SessionManager", () => {
  test("create returns a session with UUID and metadata", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "worker-1" });

    expect(session.sessionId).toBeDefined();
    expect(session.workerId).toBe("worker-1");
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.lastActiveAt).toBeGreaterThan(0);
    expect(session.messages).toEqual([]);
  });

  test("create with custom name", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "worker-1", name: "My Session" });

    expect(session.name).toBe("My Session");
  });

  test("create generates default name when not provided", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "worker-1" });

    expect(session.name).toContain("Session");
  });

  test("create persists session to disk", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "worker-1" });

    const filePath = join(testDir, "sessions", `${session.sessionId}.json`);
    expect(existsSync(filePath)).toBe(true);
  });

  test("list returns all sessions", () => {
    const mgr = new SessionManager(testDir);
    mgr.create({ workerId: "w-1", name: "First" });
    mgr.create({ workerId: "w-2", name: "Second" });

    const list = mgr.list();
    expect(list).toHaveLength(2);
    const names = list.map((s) => s.name).sort();
    expect(names).toEqual(["First", "Second"]);
  });

  test("list includes messageCount", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "w-1" });

    mgr.addMessage(session.sessionId, {
      id: "msg_1", role: "user", content: "Hello", timestamp: Date.now(),
    });
    mgr.save(session.sessionId);

    const list = mgr.list();
    expect(list[0].messageCount).toBe(1);
  });

  test("list shows active sessions", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "w-1" });

    const list = mgr.list();
    expect(list[0].active).toBe(true);
  });

  test("load returns session from memory cache", () => {
    const mgr = new SessionManager(testDir);
    const created = mgr.create({ workerId: "w-1", name: "Test" });

    const loaded = mgr.load(created.sessionId);
    expect(loaded).toBeDefined();
    expect(loaded!.sessionId).toBe(created.sessionId);
    expect(loaded!.name).toBe("Test");
  });

  test("load returns session from disk after new manager instance", () => {
    const mgr1 = new SessionManager(testDir);
    const session = mgr1.create({ workerId: "w-1", name: "Persistent" });

    // Create a new manager to simulate server restart
    const mgr2 = new SessionManager(testDir);
    const loaded = mgr2.load(session.sessionId);

    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Persistent");
    expect(loaded!.workerId).toBe("w-1");
  });

  test("load returns null for nonexistent session", () => {
    const mgr = new SessionManager(testDir);
    expect(mgr.load("nonexistent")).toBeNull();
  });

  test("delete removes session from memory and disk", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "w-1" });

    const deleted = mgr.delete(session.sessionId);
    expect(deleted).toBe(true);

    const filePath = join(testDir, "sessions", `${session.sessionId}.json`);
    expect(existsSync(filePath)).toBe(false);
    expect(mgr.load(session.sessionId)).toBeNull();
  });

  test("delete returns false for nonexistent session", () => {
    const mgr = new SessionManager(testDir);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  test("addMessage appends to session and updates lastActiveAt", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "w-1" });
    const originalTime = session.lastActiveAt;

    // Small delay to ensure different timestamp
    mgr.addMessage(session.sessionId, {
      id: "msg_1", role: "user", content: "Hello", timestamp: Date.now(),
    });

    const active = mgr.getActive(session.sessionId);
    expect(active!.messages).toHaveLength(1);
    expect(active!.messages[0].content).toBe("Hello");
    expect(active!.lastActiveAt).toBeGreaterThanOrEqual(originalTime);
  });

  test("addMessage throws for unloaded session", () => {
    const mgr = new SessionManager(testDir);

    expect(() =>
      mgr.addMessage("nonexistent", {
        id: "msg_1", role: "user", content: "Hello", timestamp: Date.now(),
      }),
    ).toThrow("not loaded");
  });

  test("getMessages returns messages for loaded session", () => {
    const mgr = new SessionManager(testDir);
    const session = mgr.create({ workerId: "w-1" });

    mgr.addMessage(session.sessionId, {
      id: "msg_1", role: "user", content: "Hello", timestamp: Date.now(),
    });
    mgr.addMessage(session.sessionId, {
      id: "msg_2", role: "assistant", content: "Hi", timestamp: Date.now(),
    });

    const messages = mgr.getMessages(session.sessionId);
    expect(messages).toHaveLength(2);
  });

  test("getMessages returns empty array for unknown session", () => {
    const mgr = new SessionManager(testDir);
    expect(mgr.getMessages("unknown")).toEqual([]);
  });

  test("load returns null for corrupt JSON file", () => {
    const mgr = new SessionManager(testDir);
    const { writeFileSync, mkdirSync } = require("fs");
    mkdirSync(join(testDir, "sessions"), { recursive: true });
    writeFileSync(join(testDir, "sessions", "corrupt.json"), "NOT VALID JSON{{{");
    expect(mgr.load("corrupt")).toBeNull();
  });

  test("list skips corrupt files", () => {
    const mgr = new SessionManager(testDir);
    mgr.create({ workerId: "w-1", name: "Valid" });
    const { writeFileSync } = require("fs");
    writeFileSync(join(testDir, "sessions", "corrupt.json"), "{{{bad");

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Valid");
  });

  test("save persists current state to disk", () => {
    const mgr1 = new SessionManager(testDir);
    const session = mgr1.create({ workerId: "w-1" });

    mgr1.addMessage(session.sessionId, {
      id: "msg_1", role: "user", content: "Saved message", timestamp: Date.now(),
    });
    mgr1.save(session.sessionId);

    // Load in new manager
    const mgr2 = new SessionManager(testDir);
    const loaded = mgr2.load(session.sessionId);
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].content).toBe("Saved message");
  });
});
