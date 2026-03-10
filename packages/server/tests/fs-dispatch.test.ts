import { describe, test, expect } from "vitest";
import { FsDispatch } from "../src/fs-dispatch.js";
import type { FsReadRequest, FsReadResult } from "@molf-ai/protocol";

function makeRequest(id: string): FsReadRequest {
  return { requestId: id };
}

function makeResult(id: string, content = "data"): FsReadResult {
  return { requestId: id, content, size: content.length, encoding: "utf-8" };
}

describe("FsDispatch", () => {
  describe("dispatch and resolveRead", () => {
    test("resolves when result arrives", async () => {
      const fs = new FsDispatch();
      const promise = fs.dispatch("w1", makeRequest("r1"));

      expect(fs.resolveRead("r1", makeResult("r1", "hello"))).toBe(true);
      const result = await promise;
      expect(result.content).toBe("hello");
    });

    test("resolveRead returns false for unknown request", () => {
      const fs = new FsDispatch();
      expect(fs.resolveRead("unknown", makeResult("unknown"))).toBe(false);
    });
  });

  describe("subscribeWorker", () => {
    test("yields dispatched requests", async () => {
      const fs = new FsDispatch();
      fs.dispatch("w1", makeRequest("r1"));

      const ac = new AbortController();
      const gen = fs.subscribeWorker("w1", ac.signal);

      const r1 = await gen.next();
      expect(r1.value!.requestId).toBe("r1");

      ac.abort();
      fs.resolveRead("r1", makeResult("r1"));
    });

    test("stops on abort", async () => {
      const fs = new FsDispatch();
      const ac = new AbortController();
      const gen = fs.subscribeWorker("w1", ac.signal);

      ac.abort();
      const r = await gen.next();
      expect(r.done).toBe(true);
    });
  });

  describe("workerDisconnected", () => {
    test("resolves pending with disconnect error", async () => {
      const fs = new FsDispatch();
      const promise = fs.dispatch("w1", makeRequest("r1"));

      fs.workerDisconnected("w1");
      const result = await promise;
      expect(result.error).toContain("w1");
      expect(result.error).toContain("disconnected");
    });

    test("no-op for unknown worker", () => {
      const fs = new FsDispatch();
      expect(() => fs.workerDisconnected("unknown")).not.toThrow();
    });
  });

  describe("dispatch with outputId", () => {
    test("passes outputId through to worker subscription", async () => {
      const fs = new FsDispatch();
      const promise = fs.dispatch("w1", { requestId: "r1", outputId: "out-1" });

      const ac = new AbortController();
      const gen = fs.subscribeWorker("w1", ac.signal);
      const req = await gen.next();
      expect(req.value!.requestId).toBe("r1");
      expect(req.value!.outputId).toBe("out-1");

      fs.resolveRead("r1", makeResult("r1"));
      await promise;
      ac.abort();
    });
  });
});
