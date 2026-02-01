import { describe, test, expect, mock, afterEach } from "bun:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { TextArea } from "../src/components/text-area.js";

// Helper: waits for async state updates to flush
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK = 100;

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
      const onChange = mock(() => {});
      const inst = render(
        <TextArea
          value=""
          onChange={onChange}
          onSubmit={() => {}}
        />,
      );
      unmount = inst.unmount;
      await delay(TICK);
      inst.stdin.write("h");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith("h");
    });

    test("paste with multiple characters", async () => {
      const onChange = mock(() => {});
      const inst = render(
        <TextArea
          value=""
          onChange={onChange}
          onSubmit={() => {}}
        />,
      );
      unmount = inst.unmount;
      await delay(TICK);
      inst.stdin.write("hello");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith("hello");
    });

    test("enter calls onSubmit with current text", async () => {
      const onSubmit = mock(() => {});
      const inst = render(
        <TextArea
          value="test message"
          onChange={() => {}}
          onSubmit={onSubmit}
        />,
      );
      unmount = inst.unmount;
      await delay(TICK);
      inst.stdin.write("\r");
      await delay(TICK);
      expect(onSubmit).toHaveBeenCalledWith("test message");
    });

    test("backspace deletes character", async () => {
      const onChange = mock(() => {});
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
      await delay(TICK);
      inst.stdin.write("\x7f");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith("ab");
    });
  });

  describe("keyboard shortcuts", () => {
    test("Ctrl+A moves to line start, then typing inserts at start", async () => {
      const onChange = mock(() => {});
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
      await delay(TICK);
      // Ctrl+A
      inst.stdin.write("\x01");
      await delay(TICK);
      // Type character at start
      inst.stdin.write("X");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith("Xhello");
    });

    test("Ctrl+E moves to line end", async () => {
      const onChange = mock(() => {});
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
      await delay(TICK);
      // Ctrl+A to go to start, then Ctrl+E to go to end
      inst.stdin.write("\x01");
      await delay(TICK);
      inst.stdin.write("\x05");
      await delay(TICK);
      inst.stdin.write("X");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith("helloX");
    });

    test("Ctrl+K deletes to end of line", async () => {
      const onChange = mock(() => {});
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
      await delay(TICK);
      // Move to start first
      inst.stdin.write("\x01");
      await delay(TICK);
      // Move right 5 times
      for (let i = 0; i < 5; i++) {
        inst.stdin.write("\x1b[C");
        await delay(30);
      }
      await delay(TICK);
      // Ctrl+K
      inst.stdin.write("\x0b");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith("hello");
    });

    test("Ctrl+U deletes to start of line", async () => {
      const onChange = mock(() => {});
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
      await delay(TICK);
      // Move to start
      inst.stdin.write("\x01");
      await delay(TICK);
      // Move right 5 times
      for (let i = 0; i < 5; i++) {
        inst.stdin.write("\x1b[C");
        await delay(30);
      }
      await delay(TICK);
      // Ctrl+U
      inst.stdin.write("\x15");
      await delay(TICK);
      expect(onChange).toHaveBeenCalledWith(" world");
    });
  });

  describe("overflow callbacks", () => {
    test("up arrow on single line fires onOverflowUp", async () => {
      const onOverflowUp = mock(() => {});
      const inst = render(
        <TextArea
          value="hello"
          onChange={() => {}}
          onSubmit={() => {}}
          onOverflowUp={onOverflowUp}
        />,
      );
      unmount = inst.unmount;
      await delay(TICK);
      inst.stdin.write("\x1b[A");
      await delay(TICK);
      expect(onOverflowUp).toHaveBeenCalled();
    });

    test("down arrow on single line fires onOverflowDown", async () => {
      const onOverflowDown = mock(() => {});
      const inst = render(
        <TextArea
          value="hello"
          onChange={() => {}}
          onSubmit={() => {}}
          onOverflowDown={onOverflowDown}
        />,
      );
      unmount = inst.unmount;
      await delay(TICK);
      inst.stdin.write("\x1b[B");
      await delay(TICK);
      expect(onOverflowDown).toHaveBeenCalled();
    });

    test("up arrow on multiline does NOT fire overflow when not on first line", async () => {
      const onOverflowUp = mock(() => {});
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
      await delay(TICK);
      // Cursor starts at end (row 1), so up arrow moves to row 0 — no overflow
      inst.stdin.write("\x1b[A");
      await delay(TICK);
      expect(onOverflowUp).not.toHaveBeenCalled();
    });
  });

  describe("isActive", () => {
    test("does not respond to input when isActive is false", async () => {
      const onChange = mock(() => {});
      const onSubmit = mock(() => {});
      const inst = render(
        <TextArea
          value="hello"
          onChange={onChange}
          onSubmit={onSubmit}
          isActive={false}
        />,
      );
      unmount = inst.unmount;
      await delay(TICK);
      inst.stdin.write("x");
      await delay(TICK);
      inst.stdin.write("\r");
      await delay(TICK);
      expect(onChange).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
