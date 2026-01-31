import { describe, test, expect, mock } from "bun:test";
import { CommandRegistry } from "../src/commands/registry.js";
import {
  clearCommand,
  exitCommand,
  makeHelpCommand,
  sessionsCommand,
  renameCommand,
} from "../src/commands/definitions.js";
import type { CommandContext } from "../src/commands/types.js";

function createTestRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(clearCommand);
  registry.register(exitCommand);
  registry.register(sessionsCommand);
  registry.register(renameCommand);
  registry.register(makeHelpCommand(registry));
  return registry;
}

describe("CommandRegistry", () => {
  test("/help recognized", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/help");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("help");
    }
  });

  test("/sessions recognized", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/sessions");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("sessions");
    }
  });

  test("/clear recognized", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/clear");
    expect(result.type).toBe("exact");
  });

  test("/exit recognized", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/exit");
    expect(result.type).toBe("exact");
  });

  test("alias /quit maps to exit", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/quit");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("exit");
    }
  });

  test("alias /new maps to clear", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/new");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("clear");
    }
  });

  test("unknown command", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/nonexistent");
    expect(result.type).toBe("no_match");
  });

  test("not a command", () => {
    const registry = createTestRegistry();
    const result = registry.parse("hello world");
    expect(result.type).toBe("not_command");
  });

  test("/rename with args", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/rename My New Name");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("rename");
      expect(result.args).toBe("My New Name");
    }
  });

  test("getCompletions", () => {
    const registry = createTestRegistry();
    const completions = registry.getCompletions("he");
    expect(completions.length).toBeGreaterThanOrEqual(1);
    expect(completions[0].name).toBe("help");
  });

  test("getCompletions matches alias prefix", () => {
    const registry = createTestRegistry();
    const completions = registry.getCompletions("qu");
    expect(completions.length).toBeGreaterThanOrEqual(1);
    expect(completions.some((c) => c.name === "exit")).toBe(true);
  });

  test("getAll returns all commands", () => {
    const registry = createTestRegistry();
    const all = registry.getAll();
    expect(all.length).toBe(5);
  });
});

function createMockContext(): CommandContext & {
  messages: string[];
  exited: boolean;
  sessionPickerEntered: boolean;
  renamedTo: string | null;
  newSessionCalled: boolean;
} {
  const ctx = {
    messages: [] as string[],
    exited: false,
    sessionPickerEntered: false,
    renamedTo: null as string | null,
    newSessionCalled: false,
    addSystemMessage: mock((content: string) => { ctx.messages.push(content); }),
    newSession: mock(async () => { ctx.newSessionCalled = true; }),
    exit: mock(() => { ctx.exited = true; }),
    listSessions: mock(async () => []),
    switchSession: mock(async (_id: string) => {}),
    enterSessionPicker: mock(() => { ctx.sessionPickerEntered = true; }),
    renameSession: mock(async (name: string) => { ctx.renamedTo = name; }),
  };
  return ctx;
}

describe("Command execute()", () => {
  test("clearCommand calls newSession and addSystemMessage", async () => {
    const ctx = createMockContext();
    await clearCommand.execute(ctx, "");
    expect(ctx.newSessionCalled).toBe(true);
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("New session");
  });

  test("exitCommand calls exit", () => {
    const ctx = createMockContext();
    exitCommand.execute(ctx, "");
    expect(ctx.exited).toBe(true);
  });

  test("helpCommand calls addSystemMessage with command list", () => {
    const registry = createTestRegistry();
    const helpCommand = makeHelpCommand(registry);
    const ctx = createMockContext();
    helpCommand.execute(ctx, "");
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("Available commands");
    expect(ctx.messages[0]).toContain("/clear");
    expect(ctx.messages[0]).toContain("/exit");
  });

  test("sessionsCommand calls enterSessionPicker", () => {
    const ctx = createMockContext();
    sessionsCommand.execute(ctx, "");
    expect(ctx.sessionPickerEntered).toBe(true);
  });

  test("renameCommand without args shows usage", async () => {
    const ctx = createMockContext();
    await renameCommand.execute(ctx, "");
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("Usage");
    expect(ctx.renamedTo).toBeNull();
  });

  test("renameCommand with args renames session", async () => {
    const ctx = createMockContext();
    await renameCommand.execute(ctx, "My Session");
    expect(ctx.renamedTo).toBe("My Session");
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("My Session");
  });
});
