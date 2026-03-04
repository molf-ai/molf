import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { WorkspaceStore } from "../src/workspace-store.js";
import { existsSync } from "fs";
import { join } from "path";

let tmp: TmpDir;
beforeAll(() => { tmp = createTmpDir(); });
afterAll(() => { tmp.cleanup(); });

function makeStore(dir: string) {
  return new WorkspaceStore(dir);
}

describe("WorkspaceStore", () => {
  describe("ensureDefault", () => {
    test("creates default workspace on first call", async () => {
      const store = makeStore(`${tmp.path}/ws1`);
      const ws = await store.ensureDefault("worker-1");
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBe("main");
      expect(ws.isDefault).toBe(true);
      expect(ws.sessions).toEqual([]);
      expect(ws.lastSessionId).toBe("");
      expect(ws.config).toEqual({});
      expect(ws.createdAt).toBeGreaterThan(0);
    });

    test("returns existing default on second call", async () => {
      const store = makeStore(`${tmp.path}/ws2`);
      const first = await store.ensureDefault("worker-1");
      const second = await store.ensureDefault("worker-1");
      expect(second.id).toBe(first.id);
      expect(second).toBe(first); // same reference (from cache)
    });

    test("different workers get different defaults", async () => {
      const store = makeStore(`${tmp.path}/ws_def_multi`);
      const d1 = await store.ensureDefault("worker-1");
      const d2 = await store.ensureDefault("worker-2");
      expect(d1.id).not.toBe(d2.id);
    });
  });

  describe("create", () => {
    test("creates workspace with isDefault false and generates UUID", async () => {
      const store = makeStore(`${tmp.path}/ws3`);
      const ws = await store.create("worker-1", "my-project");
      expect(ws.id).toBeTruthy();
      expect(ws.name).toBe("my-project");
      expect(ws.isDefault).toBe(false);
      expect(ws.sessions).toEqual([]);
      expect(ws.config).toEqual({});
    });

    test("creates workspace with config", async () => {
      const store = makeStore(`${tmp.path}/ws4`);
      const ws = await store.create("worker-1", "with-config", { model: "gemini-pro" });
      expect(ws.config.model).toBe("gemini-pro");
    });

    test("rejects duplicate names", async () => {
      const store = makeStore(`${tmp.path}/ws5`);
      await store.create("worker-1", "unique-name");
      await expect(store.create("worker-1", "unique-name")).rejects.toThrow("already exists");
    });

    test("allows same name for different workers", async () => {
      const store = makeStore(`${tmp.path}/ws6`);
      const ws1 = await store.create("worker-1", "shared-name");
      const ws2 = await store.create("worker-2", "shared-name");
      expect(ws1.id).not.toBe(ws2.id);
    });
  });

  describe("get", () => {
    test("returns workspace by id", async () => {
      const store = makeStore(`${tmp.path}/ws7`);
      const created = await store.create("worker-1", "test");
      const got = await store.get("worker-1", created.id);
      expect(got).toBe(created);
    });

    test("returns undefined for unknown id", async () => {
      const store = makeStore(`${tmp.path}/ws8`);
      expect(await store.get("worker-1", "nonexistent")).toBeUndefined();
    });
  });

  describe("getByName", () => {
    test("resolves name to workspace", async () => {
      const store = makeStore(`${tmp.path}/ws9`);
      const created = await store.create("worker-1", "by-name");
      const found = await store.getByName("worker-1", "by-name");
      expect(found?.id).toBe(created.id);
    });

    test("returns undefined for unknown name", async () => {
      const store = makeStore(`${tmp.path}/ws10`);
      expect(await store.getByName("worker-1", "nope")).toBeUndefined();
    });
  });

  describe("getDefault", () => {
    test("returns the isDefault workspace", async () => {
      const store = makeStore(`${tmp.path}/ws11`);
      const def = await store.ensureDefault("worker-1");
      await store.create("worker-1", "other");
      const got = await store.getDefault("worker-1");
      expect(got?.id).toBe(def.id);
    });

    test("returns undefined when no workspaces exist", async () => {
      const store = makeStore(`${tmp.path}/ws12`);
      expect(await store.getDefault("worker-1")).toBeUndefined();
    });
  });

  describe("list", () => {
    test("returns all workspaces for worker", async () => {
      const store = makeStore(`${tmp.path}/ws13`);
      await store.ensureDefault("worker-1");
      await store.create("worker-1", "proj-a");
      await store.create("worker-1", "proj-b");
      const list = await store.list("worker-1");
      expect(list.length).toBe(3);
    });

    test("returns empty for unknown worker", async () => {
      const store = makeStore(`${tmp.path}/ws14`);
      expect(await store.list("unknown")).toEqual([]);
    });

    test("does not include other worker's workspaces", async () => {
      const store = makeStore(`${tmp.path}/ws_list_iso`);
      await store.create("worker-1", "proj-1");
      await store.create("worker-2", "proj-2");
      const list = await store.list("worker-1");
      expect(list.length).toBe(1);
      expect(list[0].name).toBe("proj-1");
    });
  });

  describe("rename", () => {
    test("renames workspace", async () => {
      const store = makeStore(`${tmp.path}/ws15`);
      const ws = await store.create("worker-1", "old-name");
      const result = await store.rename("worker-1", ws.id, "new-name");
      expect(result).toBe(true);
      expect(ws.name).toBe("new-name");
    });

    test("renames default workspace", async () => {
      const store = makeStore(`${tmp.path}/ws16`);
      const def = await store.ensureDefault("worker-1");
      await store.rename("worker-1", def.id, "general");
      expect(def.name).toBe("general");
      expect(def.isDefault).toBe(true); // still default
    });

    test("rejects duplicate name on rename", async () => {
      const store = makeStore(`${tmp.path}/ws17`);
      await store.create("worker-1", "taken");
      const ws = await store.create("worker-1", "original");
      await expect(store.rename("worker-1", ws.id, "taken")).rejects.toThrow("already exists");
    });

    test("returns false for unknown workspace", async () => {
      const store = makeStore(`${tmp.path}/ws18`);
      expect(await store.rename("worker-1", "nonexistent", "name")).toBe(false);
    });

    test("allows renaming to same name (no-op)", async () => {
      const store = makeStore(`${tmp.path}/ws_rename_noop`);
      const ws = await store.create("worker-1", "same");
      const result = await store.rename("worker-1", ws.id, "same");
      expect(result).toBe(true);
    });

    test("does not rename directory on disk (filename is UUID)", async () => {
      const dir = `${tmp.path}/ws_rename_disk`;
      const store = makeStore(dir);
      const ws = await store.create("worker-1", "original");
      const wsDir = join(dir, "workers", "worker-1", "workspaces", ws.id);

      await store.rename("worker-1", ws.id, "renamed");

      // Directory still named by UUID, not by name
      expect(existsSync(wsDir)).toBe(true);
      expect(existsSync(join(wsDir, "state.json"))).toBe(true);
    });
  });

  describe("addSession", () => {
    test("appends session to list and updates lastSessionId", async () => {
      const store = makeStore(`${tmp.path}/ws19`);
      const ws = await store.create("worker-1", "proj");
      await store.addSession("worker-1", ws.id, "session-1");
      expect(ws.sessions).toEqual(["session-1"]);
      expect(ws.lastSessionId).toBe("session-1");

      await store.addSession("worker-1", ws.id, "session-2");
      expect(ws.sessions).toEqual(["session-1", "session-2"]);
      expect(ws.lastSessionId).toBe("session-2");
    });

    test("throws for unknown workspace", async () => {
      const store = makeStore(`${tmp.path}/ws20`);
      await expect(store.addSession("worker-1", "nonexistent", "s1")).rejects.toThrow("not found");
    });
  });

  describe("updateLastSession", () => {
    test("updates lastSessionId", async () => {
      const store = makeStore(`${tmp.path}/ws21`);
      const ws = await store.create("worker-1", "proj");
      await store.addSession("worker-1", ws.id, "s1");
      await store.addSession("worker-1", ws.id, "s2");
      expect(ws.lastSessionId).toBe("s2");

      await store.updateLastSession("worker-1", ws.id, "s1");
      expect(ws.lastSessionId).toBe("s1");
    });

    test("no-op if same sessionId", async () => {
      const store = makeStore(`${tmp.path}/ws22`);
      const ws = await store.create("worker-1", "proj");
      await store.addSession("worker-1", ws.id, "s1");
      await store.updateLastSession("worker-1", ws.id, "s1");
      expect(ws.lastSessionId).toBe("s1");
    });

    test("no-op for unknown workspace", async () => {
      const store = makeStore(`${tmp.path}/ws23`);
      // Should not throw
      await store.updateLastSession("worker-1", "nonexistent", "s1");
    });
  });

  describe("setConfig", () => {
    test("updates workspace config", async () => {
      const store = makeStore(`${tmp.path}/ws24`);
      const ws = await store.create("worker-1", "proj");
      await store.setConfig("worker-1", ws.id, { model: "gemini-pro" });
      expect(ws.config.model).toBe("gemini-pro");
    });

    test("clears model with empty config", async () => {
      const store = makeStore(`${tmp.path}/ws25`);
      const ws = await store.create("worker-1", "proj");
      await store.setConfig("worker-1", ws.id, { model: "gemini-pro" });
      await store.setConfig("worker-1", ws.id, {});
      expect(ws.config.model).toBeUndefined();
    });

    test("throws for unknown workspace", async () => {
      const store = makeStore(`${tmp.path}/ws26`);
      await expect(store.setConfig("worker-1", "nonexistent", {})).rejects.toThrow("not found");
    });
  });

  describe("persistence", () => {
    test("data survives new store instance from same directory", async () => {
      const dir = `${tmp.path}/ws27`;
      const store1 = makeStore(dir);
      const ws = await store1.ensureDefault("worker-1");
      await store1.addSession("worker-1", ws.id, "s1");
      await store1.setConfig("worker-1", ws.id, { model: "gemini-flash" });

      const store2 = makeStore(dir);
      const loaded = await store2.getDefault("worker-1");
      expect(loaded).not.toBeUndefined();
      expect(loaded!.id).toBe(ws.id);
      expect(loaded!.name).toBe("main");
      expect(loaded!.isDefault).toBe(true);
      expect(loaded!.sessions).toEqual(["s1"]);
      expect(loaded!.config.model).toBe("gemini-flash");
    });

    test("per-workspace files: modifying workspace X doesn't affect workspace Y", async () => {
      const dir = `${tmp.path}/ws28`;
      const store = makeStore(dir);
      const wsX = await store.create("worker-1", "project-x");
      const wsY = await store.create("worker-1", "project-y");

      await store.addSession("worker-1", wsX.id, "sx1");
      await store.setConfig("worker-1", wsX.id, { model: "gemini-pro" });

      // Y should be unchanged
      const yReloaded = await store.get("worker-1", wsY.id);
      expect(yReloaded!.sessions).toEqual([]);
      expect(yReloaded!.config).toEqual({});
    });

    test("in-memory cache: mutations reflected without re-loading from disk", async () => {
      const dir = `${tmp.path}/ws29`;
      const store = makeStore(dir);
      const ws = await store.create("worker-1", "cached");
      await store.addSession("worker-1", ws.id, "s1");

      // Read from same store should reflect mutations (in-memory)
      const got = await store.get("worker-1", ws.id);
      expect(got!.sessions).toEqual(["s1"]);
      expect(got).toBe(ws); // same reference
    });

    test("rename persists to disk", async () => {
      const dir = `${tmp.path}/ws30`;
      const store1 = makeStore(dir);
      const ws = await store1.create("worker-1", "before");
      await store1.rename("worker-1", ws.id, "after");

      const store2 = makeStore(dir);
      const loaded = await store2.getByName("worker-1", "after");
      expect(loaded).not.toBeUndefined();
      expect(loaded!.id).toBe(ws.id);
    });

    test("create persists to disk", async () => {
      const dir = `${tmp.path}/ws31`;
      const store1 = makeStore(dir);
      const ws = await store1.create("worker-1", "persisted", { model: "gpt-4" });

      const store2 = makeStore(dir);
      const loaded = await store2.get("worker-1", ws.id);
      expect(loaded).not.toBeUndefined();
      expect(loaded!.name).toBe("persisted");
      expect(loaded!.config.model).toBe("gpt-4");
    });
  });
});
