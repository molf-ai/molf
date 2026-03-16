import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { WorkerPicker } from "../src/components/worker-picker.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeWorker = (id: string, name: string, connected = true) => ({
  workerId: id,
  name,
  connected,
  tools: [{ name: "tool1", description: "desc" }],
});

describe("WorkerPicker", () => {
  test("shows loading state initially", () => {
    const inst = render(
      <WorkerPicker
        listWorkers={() => new Promise(() => {})}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentWorkerId={null}
      />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Loading");
  });

  test("renders worker list after loading", async () => {
    const listWorkers = vi.fn().mockResolvedValue([
      makeWorker("w1", "Worker 1"),
      makeWorker("w2", "Worker 2"),
    ]);
    const inst = render(
      <WorkerPicker listWorkers={listWorkers} onSelect={vi.fn()} onCancel={vi.fn()} currentWorkerId={null} />,
    );
    unmount = inst.unmount;
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Worker 1");
    expect(frame).toContain("Worker 2");
  });

  test("shows empty state when no workers", async () => {
    const inst = render(
      <WorkerPicker listWorkers={vi.fn().mockResolvedValue([])} onSelect={vi.fn()} onCancel={vi.fn()} currentWorkerId={null} />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("No workers connected");
  });

  test("Escape calls onCancel", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <WorkerPicker
        listWorkers={vi.fn().mockResolvedValue([makeWorker("w1", "Worker 1")])}
        onSelect={vi.fn()}
        onCancel={onCancel}
        currentWorkerId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("Enter selects connected worker", async () => {
    const onSelect = vi.fn();
    const inst = render(
      <WorkerPicker
        listWorkers={vi.fn().mockResolvedValue([makeWorker("w1", "Worker 1")])}
        onSelect={onSelect}
        onCancel={vi.fn()}
        currentWorkerId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenCalledWith("w1");
  });

  test("Enter does not select offline worker", async () => {
    const onSelect = vi.fn();
    const inst = render(
      <WorkerPicker
        listWorkers={vi.fn().mockResolvedValue([makeWorker("w1", "Worker 1", false)])}
        onSelect={onSelect}
        onCancel={vi.fn()}
        currentWorkerId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\r");
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("shows offline badge", async () => {
    const inst = render(
      <WorkerPicker
        listWorkers={vi.fn().mockResolvedValue([makeWorker("w1", "Worker 1", false)])}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentWorkerId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("[offline]");
  });

  test("shows current badge", async () => {
    const inst = render(
      <WorkerPicker
        listWorkers={vi.fn().mockResolvedValue([makeWorker("w1", "Worker 1")])}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        currentWorkerId="w1"
      />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("[current]");
  });

  test("down arrow navigates selection", async () => {
    const onSelect = vi.fn();
    const inst = render(
      <WorkerPicker
        listWorkers={vi.fn().mockResolvedValue([makeWorker("w1", "Worker 1"), makeWorker("w2", "Worker 2")])}
        onSelect={onSelect}
        onCancel={vi.fn()}
        currentWorkerId={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b[B"); // Down
    await tick();
    inst.stdin.write("\r"); // Enter
    await tick();
    expect(onSelect).toHaveBeenCalledWith("w2");
  });
});
