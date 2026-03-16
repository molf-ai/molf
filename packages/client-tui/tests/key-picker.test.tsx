import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { KeyPicker } from "../src/components/key-picker.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeKey = (id: string, name: string, revoked = false) => ({
  id,
  name,
  createdAt: Date.now(),
  revokedAt: revoked ? Date.now() : null,
});

describe("KeyPicker", () => {
  test("shows loading state", () => {
    const inst = render(
      <KeyPicker listApiKeys={() => new Promise(() => {})} onRevoke={vi.fn()} onCancel={vi.fn()} />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Loading");
  });

  test("renders keys after loading", async () => {
    const inst = render(
      <KeyPicker
        listApiKeys={vi.fn().mockResolvedValue([makeKey("k1", "Key 1"), makeKey("k2", "Key 2")])}
        onRevoke={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Key 1");
    expect(frame).toContain("Key 2");
  });

  test("shows empty state", async () => {
    const inst = render(
      <KeyPicker listApiKeys={vi.fn().mockResolvedValue([])} onRevoke={vi.fn()} onCancel={vi.fn()} />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("No API keys");
  });

  test("Escape calls onCancel", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <KeyPicker
        listApiKeys={vi.fn().mockResolvedValue([makeKey("k1", "Key 1")])}
        onRevoke={vi.fn()}
        onCancel={onCancel}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("shows revoked badge", async () => {
    const inst = render(
      <KeyPicker
        listApiKeys={vi.fn().mockResolvedValue([makeKey("k1", "Key 1", true)])}
        onRevoke={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("[revoked]");
  });

  test("shows active badge", async () => {
    const inst = render(
      <KeyPicker
        listApiKeys={vi.fn().mockResolvedValue([makeKey("k1", "Key 1")])}
        onRevoke={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    await tick();
    expect(inst.lastFrame()).toContain("[active]");
  });

  test("Ctrl+R revokes the selected key", async () => {
    const listApiKeys = vi.fn().mockResolvedValue([makeKey("k1", "Key 1")]);
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    const inst = render(
      <KeyPicker listApiKeys={listApiKeys} onRevoke={onRevoke} onCancel={vi.fn()} />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x12"); // Ctrl+R
    await tick();
    expect(onRevoke).toHaveBeenCalledWith("k1");
  });

  test("navigation with arrows", async () => {
    const inst = render(
      <KeyPicker
        listApiKeys={vi.fn().mockResolvedValue([makeKey("k1", "Key 1"), makeKey("k2", "Key 2")])}
        onRevoke={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    // First item should be selected
    let frame = inst.lastFrame()!;
    expect(frame).toContain("> Key 1");
    // Move down
    inst.stdin.write("\x1b[B");
    await tick();
    frame = inst.lastFrame()!;
    expect(frame).toContain("> Key 2");
  });
});
