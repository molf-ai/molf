import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { ToolApprovalPrompt } from "../src/components/tool-approval-prompt.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeApproval = (id: string, toolName: string) => ({
  approvalId: id,
  toolName,
  arguments: '{"path": "/tmp"}',
});

describe("ToolApprovalPrompt", () => {
  test("renders nothing when no approvals", () => {
    const inst = render(
      <ToolApprovalPrompt approvals={[]} onApprove={vi.fn()} onAlwaysApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toBe("");
  });

  test("shows tool name and arguments", () => {
    const inst = render(
      <ToolApprovalPrompt
        approvals={[makeApproval("a1", "write_file")]}
        onApprove={vi.fn()}
        onAlwaysApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).toContain("write_file");
    expect(frame).toContain("/tmp");
  });

  test("Y approves", async () => {
    const onApprove = vi.fn();
    const inst = render(
      <ToolApprovalPrompt
        approvals={[makeApproval("a1", "write_file")]}
        onApprove={onApprove}
        onAlwaysApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("y");
    await tick();
    expect(onApprove).toHaveBeenCalledWith("a1");
  });

  test("A always approves", async () => {
    const onAlwaysApprove = vi.fn();
    const inst = render(
      <ToolApprovalPrompt
        approvals={[makeApproval("a1", "write_file")]}
        onApprove={vi.fn()}
        onAlwaysApprove={onAlwaysApprove}
        onDeny={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("a");
    await tick();
    expect(onAlwaysApprove).toHaveBeenCalledWith("a1");
  });

  test("N enters feedback mode, Enter denies with feedback", async () => {
    const onDeny = vi.fn();
    const inst = render(
      <ToolApprovalPrompt
        approvals={[makeApproval("a1", "write_file")]}
        onApprove={vi.fn()}
        onAlwaysApprove={vi.fn()}
        onDeny={onDeny}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("n");
    await tick();
    expect(inst.lastFrame()).toContain("feedback");
    inst.stdin.write("bad idea");
    await tick();
    inst.stdin.write("\r");
    await tick();
    expect(onDeny).toHaveBeenCalledWith("a1", "bad idea");
  });

  test("N then Enter without text denies with no feedback", async () => {
    const onDeny = vi.fn();
    const inst = render(
      <ToolApprovalPrompt
        approvals={[makeApproval("a1", "write_file")]}
        onApprove={vi.fn()}
        onAlwaysApprove={vi.fn()}
        onDeny={onDeny}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("n");
    await tick();
    inst.stdin.write("\r");
    await tick();
    expect(onDeny).toHaveBeenCalledWith("a1", undefined);
  });
});
