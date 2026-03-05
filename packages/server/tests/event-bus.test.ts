import { describe, test, expect } from "bun:test";
import { EventBus } from "../src/event-bus.js";
import type { AgentEvent } from "@molf-ai/protocol";

function makeEvent(type: "status_change" | "content_delta" | "error" = "status_change"): AgentEvent {
  switch (type) {
    case "content_delta":
      return { type: "content_delta", delta: "hi", content: "hi" } as AgentEvent;
    case "error":
      return { type: "error", code: "test", message: "test error" } as AgentEvent;
    default:
      return { type: "status_change", status: "idle" } as AgentEvent;
  }
}

describe("EventBus", () => {
  test("subscribe + emit delivers event", () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    bus.emit("s1", makeEvent("status_change"));
    expect(events).toHaveLength(1);
  });

  test("multiple listeners on same session", () => {
    const bus = new EventBus();
    const events1: AgentEvent[] = [];
    const events2: AgentEvent[] = [];
    bus.subscribe("s1", (e) => events1.push(e));
    bus.subscribe("s1", (e) => events2.push(e));
    bus.emit("s1", makeEvent("content_delta"));
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  test("listeners on different sessions isolated", () => {
    const bus = new EventBus();
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    bus.subscribe("sA", (e) => eventsA.push(e));
    bus.subscribe("sB", (e) => eventsB.push(e));
    bus.emit("sA", makeEvent("error"));
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
  });

  test("unsubscribe removes listener", () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    const unsub = bus.subscribe("s1", (e) => events.push(e));
    unsub();
    bus.emit("s1", makeEvent("content_delta"));
    expect(events).toHaveLength(0);
  });

  test("hasListeners true when subscribed", () => {
    const bus = new EventBus();
    bus.subscribe("s1", () => {});
    expect(bus.hasListeners("s1")).toBe(true);
  });

  test("hasListeners false after all unsubscribed", () => {
    const bus = new EventBus();
    const unsub = bus.subscribe("s1", () => {});
    unsub();
    expect(bus.hasListeners("s1")).toBe(false);
  });

  test("hasListeners false for unknown session", () => {
    const bus = new EventBus();
    expect(bus.hasListeners("unknown")).toBe(false);
  });

  test("emit to session with no listeners", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nobody", makeEvent("error"))).not.toThrow();
  });

  test("delivers different event types correctly", () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    bus.emit("s1", makeEvent("status_change"));
    bus.emit("s1", makeEvent("content_delta"));
    bus.emit("s1", makeEvent("error"));

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("status_change");
    expect(events[1].type).toBe("content_delta");
    expect(events[2].type).toBe("error");
  });

  test("subscribe returns a working unsubscribe function", () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    const unsub = bus.subscribe("s1", (e) => events.push(e));
    bus.emit("s1", makeEvent("content_delta"));
    expect(events).toHaveLength(1);
    unsub();
    bus.emit("s1", makeEvent("error"));
    expect(events).toHaveLength(1);
    expect(bus.hasListeners("s1")).toBe(false);
  });
});

// --- Error isolation tests (Step 3: EventBus try/catch) ---

describe("EventBus error isolation", () => {
  test("throwing listener does not prevent other listeners from receiving event", () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];

    bus.subscribe("s1", () => {
      throw new Error("listener 1 exploded");
    });
    bus.subscribe("s1", (e) => events.push(e));

    bus.emit("s1", makeEvent("content_delta"));

    // Second listener should still receive the event
    expect(events).toHaveLength(1);
  });

  test("throwing listener does not cause emit to throw", () => {
    const bus = new EventBus();
    bus.subscribe("s1", () => {
      throw new Error("kaboom");
    });

    expect(() => bus.emit("s1", makeEvent("error"))).not.toThrow();
  });

  test("all listeners receive event even when middle listener throws", () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.subscribe("s1", () => received.push("first"));
    bus.subscribe("s1", () => {
      throw new Error("middle exploded");
    });
    bus.subscribe("s1", () => received.push("third"));

    bus.emit("s1", makeEvent("status_change"));

    expect(received).toEqual(["first", "third"]);
  });

  test("multiple throwing listeners do not affect healthy listeners", () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];

    bus.subscribe("s1", () => { throw new Error("boom 1"); });
    bus.subscribe("s1", (e) => events.push(e));
    bus.subscribe("s1", () => { throw new Error("boom 2"); });
    bus.subscribe("s1", (e) => events.push(e));

    bus.emit("s1", makeEvent("error"));

    expect(events).toHaveLength(2);
  });
});
