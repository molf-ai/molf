import { describe, test, expect } from "bun:test";
import { WorkerDispatch } from "../src/worker-dispatch.js";

interface TestRequest {
  id: string;
  payload: string;
}

interface TestResult {
  data: string;
  error?: string;
}

function makeDispatch() {
  return new WorkerDispatch<TestRequest, TestResult>(
    (req) => req.id,
    (workerId) => ({ data: "", error: `Worker ${workerId} disconnected` }),
  );
}

describe("WorkerDispatch", () => {
  describe("dispatch and resolve", () => {
    test("resolves when result arrives", async () => {
      const dispatch = makeDispatch();
      const promise = dispatch.dispatch("w1", { id: "r1", payload: "hello" });

      expect(dispatch.resolve("r1", { data: "world" })).toBe(true);
      const result = await promise;
      expect(result.data).toBe("world");
    });

    test("resolve returns false for unknown id", () => {
      const dispatch = makeDispatch();
      expect(dispatch.resolve("unknown", { data: "" })).toBe(false);
    });
  });

  describe("subscribeWorker", () => {
    test("yields queued requests", async () => {
      const dispatch = makeDispatch();
      dispatch.dispatch("w1", { id: "r1", payload: "a" });
      dispatch.dispatch("w1", { id: "r2", payload: "b" });

      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      const r1 = await gen.next();
      expect(r1.value!.id).toBe("r1");

      const r2 = await gen.next();
      expect(r2.value!.id).toBe("r2");

      ac.abort();
      dispatch.resolve("r1", { data: "" });
      dispatch.resolve("r2", { data: "" });
    });

    test("yields live requests", async () => {
      const dispatch = makeDispatch();
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      setTimeout(() => {
        dispatch.dispatch("w1", { id: "r1", payload: "live" });
      }, 10);

      const r1 = await gen.next();
      expect(r1.value!.id).toBe("r1");

      ac.abort();
      dispatch.resolve("r1", { data: "" });
    });

    test("stops on abort", async () => {
      const dispatch = makeDispatch();
      const ac = new AbortController();
      const gen = dispatch.subscribeWorker("w1", ac.signal);

      ac.abort();
      const r = await gen.next();
      expect(r.done).toBe(true);
    });
  });

  describe("workerDisconnected", () => {
    test("resolves pending with disconnect result", async () => {
      const dispatch = makeDispatch();
      const promise = dispatch.dispatch("w1", { id: "r1", payload: "x" });

      dispatch.workerDisconnected("w1");

      const result = await promise;
      expect(result.error).toContain("disconnected");
    });

    test("no-op for unknown worker", () => {
      const dispatch = makeDispatch();
      dispatch.workerDisconnected("unknown"); // should not throw
    });
  });
});
