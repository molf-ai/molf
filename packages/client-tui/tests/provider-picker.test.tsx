import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { ProviderPicker } from "../src/components/provider-picker.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeProvider = (id: string, name: string, hasKey = false) => ({
  id,
  name,
  hasKey,
  keySource: hasKey ? ("stored" as const) : (undefined as any),
  modelCount: 5,
});

const defaultProps = {
  listModels: vi.fn().mockResolvedValue([]),
  setProviderKey: vi.fn().mockResolvedValue(undefined),
  removeProviderKey: vi.fn().mockResolvedValue(undefined),
  setDefaultModel: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn(),
  onDone: vi.fn(),
};

describe("ProviderPicker", () => {
  test("shows loading state", () => {
    const inst = render(
      <ProviderPicker {...defaultProps} listProviders={() => new Promise(() => {})} />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Loading");
  });

  test("renders provider list after loading", async () => {
    const inst = render(
      <ProviderPicker
        {...defaultProps}
        listProviders={vi.fn().mockResolvedValue([makeProvider("anthropic", "Anthropic")])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("Providers");
  });

  test("Escape calls onCancel when no search", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <ProviderPicker
        {...defaultProps}
        onCancel={onCancel}
        listProviders={vi.fn().mockResolvedValue([makeProvider("anthropic", "Anthropic")])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("shows key status icons", async () => {
    const inst = render(
      <ProviderPicker
        {...defaultProps}
        listProviders={vi.fn().mockResolvedValue([
          makeProvider("anthropic", "Anthropic", true),
          makeProvider("openai", "OpenAI", false),
        ])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("✓"); // has key
    expect(frame).toContain("✗"); // no key
  });

  test("keyed non-popular providers appear individually without search", async () => {
    const inst = render(
      <ProviderPicker
        {...defaultProps}
        listProviders={vi.fn().mockResolvedValue([
          makeProvider("anthropic", "Anthropic", true),
          makeProvider("alibaba", "Alibaba Cloud", true),
          makeProvider("fireworks", "Fireworks", false),
        ])}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    const frame = inst.lastFrame()!;
    // Alibaba has a key so it should show individually under "Configured"
    expect(frame).toContain("Configured");
    expect(frame).toContain("Alibaba Cloud");
    // Fireworks has no key and is not popular — should be collapsed
    expect(frame).not.toContain("Fireworks");
    expect(frame).toContain("1 more");
  });

  test("Enter on provider without key shows key entry view", async () => {
    const inst = render(
      <ProviderPicker
        {...defaultProps}
        listProviders={vi.fn().mockResolvedValue([makeProvider("anthropic", "Anthropic", false)])}
      />,
    );
    unmount = inst.unmount;
    // Wait for data to load fully
    for (let i = 0; i < 5; i++) await tick();
    expect(inst.lastFrame()).toContain("Anthropic");
    // Provider is the only selectable item (already selected)
    inst.stdin.write("\r"); // Enter
    await tick();
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Enter API key");
  });
});
