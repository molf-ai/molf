import { describe, it, expect, beforeEach, mock } from "bun:test";
import { registerCommands, handleHelpCallback, handleWorkerSelectCallback, HELP_PAGES, COMMAND_MENU, setCommandMenu } from "../src/commands.js";

describe("commands", () => {
  let registeredCommands: Map<string, (ctx: any) => Promise<void>>;
  let replySpy: ReturnType<typeof mock>;
  let sessionMapMock: any;
  let connectionMock: any;
  let setWorkerIdSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    registeredCommands = new Map();
    replySpy = mock(() => Promise.resolve());
    setWorkerIdSpy = mock(() => {});

    sessionMapMock = {
      createNew: mock(async () => "new-session-id"),
      get: mock(() => "existing-session-id"),
      getEntry: mock(() => ({ sessionId: "existing-session-id", sessionName: "Test Session" })),
      setWorkerId: mock(() => {}),
    };

    connectionMock = {
      trpc: {
        agent: {
          abort: { mutate: mock(async () => ({ aborted: true })) },
          list: { query: mock(async () => ({
            workers: [
              { workerId: "w-1", name: "Worker One", tools: [{ name: "t1", description: "d1", inputSchema: {} }], skills: [], connected: true },
              { workerId: "w-2", name: "Worker Two", tools: [], skills: [], connected: true },
            ],
          })) },
        },
        session: {
          list: { query: mock(async () => ({
            sessions: [
              { sessionId: "existing-session-id", name: "Test Session", workerId: "w-1", createdAt: 1, lastActiveAt: 2, messageCount: 5, active: true },
            ],
          })) },
        },
      },
    };
  });

  function createCtx(chatId = 100) {
    return {
      chat: { id: chatId },
      reply: replySpy,
    };
  }

  function makeDeps() {
    return {
      sessionMap: sessionMapMock,
      connection: connectionMock,
      getWorkerId: () => "w-1",
      setWorkerId: setWorkerIdSpy,
      getAgentStatus: () => "idle" as string,
    };
  }

  function setupBot(depsOverrides?: Partial<ReturnType<typeof makeDeps>>) {
    const botMock = {
      command: (cmd: string, handler: (ctx: any) => Promise<void>) => {
        registeredCommands.set(cmd, handler);
      },
    };

    const deps = { ...makeDeps(), ...depsOverrides };
    registerCommands(botMock, deps);

    return { botMock, deps };
  }

  it("registerCommands registers all expected commands", () => {
    setupBot();

    expect(registeredCommands.has("new")).toBe(true);
    expect(registeredCommands.has("clear")).toBe(true);
    expect(registeredCommands.has("abort")).toBe(true);
    expect(registeredCommands.has("stop")).toBe(true);
    expect(registeredCommands.has("worker")).toBe(true);
    expect(registeredCommands.has("status")).toBe(true);
    expect(registeredCommands.has("help")).toBe(true);
  });

  it("/new creates a new session", async () => {
    setupBot();
    await registeredCommands.get("new")!(createCtx());

    expect(sessionMapMock.createNew).toHaveBeenCalledWith(100);
    expect(replySpy).toHaveBeenCalled();
    const replyCall = replySpy.mock.calls[0];
    expect(replyCall[0]).toContain("New session started");
  });

  it("/clear calls same handler as /new", async () => {
    setupBot();
    await registeredCommands.get("clear")!(createCtx());

    expect(sessionMapMock.createNew).toHaveBeenCalledWith(100);
  });

  it("/new handles error when session creation fails", async () => {
    sessionMapMock.createNew = mock(async () => {
      throw new Error("Connection lost");
    });
    setupBot();

    const origError = console.error;
    console.error = mock(() => {});
    try {
      await registeredCommands.get("new")!(createCtx());

      expect(replySpy).toHaveBeenCalled();
      const replyCall = replySpy.mock.calls[0];
      expect(replyCall[0]).toContain("Failed to create new session");
    } finally {
      console.error = origError;
    }
  });

  it("/new does nothing when no chatId", async () => {
    setupBot();
    await registeredCommands.get("new")!({ chat: undefined, reply: replySpy });

    expect(sessionMapMock.createNew).not.toHaveBeenCalled();
  });

  it("/status shows richer status with worker name and tool count", async () => {
    setupBot({ getAgentStatus: () => "streaming" });

    await registeredCommands.get("status")!(createCtx());

    expect(replySpy).toHaveBeenCalled();
    const replyCall = replySpy.mock.calls[0];
    expect(replyCall[0]).toContain("streaming");
    expect(replyCall[0]).toContain("Worker One");
    expect(replyCall[0]).toContain("Test Session");
    expect(replyCall[0]).toContain("existing-session-id");
    expect(replyCall[0]).toContain("5"); // message count
    expect(replyCall[0]).toContain("1"); // tool count
  });

  it("/status does nothing when no chatId", async () => {
    setupBot();
    await registeredCommands.get("status")!({ chat: undefined, reply: replySpy });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("/help shows command list", async () => {
    setupBot();
    await registeredCommands.get("help")!(createCtx());

    expect(replySpy).toHaveBeenCalled();
    const replyCall = replySpy.mock.calls[0];
    expect(replyCall[0]).toContain("/new");
    expect(replyCall[0]).toContain("/status");
    expect(replyCall[0]).toContain("/help");
    expect(replyCall[0]).toContain("/abort");
    expect(replyCall[0]).toContain("/worker");
  });

  it("/help sends with HTML parse mode", async () => {
    setupBot();
    await registeredCommands.get("help")!(createCtx());

    const replyCall = replySpy.mock.calls[0];
    expect(replyCall[1]?.parse_mode).toBe("HTML");
  });

  // --- /abort tests ---

  it("/abort with active session calls agent.abort", async () => {
    setupBot();
    await registeredCommands.get("abort")!(createCtx());

    expect(connectionMock.trpc.agent.abort.mutate).toHaveBeenCalledWith({
      sessionId: "existing-session-id",
    });
    expect(replySpy).toHaveBeenCalled();
    expect(replySpy.mock.calls[0][0]).toContain("Agent aborted");
  });

  it("/abort when abort returns false", async () => {
    connectionMock.trpc.agent.abort.mutate = mock(async () => ({ aborted: false }));
    setupBot();
    await registeredCommands.get("abort")!(createCtx());

    expect(replySpy.mock.calls[0][0]).toContain("Nothing to abort");
  });

  it("/abort with no active session", async () => {
    sessionMapMock.get = mock(() => undefined);
    setupBot();
    await registeredCommands.get("abort")!(createCtx());

    expect(replySpy.mock.calls[0][0]).toContain("No active session");
  });

  it("/abort does nothing when no chatId", async () => {
    setupBot();
    await registeredCommands.get("abort")!({ chat: undefined, reply: replySpy });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("/stop is alias for /abort", async () => {
    setupBot();
    await registeredCommands.get("stop")!(createCtx());

    expect(connectionMock.trpc.agent.abort.mutate).toHaveBeenCalledWith({
      sessionId: "existing-session-id",
    });
    expect(replySpy.mock.calls[0][0]).toContain("Agent aborted");
  });

  // --- /worker tests ---

  it("/worker shows inline keyboard with workers", async () => {
    setupBot();
    await registeredCommands.get("worker")!(createCtx());

    expect(replySpy).toHaveBeenCalled();
    const [text, opts] = replySpy.mock.calls[0];
    expect(text).toContain("Select a worker");
    expect(opts.reply_markup).toBeDefined();
  });

  it("/worker shows message when no workers available", async () => {
    connectionMock.trpc.agent.list.query = mock(async () => ({ workers: [] }));
    setupBot();
    await registeredCommands.get("worker")!(createCtx());

    expect(replySpy.mock.calls[0][0]).toContain("No workers available");
  });

  it("/worker does nothing when no chatId", async () => {
    setupBot();
    await registeredCommands.get("worker")!({ chat: undefined, reply: replySpy });

    expect(replySpy).not.toHaveBeenCalled();
  });
});

describe("handleWorkerSelectCallback", () => {
  it("returns false for non-worker data", async () => {
    const ctx = {} as any;
    const deps = {} as any;
    const result = await handleWorkerSelectCallback(ctx, "help_page_0", deps);
    expect(result).toBe(false);
  });

  it("switches worker and creates new session", async () => {
    const answerSpy = mock(() => Promise.resolve());
    const editSpy = mock(() => Promise.resolve());
    const setWorkerIdSpy = mock(() => {});
    const sessionMapSetWorkerIdSpy = mock(() => {});
    const createNewSpy = mock(async () => "new-session-id");

    const ctx = {
      chat: { id: 100 },
      callbackQuery: {
        id: "cb-1",
        message: { message_id: 50 },
      },
      api: {
        answerCallbackQuery: answerSpy,
        editMessageText: editSpy,
      },
    } as any;

    const deps = {
      connection: {
        trpc: {
          agent: {
            list: { query: mock(async () => ({
              workers: [{ workerId: "w-1", name: "My Worker", tools: [], skills: [], connected: true }],
            })) },
          },
        },
      },
      setWorkerId: setWorkerIdSpy,
      sessionMap: {
        setWorkerId: sessionMapSetWorkerIdSpy,
        createNew: createNewSpy,
      },
    } as any;

    const result = await handleWorkerSelectCallback(ctx, "worker_select_w-1", deps);
    expect(result).toBe(true);
    expect(setWorkerIdSpy).toHaveBeenCalledWith("w-1");
    expect(sessionMapSetWorkerIdSpy).toHaveBeenCalledWith("w-1");
    expect(createNewSpy).toHaveBeenCalledWith(100);
    expect(editSpy).toHaveBeenCalled();
    const editCall = editSpy.mock.calls[0];
    expect(editCall[2]).toContain("My Worker");
    expect(editCall[2]).toContain("New session started");
  });
});

describe("COMMAND_MENU", () => {
  it("is non-empty", () => {
    expect(COMMAND_MENU.length).toBeGreaterThan(0);
  });

  it("each entry has command and description strings", () => {
    for (const entry of COMMAND_MENU) {
      expect(typeof entry.command).toBe("string");
      expect(entry.command.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("includes abort, stop, and worker commands", () => {
    const commands = COMMAND_MENU.map((c) => c.command);
    expect(commands).toContain("abort");
    expect(commands).toContain("stop");
    expect(commands).toContain("worker");
  });
});

describe("setCommandMenu", () => {
  it("calls api.setMyCommands with COMMAND_MENU", async () => {
    const setMyCommandsSpy = mock(() => Promise.resolve(true));
    const api = { setMyCommands: setMyCommandsSpy };

    await setCommandMenu(api);

    expect(setMyCommandsSpy).toHaveBeenCalledTimes(1);
    expect(setMyCommandsSpy).toHaveBeenCalledWith(COMMAND_MENU);
  });
});

describe("HELP_PAGES", () => {
  it("has at least one page", () => {
    expect(HELP_PAGES.length).toBeGreaterThanOrEqual(1);
  });

  it("each page is non-empty", () => {
    for (const page of HELP_PAGES) {
      expect(page.length).toBeGreaterThan(0);
    }
  });

  it("is derived from COMMAND_MENU", () => {
    const page = HELP_PAGES[0];
    for (const entry of COMMAND_MENU) {
      expect(page).toContain(`/${entry.command}`);
      expect(page).toContain(entry.description);
    }
  });
});

describe("handleHelpCallback", () => {
  it("returns false for non-help data", async () => {
    const ctx = {} as any;
    const result = await handleHelpCallback(ctx, "tool_approve_123");
    expect(result).toBe(false);
  });

  it("returns false for invalid page number", async () => {
    const ctx = {} as any;
    const result = await handleHelpCallback(ctx, "help_page_999");
    expect(result).toBe(false);
  });

  it("handles valid page 0 callback", async () => {
    const answerSpy = mock(() => Promise.resolve());
    const editSpy = mock(() => Promise.resolve());

    const ctx = {
      chat: { id: 100 },
      callbackQuery: {
        id: "cb-1",
        message: { message_id: 50 },
      },
      api: {
        answerCallbackQuery: answerSpy,
        editMessageText: editSpy,
      },
    } as any;

    const result = await handleHelpCallback(ctx, "help_page_0");
    expect(result).toBe(true);
    expect(answerSpy).toHaveBeenCalledWith("cb-1");
  });
});
