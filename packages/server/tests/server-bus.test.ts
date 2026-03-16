import { describe, test, expect } from "vitest";
import { ServerBus } from "../src/server-bus.js";
import type { ChannelScope, ServerEvent } from "../src/server-bus.js";
import type { AgentEvent, WorkspaceEvent } from "@molf-ai/protocol";

function agentEvent(type: "status_change" | "content_delta" | "error" = "status_change"): AgentEvent {
  switch (type) {
    case "content_delta":
      return { type: "content_delta", delta: "hi", content: "hi" } as AgentEvent;
    case "error":
      return { type: "error", code: "test", message: "test error" } as AgentEvent;
    default:
      return { type: "status_change", status: "idle" } as AgentEvent;
  }
}

function workspaceEvent(): WorkspaceEvent {
  return { type: "session_created", sessionId: "s1", sessionName: "test" };
}

function configEvent(): ServerEvent {
  return { type: "config_changed", changedKeys: ["theme"] };
}

// ---------------------------------------------------------------------------
// Scope-based subscribe / emit
// ---------------------------------------------------------------------------

describe("ServerBus scope-based API", () => {
  test("subscribe and emit to session scope", () => {
    const bus = new ServerBus();
    const events: ServerEvent[] = [];
    const scope: ChannelScope = { type: "session", sessionId: "s1" };

    bus.subscribe(scope, (e) => events.push(e));
    bus.emit(scope, agentEvent("content_delta"));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("content_delta");
  });

  test("subscribe and emit to global scope", () => {
    const bus = new ServerBus();
    const events: ServerEvent[] = [];
    const scope: ChannelScope = { type: "global" };

    bus.subscribe(scope, (e) => events.push(e));
    bus.emit(scope, configEvent());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("config_changed");
  });

  test("subscribe and emit to workspace scope", () => {
    const bus = new ServerBus();
    const events: ServerEvent[] = [];
    const scope: ChannelScope = { type: "workspace", workerId: "w1", workspaceId: "ws1" };

    bus.subscribe(scope, (e) => events.push(e));
    bus.emit(scope, workspaceEvent());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_created");
  });

  test("subscribe and emit to worker scope", () => {
    const bus = new ServerBus();
    const events: ServerEvent[] = [];
    const scope: ChannelScope = { type: "worker", workerId: "w1" };

    bus.subscribe(scope, (e) => events.push(e));
    bus.emit(scope, configEvent());

    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe("ServerBus scope isolation", () => {
  test("emitting to session X does not reach session Y", () => {
    const bus = new ServerBus();
    const eventsX: ServerEvent[] = [];
    const eventsY: ServerEvent[] = [];

    bus.subscribe({ type: "session", sessionId: "x" }, (e) => eventsX.push(e));
    bus.subscribe({ type: "session", sessionId: "y" }, (e) => eventsY.push(e));

    bus.emit({ type: "session", sessionId: "x" }, agentEvent());

    expect(eventsX).toHaveLength(1);
    expect(eventsY).toHaveLength(0);
  });

  test("emitting to session does not reach global", () => {
    const bus = new ServerBus();
    const globalEvents: ServerEvent[] = [];
    const sessionEvents: ServerEvent[] = [];

    bus.subscribe({ type: "global" }, (e) => globalEvents.push(e));
    bus.subscribe({ type: "session", sessionId: "s1" }, (e) => sessionEvents.push(e));

    bus.emit({ type: "session", sessionId: "s1" }, agentEvent());

    expect(sessionEvents).toHaveLength(1);
    expect(globalEvents).toHaveLength(0);
  });

  test("emitting to global does not reach sessions", () => {
    const bus = new ServerBus();
    const globalEvents: ServerEvent[] = [];
    const sessionEvents: ServerEvent[] = [];

    bus.subscribe({ type: "global" }, (e) => globalEvents.push(e));
    bus.subscribe({ type: "session", sessionId: "s1" }, (e) => sessionEvents.push(e));

    bus.emit({ type: "global" }, configEvent());

    expect(globalEvents).toHaveLength(1);
    expect(sessionEvents).toHaveLength(0);
  });

  test("workspace scope is isolated by workerId and workspaceId", () => {
    const bus = new ServerBus();
    const eventsA: ServerEvent[] = [];
    const eventsB: ServerEvent[] = [];

    bus.subscribe({ type: "workspace", workerId: "w1", workspaceId: "ws1" }, (e) => eventsA.push(e));
    bus.subscribe({ type: "workspace", workerId: "w1", workspaceId: "ws2" }, (e) => eventsB.push(e));

    bus.emit({ type: "workspace", workerId: "w1", workspaceId: "ws1" }, workspaceEvent());

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(0);
  });

  test("worker scope is isolated from workspace scope", () => {
    const bus = new ServerBus();
    const workerEvents: ServerEvent[] = [];
    const workspaceEvents: ServerEvent[] = [];

    bus.subscribe({ type: "worker", workerId: "w1" }, (e) => workerEvents.push(e));
    bus.subscribe({ type: "workspace", workerId: "w1", workspaceId: "ws1" }, (e) => workspaceEvents.push(e));

    bus.emit({ type: "worker", workerId: "w1" }, configEvent());

    expect(workerEvents).toHaveLength(1);
    expect(workspaceEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasListeners
// ---------------------------------------------------------------------------

describe("ServerBus hasListeners", () => {
  test("returns true when scope has listeners", () => {
    const bus = new ServerBus();
    bus.subscribe({ type: "global" }, () => {});
    expect(bus.hasListeners({ type: "global" })).toBe(true);
  });

  test("returns false when scope has no listeners", () => {
    const bus = new ServerBus();
    expect(bus.hasListeners({ type: "global" })).toBe(false);
  });

  test("returns false after all listeners unsubscribed", () => {
    const bus = new ServerBus();
    const unsub1 = bus.subscribe({ type: "session", sessionId: "s1" }, () => {});
    const unsub2 = bus.subscribe({ type: "session", sessionId: "s1" }, () => {});
    unsub1();
    unsub2();
    expect(bus.hasListeners({ type: "session", sessionId: "s1" })).toBe(false);
  });

  test("hasListeners works with session scope", () => {
    const bus = new ServerBus();
    bus.subscribe({ type: "session", sessionId: "s1" }, () => {});
    expect(bus.hasListeners({ type: "session", sessionId: "s1" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe cleanup
// ---------------------------------------------------------------------------

describe("ServerBus unsubscribe", () => {
  test("unsubscribed listener stops receiving events", () => {
    const bus = new ServerBus();
    const events: ServerEvent[] = [];
    const scope: ChannelScope = { type: "session", sessionId: "s1" };

    const unsub = bus.subscribe(scope, (e) => events.push(e));
    bus.emit(scope, agentEvent());
    expect(events).toHaveLength(1);

    unsub();
    bus.emit(scope, agentEvent());
    expect(events).toHaveLength(1);
  });

  test("unsubscribe one listener does not affect others on same scope", () => {
    const bus = new ServerBus();
    const eventsA: ServerEvent[] = [];
    const eventsB: ServerEvent[] = [];
    const scope: ChannelScope = { type: "global" };

    const unsubA = bus.subscribe(scope, (e) => eventsA.push(e));
    bus.subscribe(scope, (e) => eventsB.push(e));

    unsubA();
    bus.emit(scope, configEvent());

    expect(eventsA).toHaveLength(0);
    expect(eventsB).toHaveLength(1);
  });

  test("double unsubscribe is safe", () => {
    const bus = new ServerBus();
    const unsub = bus.subscribe({ type: "global" }, () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

describe("ServerBus error isolation", () => {
  test("throwing listener does not prevent other listeners from receiving event", () => {
    const bus = new ServerBus();
    const events: ServerEvent[] = [];
    const scope: ChannelScope = { type: "session", sessionId: "s1" };

    bus.subscribe(scope, () => {
      throw new Error("listener exploded");
    });
    bus.subscribe(scope, (e) => events.push(e));

    bus.emit(scope, agentEvent());

    expect(events).toHaveLength(1);
  });

  test("throwing listener does not cause emit to throw", () => {
    const bus = new ServerBus();
    const scope: ChannelScope = { type: "global" };

    bus.subscribe(scope, () => {
      throw new Error("kaboom");
    });

    expect(() => bus.emit(scope, configEvent())).not.toThrow();
  });

  test("all healthy listeners receive event even when middle listener throws", () => {
    const bus = new ServerBus();
    const received: string[] = [];
    const scope: ChannelScope = { type: "worker", workerId: "w1" };

    bus.subscribe(scope, () => received.push("first"));
    bus.subscribe(scope, () => {
      throw new Error("middle exploded");
    });
    bus.subscribe(scope, () => received.push("third"));

    bus.emit(scope, configEvent());

    expect(received).toEqual(["first", "third"]);
  });
});

// ---------------------------------------------------------------------------
// Global scope works independently
// ---------------------------------------------------------------------------

describe("ServerBus global scope", () => {
  test("multiple listeners on global scope all receive events", () => {
    const bus = new ServerBus();
    const eventsA: ServerEvent[] = [];
    const eventsB: ServerEvent[] = [];
    const scope: ChannelScope = { type: "global" };

    bus.subscribe(scope, (e) => eventsA.push(e));
    bus.subscribe(scope, (e) => eventsB.push(e));

    bus.emit(scope, configEvent());

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
  });

  test("emit to global with no listeners does not throw", () => {
    const bus = new ServerBus();
    expect(() => bus.emit({ type: "global" }, configEvent())).not.toThrow();
  });

  test("global hasListeners returns false when empty", () => {
    const bus = new ServerBus();
    expect(bus.hasListeners({ type: "global" })).toBe(false);
  });
});

