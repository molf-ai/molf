import { describe, test, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/components/status-bar.js";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe("StatusBar", () => {
  test("renders nothing when idle and no shell", () => {
    const inst = render(<StatusBar status="idle" />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toBe("");
  });

  test("shows thinking label when streaming", () => {
    const inst = render(<StatusBar status="streaming" />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Thinking...");
  });

  test("shows running tool label", () => {
    const inst = render(<StatusBar status="executing_tool" />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Running tool...");
  });

  test("shows error label", () => {
    const inst = render(<StatusBar status="error" />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("An error occurred");
  });

  test("shows aborted label", () => {
    const inst = render(<StatusBar status="aborted" />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Aborted");
  });

  test("shows shell running when idle with shell", () => {
    const inst = render(<StatusBar status="idle" shellRunning={true} />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Running shell command");
  });
});
