import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEnvGuard } from "@molf-ai/test-utils";
import { loadTelegramConfig } from "../src/config.js";

describe("loadTelegramConfig", () => {
  let envGuard: ReturnType<typeof createEnvGuard>;

  beforeEach(() => {
    envGuard = createEnvGuard();
    // Clear env vars that would override test values
    envGuard.delete("TELEGRAM_BOT_TOKEN");
    envGuard.delete("TELEGRAM_ALLOWED_USERS");
    envGuard.delete("MOLF_SERVER_URL");
    envGuard.delete("MOLF_TOKEN");
    envGuard.delete("MOLF_WORKER_ID");
  });

  afterEach(() => {
    envGuard.restore();
  });

  it("loads defaults when no overrides", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
    });

    expect(config.botToken).toBe("test-token");
    expect(config.token).toBe("auth-token");
    expect(config.serverUrl).toBe("wss://127.0.0.1:7600");
    expect(config.allowedUsers).toEqual([]);
  });

  it("env var overrides CLI for bot token", () => {
    envGuard.set("TELEGRAM_BOT_TOKEN", "env-token");

    const config = loadTelegramConfig({
      botToken: "cli-token",
      token: "auth-token",
    });

    expect(config.botToken).toBe("env-token");
  });

  it("CLI override for bot token when no env", () => {
    const config = loadTelegramConfig({
      botToken: "cli-token",
      token: "auth-token",
    });

    expect(config.botToken).toBe("cli-token");
  });

  it("comma-separated allowed users from override", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      allowedUsers: "123, @alice, 456",
    });

    expect(config.allowedUsers).toEqual(["123", "@alice", "456"]);
  });

  it("allowed users from env var", () => {
    envGuard.set("TELEGRAM_ALLOWED_USERS", "111,@bob");

    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
    });

    expect(config.allowedUsers).toEqual(["111", "@bob"]);
  });

  it("resolves server URL from override", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      serverUrl: "ws://custom:8080",
    });

    expect(config.serverUrl).toBe("ws://custom:8080");
  });

  it("resolves server URL from env var", () => {
    envGuard.set("MOLF_SERVER_URL", "ws://env:9090");

    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
    });

    expect(config.serverUrl).toBe("ws://env:9090");
  });

  it("resolves worker ID from override", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      workerId: "worker-123",
    });

    expect(config.workerId).toBe("worker-123");
  });

  it("resolves worker ID from env var", () => {
    envGuard.set("MOLF_WORKER_ID", "env-worker");

    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
    });

    expect(config.workerId).toBe("env-worker");
  });
});
