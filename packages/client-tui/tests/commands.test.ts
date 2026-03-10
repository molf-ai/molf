import { describe, test, expect, vi } from "vitest";
import { CommandRegistry } from "../src/commands/registry.js";
import {
  clearCommand,
  exitCommand,
  makeHelpCommand,
  sessionsCommand,
  renameCommand,
  workerCommand,
  pairCommand,
  keysCommand,
} from "../src/commands/definitions.js";
import type { CommandContext } from "../src/commands/types.js";

function createTestRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(clearCommand);
  registry.register(exitCommand);
  registry.register(sessionsCommand);
  registry.register(renameCommand);
  registry.register(workerCommand);
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
    expect(all.length).toBe(6);
  });
});

function createMockContext(): CommandContext & {
  messages: string[];
  exited: boolean;
  sessionPickerEntered: boolean;
  workerPickerEntered: boolean;
  renamedTo: string | null;
  newSessionCalled: boolean;
} {
  const ctx = {
    messages: [] as string[],
    exited: false,
    sessionPickerEntered: false,
    workerPickerEntered: false,
    renamedTo: null as string | null,
    newSessionCalled: false,
    addSystemMessage: vi.fn((content: string) => { ctx.messages.push(content); }),
    newSession: vi.fn(async () => { ctx.newSessionCalled = true; }),
    clearScreen: vi.fn(() => {}),
    exit: vi.fn(() => { ctx.exited = true; }),
    listSessions: vi.fn(async () => []),
    switchSession: vi.fn(async (_id: string) => {}),
    enterSessionPicker: vi.fn(() => { ctx.sessionPickerEntered = true; }),
    enterWorkerPicker: vi.fn(() => { ctx.workerPickerEntered = true; }),
    enterModelPicker: vi.fn(() => {}),
    enterWorkspacePicker: vi.fn(() => {}),
    renameSession: vi.fn(async (name: string) => { ctx.renamedTo = name; }),
    createWorkspace: vi.fn(async (_name: string) => {}),
    renameWorkspace: vi.fn(async (_name: string) => {}),
    openEditor: vi.fn(() => {}),
    createPairingCode: vi.fn(async (name: string) => ({ code: "123456" })),
    enterKeysPicker: vi.fn(() => {}),
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

  test("workerCommand calls enterWorkerPicker", () => {
    const ctx = createMockContext();
    workerCommand.execute(ctx, "");
    expect(ctx.workerPickerEntered).toBe(true);
  });

  test("/worker recognized", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/worker");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("worker");
    }
  });

  test("/w alias maps to worker", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/w");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("worker");
    }
  });

  test("/workers alias maps to worker", () => {
    const registry = createTestRegistry();
    const result = registry.parse("/workers");
    expect(result.type).toBe("exact");
    if (result.type === "exact") {
      expect(result.command.name).toBe("worker");
    }
  });

  test("pairCommand without args shows usage", async () => {
    const ctx = createMockContext();
    await pairCommand.execute(ctx, "");
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("Usage");
  });

  test("pairCommand with name creates pairing code", async () => {
    const ctx = createMockContext();
    await pairCommand.execute(ctx, "my-phone");
    expect(ctx.createPairingCode).toHaveBeenCalledWith("my-phone");
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("123456");
    expect(ctx.messages[0]).toContain("5 minutes");
  });

  test("pairCommand handles errors", async () => {
    const ctx = createMockContext();
    (ctx.createPairingCode as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("Unauthorized");
    });
    await pairCommand.execute(ctx, "my-phone");
    expect(ctx.messages.length).toBe(1);
    expect(ctx.messages[0]).toContain("Failed");
    expect(ctx.messages[0]).toContain("Unauthorized");
  });

  test("keysCommand enters keys picker", () => {
    const ctx = createMockContext();
    keysCommand.execute(ctx, "");
    expect(ctx.enterKeysPicker).toHaveBeenCalled();
  });
});
