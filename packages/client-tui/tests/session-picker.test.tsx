import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { SessionPicker } from "../src/components/session-picker.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeSession = (id: string, name: string) => ({
  sessionId: id,
  name,
  messageCount: 5,
  lastActiveAt: Date.now(),
  lastMessage: "Hello world",
  active: false,
});

describe("SessionPicker", () => {
  test("shows loading state", () => {
    const inst = render(
      <SessionPicker
        listSessions={() => new Promise(() => {})}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentSessionId={null}
      />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Loading");
  });

  test("renders sessions after loading", async () => {
    const inst = render(
      <SessionPicker
        listSessions={vi.fn().mockResolvedValue([makeSession("s1", "Session A"), makeSession("s2", "Session B")])}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentSessionId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Session A");
    expect(frame).toContain("Session B");
  });

  test("shows empty state", async () => {
    const inst = render(
      <SessionPicker
        listSessions={vi.fn().mockResolvedValue([])}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentSessionId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("No sessions found");
  });

  test("Enter selects session", async () => {
    const onSelect = vi.fn();
    const inst = render(
      <SessionPicker
        listSessions={vi.fn().mockResolvedValue([makeSession("s1", "Session A")])}
        onSelect={onSelect}
        onCancel={vi.fn()}
        currentSessionId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  test("Escape calls onCancel when no search", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <SessionPicker
        listSessions={vi.fn().mockResolvedValue([makeSession("s1", "Session A")])}
        onSelect={vi.fn()}
        onCancel={onCancel}
        currentSessionId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("shows current badge", async () => {
    const inst = render(
      <SessionPicker
        listSessions={vi.fn().mockResolvedValue([makeSession("s1", "Session A")])}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentSessionId="s1"
      />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("[current]");
  });
});
