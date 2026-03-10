import { describe, test, expect, vi, afterEach } from "vitest";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { TextArea } from "../src/components/text-area.js";

import { flushAsync } from "@molf-ai/test-utils";

/** Flush React/Ink state updates between interactions. */
const tick = () => flushAsync();

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("TextArea", () => {
  describe("rendering", () => {
    test("renders placeholder when value is empty and active", () => {
      const inst = render(
        <TextArea
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          placeholder="Type a message..."
        />,
      );
      unmount = inst.unmount;
      const frame = inst.lastFrame()!;
      // Placeholder should be visible (first char inverse, rest dimmed)
      expect(frame).toContain("ype a message...");
    });

    test("renders value text", () => {
      const inst = render(
        <TextArea
          value="hello"
          onChange={() => {}}
          onSubmit={() => {}}
        />,
      );
      unmount = inst.unmount;
      const frame = inst.lastFrame()!;
      expect(frame).toContain("hello");
    });

    test("renders multiline text as multiple lines", () => {
      const inst = render(
        <TextArea
          value={"line1\nline2\nline3"}
          onChange={() => {}}
          onSubmit={() => {}}
        />,
      );
      unmount = inst.unmount;
      const frame = inst.lastFrame()!;
      expect(frame).toContain("line1");
      expect(frame).toContain("line2");
      expect(frame).toContain("line3");
    });

    test("renders dimmed placeholder when not active", () => {
      const inst = render(
        <TextArea
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          isActive={false}
          placeholder="Type here..."
        />,
      );
      unmount = inst.unmount;
      const frame = inst.lastFrame()!;
      expect(frame).toContain("Type here...");
    });
  });

  describe("text input", () => {
    test("typing updates value via onChange", async () => {
      const onChange = vi.fn(() => {});
      const inst = render(
        <TextArea
          value=""
          onChange={onChange}
          onSubmit={() => {}}
        />,
      );
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("h");
      await tick();
      expect(onChange).toHaveBeenCalledWith("h");
    });

    test("paste with multiple characters", async () => {
      const onChange = vi.fn(() => {});
      const inst = render(
        <TextArea
          value=""
          onChange={onChange}
          onSubmit={() => {}}
        />,
      );
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("hello");
      await tick();
      expect(onChange).toHaveBeenCalledWith("hello");
    });

    test("enter calls onSubmit with current text", async () => {
      const onSubmit = vi.fn(() => {});
      const inst = render(
        <TextArea
          value="test message"
          onChange={() => {}}
          onSubmit={onSubmit}
        />,
      );
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("\r");
      await tick();
      expect(onSubmit).toHaveBeenCalledWith("test message");
    });

    test("backspace deletes character", async () => {
      const onChange = vi.fn(() => {});
      function Controlled() {
        const [val, setVal] = useState("abc");
        return (
          <TextArea
            value={val}
            onChange={(v) => { setVal(v); onChange(v); }}
            onSubmit={() => {}}
          />
        );
      }
      const inst = render(<Controlled />);
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("\x7f");
      await tick();
      expect(onChange).toHaveBeenCalledWith("ab");
    });
  });

  describe("keyboard shortcuts", () => {
    test("Ctrl+A moves to line start, then typing inserts at start", async () => {
      const onChange = vi.fn(() => {});
      function Controlled() {
        const [val, setVal] = useState("hello");
        return (
          <TextArea
            value={val}
            onChange={(v) => { setVal(v); onChange(v); }}
            onSubmit={() => {}}
          />
        );
      }
      const inst = render(<Controlled />);
      unmount = inst.unmount;
      await tick();
      // Ctrl+A
      inst.stdin.write("\x01");
      await tick();
      // Type character at start
      inst.stdin.write("X");
      await tick();
      expect(onChange).toHaveBeenCalledWith("Xhello");
    });

    test("Ctrl+E moves to line end", async () => {
      const onChange = vi.fn(() => {});
      function Controlled() {
        const [val, setVal] = useState("hello");
        return (
          <TextArea
            value={val}
            onChange={(v) => { setVal(v); onChange(v); }}
            onSubmit={() => {}}
          />
        );
      }
      const inst = render(<Controlled />);
      unmount = inst.unmount;
      await tick();
      // Ctrl+A to go to start, then Ctrl+E to go to end
      inst.stdin.write("\x01");
      await tick();
      inst.stdin.write("\x05");
      await tick();
      inst.stdin.write("X");
      await tick();
      expect(onChange).toHaveBeenCalledWith("helloX");
    });

    test("Ctrl+K deletes to end of line", async () => {
      const onChange = vi.fn(() => {});
      function Controlled() {
        const [val, setVal] = useState("hello world");
        return (
          <TextArea
            value={val}
            onChange={(v) => { setVal(v); onChange(v); }}
            onSubmit={() => {}}
          />
        );
      }
      const inst = render(<Controlled />);
      unmount = inst.unmount;
      await tick();
      // Move to start first
      inst.stdin.write("\x01");
      await tick();
      // Move right 5 times
      for (let i = 0; i < 5; i++) {
        inst.stdin.write("\x1b[C");
        await tick();
      }
      await tick();
      // Ctrl+K
      inst.stdin.write("\x0b");
      await tick();
      expect(onChange).toHaveBeenCalledWith("hello");
    });

    test("Ctrl+U deletes to start of line", async () => {
      const onChange = vi.fn(() => {});
      function Controlled() {
        const [val, setVal] = useState("hello world");
        return (
          <TextArea
            value={val}
            onChange={(v) => { setVal(v); onChange(v); }}
            onSubmit={() => {}}
          />
        );
      }
      const inst = render(<Controlled />);
      unmount = inst.unmount;
      await tick();
      // Move to start
      inst.stdin.write("\x01");
      await tick();
      // Move right 5 times
      for (let i = 0; i < 5; i++) {
        inst.stdin.write("\x1b[C");
        await tick();
      }
      await tick();
      // Ctrl+U
      inst.stdin.write("\x15");
      await tick();
      expect(onChange).toHaveBeenCalledWith(" world");
    });
  });

  describe("overflow callbacks", () => {
    test("up arrow on single line fires onOverflowUp", async () => {
      const onOverflowUp = vi.fn(() => {});
      const inst = render(
        <TextArea
          value="hello"
          onChange={() => {}}
          onSubmit={() => {}}
          onOverflowUp={onOverflowUp}
        />,
      );
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("\x1b[A");
      await tick();
      expect(onOverflowUp).toHaveBeenCalled();
    });

    test("down arrow on single line fires onOverflowDown", async () => {
      const onOverflowDown = vi.fn(() => {});
      const inst = render(
        <TextArea
          value="hello"
          onChange={() => {}}
          onSubmit={() => {}}
          onOverflowDown={onOverflowDown}
        />,
      );
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("\x1b[B");
      await tick();
      expect(onOverflowDown).toHaveBeenCalled();
    });

    test("up arrow on multiline does NOT fire overflow when not on first line", async () => {
      const onOverflowUp = vi.fn(() => {});
      const val = "line1\nline2";
      const inst = render(
        <TextArea
          value={val}
          onChange={() => {}}
          onSubmit={() => {}}
          onOverflowUp={onOverflowUp}
        />,
      );
      unmount = inst.unmount;
      await tick();
      // Cursor starts at end (row 1), so up arrow moves to row 0 — no overflow
      inst.stdin.write("\x1b[A");
      await tick();
      expect(onOverflowUp).not.toHaveBeenCalled();
    });
  });

  describe("isActive", () => {
    test("does not respond to input when isActive is false", async () => {
      const onChange = vi.fn(() => {});
      const onSubmit = vi.fn(() => {});
      const inst = render(
        <TextArea
          value="hello"
          onChange={onChange}
          onSubmit={onSubmit}
          isActive={false}
        />,
      );
      unmount = inst.unmount;
      await tick();
      inst.stdin.write("x");
      await tick();
      inst.stdin.write("\r");
      await tick();
      expect(onChange).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
