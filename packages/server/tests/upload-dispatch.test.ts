import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";
import { UploadDispatch } from "../src/upload-dispatch.js";

let tmp: TmpDir;

beforeAll(() => {
  tmp = createTmpDir("molf-upload-dispatch-");
});

afterAll(() => {
  tmp.cleanup();
});

function makeRequest(uploadId: string) {
  return { uploadId, filename: "test.jpg", mimeType: "image/jpeg", size: 100 };
}

describe("UploadDispatch", () => {
  describe("constructor", () => {
    test("cleans up pre-existing staged files from a previous run", () => {
      const stagingDir = join(tmp.path, "uploads-staging");
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, "orphaned-upload"), "leftover");
      expect(existsSync(join(stagingDir, "orphaned-upload"))).toBe(true);

      // Constructor should wipe and recreate the staging directory
      new UploadDispatch(tmp.path);

      expect(existsSync(join(stagingDir, "orphaned-upload"))).toBe(false);
      expect(existsSync(stagingDir)).toBe(true);
    });
  });

  describe("dispatch and resolve", () => {
    test("resolves when worker sends result", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const req = makeRequest("u1");

      const promise = dispatch.dispatch("w1", req);
      const resolved = dispatch.resolveUpload("u1", { path: ".molf/uploads/u1-test.jpg", size: 100 });

      expect(resolved).toBe(true);
      const result = await promise;
      expect(result.path).toBe(".molf/uploads/u1-test.jpg");
      expect(result.size).toBe(100);
    });

    test("resolveUpload returns false for unknown upload", () => {
      const dispatch = new UploadDispatch(tmp.path);
      expect(dispatch.resolveUpload("unknown", { path: "", size: 0 })).toBe(false);
    });

    test("resolveUpload with error", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const req = makeRequest("u1");

      const promise = dispatch.dispatch("w1", req);
      dispatch.resolveUpload("u1", { path: "", size: 0, error: "disk full" });

      const result = await promise;
      expect(result.error).toBe("disk full");
    });
  });

  describe("stageFile and getUploadFile", () => {
    test("stages a file and retrieves it", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const file = new File([Buffer.from("test-data")], "photo.jpg", { type: "image/jpeg" });

      await dispatch.stageFile("stage1", file, "w1");
      const retrieved = dispatch.getUploadFile("stage1");

      expect(retrieved).toBeInstanceOf(File);
      const content = Buffer.from(await retrieved!.arrayBuffer()).toString();
      expect(content).toBe("test-data");
    });

    test("getUploadFile returns undefined for unknown uploadId", () => {
      const dispatch = new UploadDispatch(tmp.path);
      expect(dispatch.getUploadFile("nonexistent")).toBeUndefined();
    });

    test("getUploadFile removes the staged entry", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const file = new File([Buffer.from("data")], "f.txt", { type: "text/plain" });

      await dispatch.stageFile("stage2", file, "w1");
      dispatch.getUploadFile("stage2");
      // Second call returns undefined
      expect(dispatch.getUploadFile("stage2")).toBeUndefined();
    });
  });

  describe("deleteStaged", () => {
    test("deletes a staged file", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const file = new File([Buffer.from("data")], "f.txt", { type: "text/plain" });

      await dispatch.stageFile("del1", file, "w1");
      dispatch.deleteStaged("del1");
      expect(dispatch.getUploadFile("del1")).toBeUndefined();
    });

    test("no-op for unknown uploadId", () => {
      const dispatch = new UploadDispatch(tmp.path);
      dispatch.deleteStaged("nonexistent"); // should not throw
    });
  });

  describe("subscribeWorker", () => {
    test("yields queued requests", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const req1 = makeRequest("u1");
      const req2 = makeRequest("u2");

      // Queue requests before subscription
      dispatch.dispatch("w1", req1);
      dispatch.dispatch("w1", req2);

      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      const r1 = await gen.next();
      expect(r1.value!.uploadId).toBe("u1");

      const r2 = await gen.next();
      expect(r2.value!.uploadId).toBe("u2");

      ac.abort();
      // Resolve to prevent leak
      dispatch.resolveUpload("u1", { path: "", size: 0 });
      dispatch.resolveUpload("u2", { path: "", size: 0 });
    });

    test("yields live requests as they arrive", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      // Dispatch after subscription is waiting
      setTimeout(() => {
        dispatch.dispatch("w1", makeRequest("u1"));
      }, 10);

      const r1 = await gen.next();
      expect(r1.value!.uploadId).toBe("u1");

      ac.abort();
      dispatch.resolveUpload("u1", { path: "", size: 0 });
    });

    test("stops on abort", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      ac.abort();

      const r = await gen.next();
      expect(r.done).toBe(true);
    });
  });

  describe("workerDisconnected", () => {
    test("resolves pending uploads with error", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const req = makeRequest("u1");
      const promise = dispatch.dispatch("w1", req);

      dispatch.workerDisconnected("w1");

      const result = await promise;
      expect(result.error).toContain("disconnected");
      expect(result.path).toBe("");
    });

    test("cleans up queued requests", () => {
      const dispatch = new UploadDispatch(tmp.path);
      dispatch.dispatch("w1", makeRequest("u1"));

      dispatch.workerDisconnected("w1");

      // Worker re-subscribes — no stale requests
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      // Should block (no queued items), so abort immediately
      ac.abort();
      // Resolve pending to prevent leak
      dispatch.resolveUpload("u1", { path: "", size: 0 });
    });

    test("cleans up staged files for disconnected worker", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const file = new File([Buffer.from("data")], "f.txt", { type: "text/plain" });
      await dispatch.stageFile("staged-dc", file, "w1");

      dispatch.workerDisconnected("w1");

      expect(dispatch.getUploadFile("staged-dc")).toBeUndefined();
    });

    test("no-op for unknown worker", () => {
      const dispatch = new UploadDispatch(tmp.path);
      dispatch.workerDisconnected("unknown"); // should not throw
    });
  });

  describe("cleanup", () => {
    test("clears all staged files", async () => {
      const dispatch = new UploadDispatch(tmp.path);
      const file = new File([Buffer.from("data")], "f.txt", { type: "text/plain" });
      await dispatch.stageFile("cleanup1", file, "w1");

      await dispatch.cleanup();

      expect(dispatch.getUploadFile("cleanup1")).toBeUndefined();
    });
  });
});
