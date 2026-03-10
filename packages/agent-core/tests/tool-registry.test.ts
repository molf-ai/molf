import { describe, test, expect } from "vitest";
import { ToolRegistry } from "../src/tool-registry.js";

function makeDummyTool() {
  return { description: "test tool" } as any;
}

describe("ToolRegistry", () => {
  test("register adds tool", () => {
    const reg = new ToolRegistry();
    reg.register("echo", makeDummyTool());
    expect(reg.has("echo")).toBe(true);
    expect(reg.size).toBe(1);
  });

  test("register duplicate name throws", () => {
    const reg = new ToolRegistry();
    reg.register("echo", makeDummyTool());
    expect(() => reg.register("echo", makeDummyTool())).toThrow("echo");
  });

  test("unregister existing tool", () => {
    const reg = new ToolRegistry();
    reg.register("echo", makeDummyTool());
    expect(reg.unregister("echo")).toBe(true);
    expect(reg.has("echo")).toBe(false);
  });

  test("unregister nonexistent tool", () => {
    const reg = new ToolRegistry();
    expect(reg.unregister("nope")).toBe(false);
  });

  test("get returns tool def", () => {
    const reg = new ToolRegistry();
    const tool = makeDummyTool();
    reg.register("echo", tool);
    expect(reg.get("echo")).toBe(tool);
  });

  test("get missing tool", () => {
    const reg = new ToolRegistry();
    expect(reg.get("nope")).toBeUndefined();
  });

  test("getAll returns shallow copy", () => {
    const reg = new ToolRegistry();
    reg.register("a", makeDummyTool());
    const all = reg.getAll();
    all["b"] = makeDummyTool();
    expect(reg.has("b")).toBe(false);
  });

  test("clear removes all", () => {
    const reg = new ToolRegistry();
    reg.register("a", makeDummyTool());
    reg.register("b", makeDummyTool());
    reg.clear();
    expect(reg.size).toBe(0);
  });

  test("size getter accuracy", () => {
    const reg = new ToolRegistry();
    expect(reg.size).toBe(0);
    reg.register("a", makeDummyTool());
    expect(reg.size).toBe(1);
    reg.register("b", makeDummyTool());
    expect(reg.size).toBe(2);
    reg.unregister("a");
    expect(reg.size).toBe(1);
  });
});
