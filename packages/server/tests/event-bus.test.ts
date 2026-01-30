import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus.js";
import type { AgentEvent } from "@molf-ai/protocol";

describe("EventBus", () => {
  test("subscribe and emit delivers events to listener", () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    bus.subscribe("session-1", (event) => received.push(event));
    bus.emit("session-1", { type: "status_change", status: "streaming" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("status_change");
  });

  test("events are scoped to session ID", () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    bus.subscribe("session-1", (event) => received.push(event));
    bus.emit("session-2", { type: "status_change", status: "streaming" });

    expect(received).toHaveLength(0);
  });

  test("multiple listeners on same session receive events", () => {
    const bus = new EventBus();
    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    bus.subscribe("s-1", (event) => received1.push(event));
    bus.subscribe("s-1", (event) => received2.push(event));

    bus.emit("s-1", { type: "status_change", status: "idle" });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  test("unsubscribe stops receiving events", () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    const unsub = bus.subscribe("s-1", (event) => received.push(event));
    bus.emit("s-1", { type: "status_change", status: "streaming" });
    expect(received).toHaveLength(1);

    unsub();
    bus.emit("s-1", { type: "status_change", status: "idle" });
    expect(received).toHaveLength(1); // No new event
  });

  test("hasListeners returns true when session has subscribers", () => {
    const bus = new EventBus();
    expect(bus.hasListeners("s-1")).toBe(false);

    const unsub = bus.subscribe("s-1", () => {});
    expect(bus.hasListeners("s-1")).toBe(true);

    unsub();
    expect(bus.hasListeners("s-1")).toBe(false);
  });

  test("emit with no listeners does not throw", () => {
    const bus = new EventBus();
    expect(() => {
      bus.emit("nonexistent", { type: "status_change", status: "idle" });
    }).not.toThrow();
  });

  test("delivers multiple event types correctly", () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];

    bus.subscribe("s-1", (event) => received.push(event));

    bus.emit("s-1", { type: "status_change", status: "streaming" });
    bus.emit("s-1", { type: "content_delta", delta: "Hi", content: "Hi" });
    bus.emit("s-1", {
      type: "turn_complete",
      message: { id: "m1", role: "assistant", content: "Hi", timestamp: Date.now() },
    });

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe("status_change");
    expect(received[1].type).toBe("content_delta");
    expect(received[2].type).toBe("turn_complete");
  });
});
