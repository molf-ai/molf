import { describe, test, expect } from "vitest";
import { flushAsync } from "@molf-ai/test-utils";
import { CancelNotifier } from "../src/cancel-notifier.js";

describe("CancelNotifier", () => {
  test("notify while subscribed delivers event", async () => {
    const cn = new CancelNotifier();
    const ac = new AbortController();
    const gen = cn.subscribe("w1", ac.signal);

    // Start waiting
    const nextPromise = gen.next();
    await flushAsync();

    cn.notify("w1", "tc1");
    const { value } = await nextPromise;
    expect(value).toEqual({ toolCallId: "tc1" });

    ac.abort();
  });

  test("multiple notifications delivered in order", async () => {
    const cn = new CancelNotifier();
    const ac = new AbortController();
    const gen = cn.subscribe("w1", ac.signal);

    // Start waiting, then notify twice
    const p1 = gen.next();
    await flushAsync();

    cn.notify("w1", "tc1");
    cn.notify("w1", "tc2");

    const r1 = await p1;
    expect(r1.value).toEqual({ toolCallId: "tc1" });

    const r2 = await gen.next();
    expect(r2.value).toEqual({ toolCallId: "tc2" });

    ac.abort();
  });

  test("abort stops subscription", async () => {
    const cn = new CancelNotifier();
    const ac = new AbortController();
    const gen = cn.subscribe("w1", ac.signal);

    ac.abort();
    const { done } = await gen.next();
    expect(done).toBe(true);
  });

  test("abort while waiting stops subscription", async () => {
    const cn = new CancelNotifier();
    const ac = new AbortController();
    const gen = cn.subscribe("w1", ac.signal);

    const nextPromise = gen.next();
    await flushAsync();

    ac.abort();
    const { done } = await nextPromise;
    expect(done).toBe(true);
  });

  test("notifications to different workers are independent", async () => {
    const cn = new CancelNotifier();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const gen1 = cn.subscribe("w1", ac1.signal);
    const gen2 = cn.subscribe("w2", ac2.signal);

    const p1 = gen1.next();
    const p2 = gen2.next();
    await flushAsync();

    cn.notify("w1", "tc1");
    cn.notify("w2", "tc2");

    const r1 = await p1;
    expect(r1.value).toEqual({ toolCallId: "tc1" });

    const r2 = await p2;
    expect(r2.value).toEqual({ toolCallId: "tc2" });

    ac1.abort();
    ac2.abort();
  });

  test("notify without subscriber is silently dropped", () => {
    const cn = new CancelNotifier();
    // Should not throw
    cn.notify("w1", "tc1");
  });
});
