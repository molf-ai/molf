import { describe, test, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { AutocompletePopup } from "../src/components/autocomplete-popup.js";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

const makeCommand = (name: string, description: string) => ({
  name,
  description,
  execute: () => {},
});

describe("AutocompletePopup", () => {
  test("renders nothing when not visible", () => {
    const inst = render(
      <AutocompletePopup
        completions={[makeCommand("help", "Show help")]}
        selectedIndex={0}
        visible={false}
      />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toBe("");
  });

  test("renders nothing when completions empty", () => {
    const inst = render(
      <AutocompletePopup completions={[]} selectedIndex={0} visible={true} />,
    );
    unmount = inst.unmount;
    expect(inst.lastFrame()).toBe("");
  });

  test("renders completions when visible", () => {
    const inst = render(
      <AutocompletePopup
        completions={[makeCommand("help", "Show help"), makeCommand("exit", "Exit app")]}
        selectedIndex={0}
        visible={true}
      />,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    expect(frame).toContain("/help");
    expect(frame).toContain("/exit");
    expect(frame).toContain("Show help");
  });

  test("highlights selected item", () => {
    const inst = render(
      <AutocompletePopup
        completions={[makeCommand("help", "Show help"), makeCommand("exit", "Exit app")]}
        selectedIndex={1}
        visible={true}
      />,
    );
    unmount = inst.unmount;
    const frame = inst.lastFrame()!;
    // Selected item has "> " prefix
    expect(frame).toContain("> /exit");
  });
});
