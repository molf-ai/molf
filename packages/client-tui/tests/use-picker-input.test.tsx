import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { flushAsync } from "@molf-ai/test-utils";
import { usePickerInput } from "../src/hooks/use-picker-input.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

function Harness(props: {
  moveUp: () => void;
  moveDown: () => void;
  onEscape: () => void;
  onEnter?: () => void;
  onKey?: (input: string, key: any) => boolean | void;
  isActive?: boolean;
}) {
  usePickerInput({
    list: { moveUp: props.moveUp, moveDown: props.moveDown },
    onEscape: props.onEscape,
    onEnter: props.onEnter,
    onKey: props.onKey,
    isActive: props.isActive,
  });
  return <Text>picker</Text>;
}

describe("usePickerInput", () => {
  test("calls moveUp on up arrow", async () => {
    const moveUp = vi.fn();
    const inst = render(
      <Harness moveUp={moveUp} moveDown={vi.fn()} onEscape={vi.fn()} />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b[A"); // Up arrow
    await tick();
    expect(moveUp).toHaveBeenCalled();
  });

  test("calls moveDown on down arrow", async () => {
    const moveDown = vi.fn();
    const inst = render(
      <Harness moveUp={vi.fn()} moveDown={moveDown} onEscape={vi.fn()} />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b[B"); // Down arrow
    await tick();
    expect(moveDown).toHaveBeenCalled();
  });

  test("calls onEscape on escape", async () => {
    const onEscape = vi.fn();
    const inst = render(
      <Harness moveUp={vi.fn()} moveDown={vi.fn()} onEscape={onEscape} />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b"); // Escape
    await tick();
    expect(onEscape).toHaveBeenCalled();
  });

  test("calls onEnter on return key", async () => {
    const onEnter = vi.fn();
    const inst = render(
      <Harness moveUp={vi.fn()} moveDown={vi.fn()} onEscape={vi.fn()} onEnter={onEnter} />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\r"); // Enter
    await tick();
    expect(onEnter).toHaveBeenCalled();
  });

  test("onKey callback can intercept keys", async () => {
    const moveUp = vi.fn();
    const onKey = vi.fn(() => true); // returning true = handled
    const inst = render(
      <Harness moveUp={moveUp} moveDown={vi.fn()} onEscape={vi.fn()} onKey={onKey} />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("r");
    await tick();
    expect(onKey).toHaveBeenCalled();
  });

  test("ignores all input when isActive is false", async () => {
    const moveUp = vi.fn();
    const onEscape = vi.fn();
    const inst = render(
      <Harness moveUp={moveUp} moveDown={vi.fn()} onEscape={onEscape} isActive={false} />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b[A"); // Up arrow
    await tick();
    inst.stdin.write("\x1b"); // Escape
    await tick();
    expect(moveUp).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });
});
