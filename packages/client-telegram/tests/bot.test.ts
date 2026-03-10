import { describe, it, expect, vi } from "vitest";
import { type LogRecord, configure, reset } from "@logtape/logtape";
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

    const startMock = vi.fn(() => {});
    bot.start = startMock as any;

    start();

    expect(startMock).toHaveBeenCalledTimes(1);
    const opts = startMock.mock.calls[0][0] as any;
    expect(opts.onStart).toBeInstanceOf(Function);
  });

  it("start onStart callback logs bot username", async () => {
    const buffer: LogRecord[] = [];
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    try {
      const { bot, start } = createBot(DEFAULT_CONFIG);

      let capturedOnStart: ((me: any) => void) | null = null;
      bot.start = vi.fn((opts: any) => {
        capturedOnStart = opts?.onStart;
      }) as any;

      start();
      capturedOnStart!({ username: "test_bot" });

      const loggedMsg = buffer.find(
        (r) => r.level === "info" && r.properties.username === "test_bot",
      );
      expect(loggedMsg).toBeTruthy();
    } finally {
      await reset();
    }
  });

  it("start does nothing after stop", () => {
    const { bot, start, stop } = createBot(DEFAULT_CONFIG);
    const startMock = vi.fn(() => {});
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

  it("error handler logs middleware errors", async () => {
    const buffer: LogRecord[] = [];
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    try {
      const { bot } = createBot(DEFAULT_CONFIG);
      bot.errorHandler({ message: "test error" } as any);

      const errorRecord = buffer.find((r) => r.level === "error" && r.message.some((m) => typeof m === "string" && m.includes("Unhandled error in middleware")));
      expect(errorRecord).toBeTruthy();
      expect(errorRecord!.properties.error).toBeDefined();
    } finally {
      await reset();
    }
  });

  it("start logs 'Starting bot polling...'", async () => {
    const buffer: LogRecord[] = [];
    await configure({
      sinks: { buffer: buffer.push.bind(buffer) },
      loggers: [{ category: ["molf"], lowestLevel: "debug", sinks: ["buffer"] }],
    });
    try {
      const { bot, start } = createBot(DEFAULT_CONFIG);
      bot.start = vi.fn(() => {}) as any;

      start();

      const startingMsg = buffer.find(
        (r) => r.level === "info" && r.message.some((m) => typeof m === "string" && m.includes("Starting bot polling")),
      );
      expect(startingMsg).toBeTruthy();
    } finally {
      await reset();
    }
  });

  it("stop calls bot.stop exactly once", () => {
    const { bot, stop } = createBot(DEFAULT_CONFIG);
    const stopMock = vi.fn(() => {});
    bot.stop = stopMock;

    stop();
    stop(); // second call — should be no-op

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it("multiple createBot calls produce independent instances", () => {
    const inst1 = createBot(DEFAULT_CONFIG);
    const inst2 = createBot(DEFAULT_CONFIG);

    // Stopping one should not affect the other
    inst1.bot.start = vi.fn(() => {}) as any;
    inst2.bot.start = vi.fn(() => {}) as any;

    inst1.stop();
    inst2.start();

    expect(inst2.bot.start).toHaveBeenCalledTimes(1);
  });
});
