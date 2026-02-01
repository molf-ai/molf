import { describe, it, expect, mock } from "bun:test";
import { createBot } from "../src/bot.js";

const DEFAULT_CONFIG = {
  botToken: "test:token123",
  allowedUsers: [],
  ackReaction: "eyes",
  streamingThrottleMs: 300,
  serverUrl: "ws://localhost:7600",
  token: "auth",
};

describe("createBot", () => {
  it("creates a bot instance with expected shape", () => {
    const result = createBot(DEFAULT_CONFIG);
    expect(result.bot).toBeDefined();
    expect(result.start).toBeInstanceOf(Function);
    expect(result.stop).toBeInstanceOf(Function);
  });

  it("bot has api property", () => {
    const result = createBot(DEFAULT_CONFIG);
    expect(result.bot.api).toBeDefined();
  });

  it("start calls bot.start with onStart callback", () => {
    const { bot, start } = createBot(DEFAULT_CONFIG);

    const startMock = mock(() => {});
    bot.start = startMock as any;

    start();

    expect(startMock).toHaveBeenCalledTimes(1);
    const opts = startMock.mock.calls[0][0] as any;
    expect(opts.onStart).toBeInstanceOf(Function);
  });

  it("start onStart callback logs bot username", () => {
    const { bot, start } = createBot(DEFAULT_CONFIG);

    let capturedOnStart: ((me: any) => void) | null = null;
    bot.start = mock((opts: any) => {
      capturedOnStart = opts?.onStart;
    }) as any;

    const origLog = console.log;
    const logMock = mock(() => {});
    console.log = logMock;
    try {
      start();
      capturedOnStart!({ username: "test_bot" });

      expect(logMock).toHaveBeenCalled();
      const loggedMsg = logMock.mock.calls.find(
        (c: any) => typeof c[0] === "string" && c[0].includes("@test_bot"),
      );
      expect(loggedMsg).toBeTruthy();
    } finally {
      console.log = origLog;
    }
  });

  it("start does nothing after stop", () => {
    const { bot, start, stop } = createBot(DEFAULT_CONFIG);
    const startMock = mock(() => {});
    bot.start = startMock as any;

    stop();
    start();

    expect(startMock).not.toHaveBeenCalled();
  });

  it("stop is idempotent", () => {
    const { stop } = createBot(DEFAULT_CONFIG);
    stop();
    stop(); // Second call should not throw
  });

  it("error handler logs middleware errors", () => {
    const { bot } = createBot(DEFAULT_CONFIG);

    const origError = console.error;
    const errorMock = mock(() => {});
    console.error = errorMock;
    try {
      bot.errorHandler({ message: "test error" } as any);

      expect(errorMock).toHaveBeenCalled();
      const call = errorMock.mock.calls[0];
      expect(call[0]).toContain("[telegram]");
      expect(call[1]).toBe("test error");
    } finally {
      console.error = origError;
    }
  });

  it("start logs 'Starting bot polling...'", () => {
    const { bot, start } = createBot(DEFAULT_CONFIG);
    bot.start = mock(() => {}) as any;

    const origLog = console.log;
    const logMock = mock(() => {});
    console.log = logMock;
    try {
      start();

      const startingMsg = logMock.mock.calls.find(
        (c: any) => typeof c[0] === "string" && c[0].includes("Starting bot polling"),
      );
      expect(startingMsg).toBeTruthy();
    } finally {
      console.log = origLog;
    }
  });

  it("stop calls bot.stop exactly once", () => {
    const { bot, stop } = createBot(DEFAULT_CONFIG);
    const stopMock = mock(() => {});
    bot.stop = stopMock;

    stop();
    stop(); // second call — should be no-op

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("multiple createBot calls produce independent instances", () => {
    const inst1 = createBot(DEFAULT_CONFIG);
    const inst2 = createBot(DEFAULT_CONFIG);

    // Stopping one should not affect the other
    inst1.bot.start = mock(() => {}) as any;
    inst2.bot.start = mock(() => {}) as any;

    inst1.stop();
    inst2.start();

    expect(inst2.bot.start).toHaveBeenCalledTimes(1);
  });
});
