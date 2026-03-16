import { describe, test, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { StreamingResponse } from "../src/components/streaming-response.js";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe("StreamingResponse", () => {
  test("renders nothing when not visible", () => {
    const inst = render(<StreamingResponse content="hello" visible={false} />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toBe("");
  });

  test("renders nothing when content is empty", () => {
    const inst = render(<StreamingResponse content="" visible={true} />);
    unmount = inst.unmount;
    expect(inst.lastFrame()).toBe("");
  });

  test("renders content when visible", () => {
    const inst = render(<StreamingResponse content="Hello world" visible={true} />);
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Molf");
    expect(frame).toContain("Hello world");
  });
});
