import { describe, test, expect, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { flushAsync } from "@molf-ai/test-utils";
import { ModelPicker } from "../src/components/model-picker.js";

const tick = () => flushAsync();

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeProvider = (id: string, name: string) => ({
  id,
  name,
  hasKey: true,
  keySource: "stored" as const,
  modelCount: 3,
});

const makeModel = (id: string, name: string) => ({ id, name });

describe("ModelPicker", () => {
  test("shows loading state for providers", () => {
    const inst = render(
      <ModelPicker
        listModels={vi.fn()}
        listProviders={() => new Promise(() => {})}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toContain("Loading");
  });

  test("shows provider list after loading", async () => {
    const inst = render(
      <ModelPicker
        listModels={vi.fn()}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Default (server)");
    expect(frame).toContain("Provider 1");
  });

  test("Enter on Default calls onReset", async () => {
    const onReset = vi.fn();
    const inst = render(
      <ModelPicker
        listModels={vi.fn()}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={onReset}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\r"); // Enter on Default (first item)
    await tick();
    expect(onReset).toHaveBeenCalled();
  });

  test("drills into models for provider", async () => {
    const listModels = vi.fn().mockResolvedValue([makeModel("m1", "Model A"), makeModel("m2", "Model B")]);
    const inst = render(
      <ModelPicker
        listModels={listModels}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b[B"); // Down to Provider 1
    await tick();
    inst.stdin.write("\r"); // Enter
    await tick();
    await tick(); // Wait for models to load
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Model A");
    expect(frame).toContain("Model B");
  });

  test("Escape on model level goes back to providers", async () => {
    const listModels = vi.fn().mockResolvedValue([makeModel("m1", "Model A")]);
    const inst = render(
      <ModelPicker
        listModels={listModels}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b[B"); // Down to provider
    await tick();
    inst.stdin.write("\r"); // Enter into models
    await tick();
    await tick();
    await tick();
    inst.stdin.write("\x1b"); // Escape
    await tick();
    expect(inst.lastFrame()).toContain("Select Provider");
  });

  test("Escape on provider level calls onCancel", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <ModelPicker
        listModels={vi.fn()}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={onCancel}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    inst.stdin.write("\x1b");
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("typing filters providers", async () => {
    const inst = render(
      <ModelPicker
        listModels={vi.fn()}
        listProviders={vi.fn().mockResolvedValue([
          makeProvider("p1", "Alpha Cloud"),
          makeProvider("p2", "Beta AI"),
        ])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    expect(inst.lastFrame()).toContain("Alpha Cloud");
    expect(inst.lastFrame()).toContain("Beta AI");
    // Type "bet" to filter
    inst.stdin.write("bet");
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Beta AI");
    expect(frame).not.toContain("Alpha Cloud");
    // Default (server) should be hidden during search
    expect(frame).not.toContain("Default (server)");
  });

  test("Escape clears provider search before cancelling", async () => {
    const onCancel = vi.fn();
    const inst = render(
      <ModelPicker
        listModels={vi.fn()}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={onCancel}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("x");
    await tick();
    inst.stdin.write("\x1b"); // Escape clears search
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    expect(inst.lastFrame()).toContain("Provider 1");
    inst.stdin.write("\x1b"); // Escape again cancels
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  test("typing filters models", async () => {
    const listModels = vi.fn().mockResolvedValue([
      makeModel("m1", "GPT-4o"),
      makeModel("m2", "GPT-4o-mini"),
      makeModel("m3", "Claude Sonnet"),
    ]);
    const inst = render(
      <ModelPicker
        listModels={listModels}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b[B"); // Down to provider
    await tick();
    inst.stdin.write("\r"); // Enter into models
    await tick();
    await tick();
    await tick();
    expect(inst.lastFrame()).toContain("GPT-4o");
    expect(inst.lastFrame()).toContain("Claude Sonnet");
    // Type "claude" to filter
    inst.stdin.write("claude");
    await tick();
    const frame = inst.lastFrame()!;
    expect(frame).toContain("Claude Sonnet");
    expect(frame).not.toContain("GPT-4o");
  });

  test("Escape clears model search before going back", async () => {
    const listModels = vi.fn().mockResolvedValue([makeModel("m1", "Model A")]);
    const inst = render(
      <ModelPicker
        listModels={listModels}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={vi.fn()}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b[B"); // Down to provider
    await tick();
    inst.stdin.write("\r"); // Enter into models
    await tick();
    await tick();
    await tick();
    inst.stdin.write("x"); // Type to create search
    await tick();
    inst.stdin.write("\x1b"); // Escape clears search
    await tick();
    expect(inst.lastFrame()).toContain("Model A"); // Still on model level
    inst.stdin.write("\x1b"); // Escape again goes back
    await tick();
    expect(inst.lastFrame()).toContain("Select Provider");
  });

  test("selects model and calls onSelect", async () => {
    const onSelect = vi.fn();
    const listModels = vi.fn().mockResolvedValue([makeModel("m1", "Model A")]);
    const inst = render(
      <ModelPicker
        listModels={listModels}
        listProviders={vi.fn().mockResolvedValue([makeProvider("p1", "Provider 1")])}
        onSelect={onSelect}
        onReset={vi.fn()}
        onCancel={vi.fn()}
        currentModel={null}
      />,
    );
    unmount = inst.unmount;
    await tick();
    await tick();
    inst.stdin.write("\x1b[B"); // Down to provider
    await tick();
    inst.stdin.write("\r"); // Enter into models
    await tick();
    await tick();
    await tick();
    inst.stdin.write("\r"); // Select model
    await tick();
    expect(onSelect).toHaveBeenCalledWith("m1");
  });
});
