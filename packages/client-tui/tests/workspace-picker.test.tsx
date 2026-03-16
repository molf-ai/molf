import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { WorkspacePicker } from "../src/components/workspace-picker.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeWorkspace = (id: string, name: string, sessionCount = 1) => ({
  id,
  name,
  sessions: Array.from({ length: sessionCount }, (_, i) => `s${i}`),
  createdAt: Date.now(),
});

const makeSession = (id: string, name: string) => ({
  sessionId: id,
  name,
  messageCount: 3,
  lastActiveAt: Date.now(),
  isLastSession: false,
});

const defaultProps = {
  listWorkspaceSessions: vi.fn().mockResolvedValue([makeSession("s1", "Session 1")]),
  onSelectSession: vi.fn(),
  onCreateWorkspace: vi.fn().mockResolvedValue(undefined),
  onRenameWorkspace: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn(),
  currentWorkspaceId: null,
  currentSessionId: null,
  workerName: null,
};

describe("WorkspacePicker", () => {
  test("shows loading state", () => {
    const inst = render(
      <WorkspacePicker {...defaultProps} listWorkspaces={() => new Promise(() => {})} />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Loading");
  });

  test("renders workspaces after loading", async () => {
    const inst = render(
      <WorkspacePicker
        {...defaultProps}
        listWorkspaces={vi.fn().mockResolvedValue([makeWorkspace("w1", "Workspace A"), makeWorkspace("w2", "Workspace B")])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Workspace A");
    expect(frame).toContain("Workspace B");
  });

  test("shows empty state", async () => {
    const inst = render(
      <WorkspacePicker {...defaultProps} listWorkspaces={vi.fn().mockResolvedValue([])} />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    expect(inst.lastFrame()).toContain("No workspaces found");
  });

  test("Escape calls onCancel", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <WorkspacePicker
        {...defaultProps}
        onCancel={onCancel}
        listWorkspaces={vi.fn().mockResolvedValue([makeWorkspace("w1", "Workspace A")])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("Enter drills into sessions", async () => {
    const listWorkspaceSessions = vi.fn().mockResolvedValue([makeSession("s1", "Session 1")]);
    const inst = render(
      <WorkspacePicker
        {...defaultProps}
        listWorkspaceSessions={listWorkspaceSessions}
        listWorkspaces={vi.fn().mockResolvedValue([makeWorkspace("w1", "Workspace A")])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\r");
    await tick();
    await tick();
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Session 1");
  });

  test("shows current badge", async () => {
    const inst = render(
      <WorkspacePicker
        {...defaultProps}
        currentWorkspaceId="w1"
        listWorkspaces={vi.fn().mockResolvedValue([makeWorkspace("w1", "Workspace A")])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    expect(inst.lastFrame()).toContain("[current]");
  });
});
