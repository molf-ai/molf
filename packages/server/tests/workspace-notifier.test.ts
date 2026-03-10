import { describe, test, expect } from "vitest";
import { WorkspaceNotifier } from "../src/workspace-notifier.js";
import type { WorkspaceEvent } from "@molf-ai/protocol";

function makeEvent(type: "session_created" | "config_changed" | "cron_fired" = "session_created"): WorkspaceEvent {
  switch (type) {
    case "config_changed":
      return { type: "config_changed", config: {} } as WorkspaceEvent;
    case "cron_fired":
      return { type: "cron_fired", jobId: "j1", jobName: "test", targetSessionId: "s1" } as WorkspaceEvent;
    default:
      return { type: "session_created", sessionId: "s1", sessionName: "Test" } as WorkspaceEvent;
  }
}

describe("WorkspaceNotifier", () => {
  test("subscriber receives emitted events", () => {
    const notifier = new WorkspaceNotifier();
    const received: WorkspaceEvent[] = [];

    notifier.subscribe("w1", "ws1", (e) => received.push(e));
    const event = makeEvent();
    notifier.emit("w1", "ws1", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  test("multiple subscribers all receive events", () => {
    const notifier = new WorkspaceNotifier();
    const a: WorkspaceEvent[] = [];
    const b: WorkspaceEvent[] = [];

    notifier.subscribe("w1", "ws1", (e) => a.push(e));
    notifier.subscribe("w1", "ws1", (e) => b.push(e));
    notifier.emit("w1", "ws1", makeEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("emit to non-subscribed namespace does not crash", () => {
    const notifier = new WorkspaceNotifier();
    expect(() => notifier.emit("w1", "ws1", makeEvent())).not.toThrow();
  });

  test("unsubscribe stops delivery", () => {
    const notifier = new WorkspaceNotifier();
    const received: WorkspaceEvent[] = [];

    const unsub = notifier.subscribe("w1", "ws1", (e) => received.push(e));
    notifier.emit("w1", "ws1", makeEvent());
    expect(received).toHaveLength(1);

    unsub();
    notifier.emit("w1", "ws1", makeEvent());
    expect(received).toHaveLength(1);
  });

  test("double unsubscribe is safe", () => {
    const notifier = new WorkspaceNotifier();
    const unsub = notifier.subscribe("w1", "ws1", () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  test("different workers are isolated", () => {
    const notifier = new WorkspaceNotifier();
    const w1Events: WorkspaceEvent[] = [];
    const w2Events: WorkspaceEvent[] = [];

    notifier.subscribe("w1", "ws1", (e) => w1Events.push(e));
    notifier.subscribe("w2", "ws1", (e) => w2Events.push(e));

    notifier.emit("w1", "ws1", makeEvent());

    expect(w1Events).toHaveLength(1);
    expect(w2Events).toHaveLength(0);
  });

  test("different workspaces are isolated", () => {
    const notifier = new WorkspaceNotifier();
    const ws1Events: WorkspaceEvent[] = [];
    const ws2Events: WorkspaceEvent[] = [];

    notifier.subscribe("w1", "ws1", (e) => ws1Events.push(e));
    notifier.subscribe("w1", "ws2", (e) => ws2Events.push(e));

    notifier.emit("w1", "ws1", makeEvent());

    expect(ws1Events).toHaveLength(1);
    expect(ws2Events).toHaveLength(0);
  });

  test("delivers different event types correctly", () => {
    const notifier = new WorkspaceNotifier();
    const received: WorkspaceEvent[] = [];

    notifier.subscribe("w1", "ws1", (e) => received.push(e));
    notifier.emit("w1", "ws1", makeEvent("session_created"));
    notifier.emit("w1", "ws1", makeEvent("config_changed"));
    notifier.emit("w1", "ws1", makeEvent("cron_fired"));

    expect(received).toHaveLength(3);
    expect(received[0].type).toBe("session_created");
    expect(received[1].type).toBe("config_changed");
    expect(received[2].type).toBe("cron_fired");
  });

  test("unsubscribe cleans up empty listener sets", () => {
    const notifier = new WorkspaceNotifier();
    const unsub = notifier.subscribe("w1", "ws1", () => {});
    unsub();

    // Verify internal cleanup by subscribing again and checking it works
    const events: WorkspaceEvent[] = [];
    notifier.subscribe("w1", "ws1", (e) => events.push(e));
    notifier.emit("w1", "ws1", makeEvent());
    expect(events).toHaveLength(1);
  });
});
