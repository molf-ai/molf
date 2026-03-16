import { describe, test, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { ScrollHints } from "../src/components/scroll-hints.js";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe("ScrollHints", () => {
  test("renders children without hints when nothing is hidden", () => {
    const inst = render(
      <ScrollHints hiddenAbove={0} hiddenBelow={0}>
        <Text>item 1</Text>
      </ScrollHints>,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).toContain("item 1");
    expect(frame).not.toContain("↑");
    expect(frame).not.toContain("↓");
  });

  test("renders up arrow with count when items hidden above", () => {
    const inst = render(
      <ScrollHints hiddenAbove={3} hiddenBelow={0}>
        <Text>content</Text>
      </ScrollHints>,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).toContain("↑ 3 more");
    expect(frame).not.toContain("↓");
  });

  test("renders down arrow with count when items hidden below", () => {
    const inst = render(
      <ScrollHints hiddenAbove={0} hiddenBelow={5}>
        <Text>content</Text>
      </ScrollHints>,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).not.toContain("↑");
    expect(frame).toContain("↓ 5 more");
  });

  test("renders both arrows when items hidden above and below", () => {
    const inst = render(
      <ScrollHints hiddenAbove={2} hiddenBelow={7}>
        <Text>content</Text>
      </ScrollHints>,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).toContain("↑ 2 more");
    expect(frame).toContain("↓ 7 more");
  });
});
