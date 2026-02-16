import { describe, test, expect } from "bun:test";
import { UploadDispatch } from "../src/upload-dispatch.js";

function makeRequest(uploadId: string) {
  return { uploadId, data: "aGVsbG8=", filename: "test.jpg", mimeType: "image/jpeg" };
}

describe("UploadDispatch", () => {
  describe("dispatch and resolve", () => {
    test("resolves when worker sends result", async () => {
      const dispatch = new UploadDispatch();
      const req = makeRequest("u1");

      const promise = dispatch.dispatch("w1", req);
      const resolved = dispatch.resolveUpload("u1", { path: ".molf/uploads/u1-test.jpg", size: 100 });

      expect(resolved).toBe(true);
      const result = await promise;
      expect(result.path).toBe(".molf/uploads/u1-test.jpg");
      expect(result.size).toBe(100);
    });

    test("resolveUpload returns false for unknown upload", () => {
      const dispatch = new UploadDispatch();
      expect(dispatch.resolveUpload("unknown", { path: "", size: 0 })).toBe(false);
    });

    test("resolveUpload with error", async () => {
      const dispatch = new UploadDispatch();
      const req = makeRequest("u1");

      const promise = dispatch.dispatch("w1", req);
      dispatch.resolveUpload("u1", { path: "", size: 0, error: "disk full" });

      const result = await promise;
      expect(result.error).toBe("disk full");
    });
  });

  describe("subscribeWorker", () => {
    test("yields queued requests", async () => {
      const dispatch = new UploadDispatch();
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
      const dispatch = new UploadDispatch();
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
      const dispatch = new UploadDispatch();
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      ac.abort();

      const r = await gen.next();
      expect(r.done).toBe(true);
    });
  });

  describe("workerDisconnected", () => {
    test("resolves pending uploads with error", async () => {
      const dispatch = new UploadDispatch();
      const req = makeRequest("u1");
      const promise = dispatch.dispatch("w1", req);

      dispatch.workerDisconnected("w1");

      const result = await promise;
      expect(result.error).toContain("disconnected");
      expect(result.path).toBe("");
    });

    test("cleans up queued requests", () => {
      const dispatch = new UploadDispatch();
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

    test("no-op for unknown worker", () => {
      const dispatch = new UploadDispatch();
      dispatch.workerDisconnected("unknown"); // should not throw
    });
  });
});
