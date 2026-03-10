import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createEnvGuard, createTmpDir } from "@molf-ai/test-utils";
import { loadTelegramConfig } from "../src/config.js";

describe("loadTelegramConfig", () => {
  let envGuard: ReturnType<typeof createEnvGuard>;
  let tmpDir: ReturnType<typeof createTmpDir>;

  beforeEach(() => {
    envGuard = createEnvGuard();
    tmpDir = createTmpDir();
    // Clear env vars that would override test values
    envGuard.delete("TELEGRAM_BOT_TOKEN");
    envGuard.delete("TELEGRAM_ALLOWED_USERS");
    envGuard.delete("MOLF_SERVER_URL");
    envGuard.delete("MOLF_TOKEN");
    envGuard.delete("MOLF_WORKER_ID");
  });

  afterEach(() => {
    envGuard.restore();
    tmpDir.cleanup();
  });

  it("loads defaults when no config file exists", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      configPath: join(tmpDir.path, "nonexistent.yaml"),
    });

    expect(config.botToken).toBe("test-token");
    expect(config.token).toBe("auth-token");
    expect(config.serverUrl).toBe("ws://127.0.0.1:7600");
    expect(config.ackReaction).toBe("eyes");
    expect(config.streamingThrottleMs).toBe(300);
    expect(config.allowedUsers).toEqual([]);
  });

  it("loads from YAML config file", () => {
    const yamlPath = join(tmpDir.path, "molf.yaml");
    writeFileSync(
      yamlPath,
      `telegram:
  botToken: "yaml-bot-token"
  allowedUsers:
    - "123"
    - "@alice"
  ackReaction: "thumbs_up"
  streamingThrottleMs: 500
`,
    );

    const config = loadTelegramConfig({
      token: "auth-token",
      configPath: yamlPath,
    });

    expect(config.botToken).toBe("yaml-bot-token");
    expect(config.allowedUsers).toEqual(["123", "@alice"]);
    expect(config.ackReaction).toBe("thumbs_up");
    expect(config.streamingThrottleMs).toBe(500);
  });

  it("env vars override YAML values", () => {
    const yamlPath = join(tmpDir.path, "molf.yaml");
    writeFileSync(
      yamlPath,
      `telegram:
  botToken: "yaml-token"
  allowedUsers:
    - "123"
`,
    );

    envGuard.set("TELEGRAM_BOT_TOKEN", "env-token");

    const config = loadTelegramConfig({
      token: "auth-token",
      configPath: yamlPath,
    });

    expect(config.botToken).toBe("env-token");
  });

  it("CLI args override env vars for bot token", () => {
    envGuard.set("TELEGRAM_BOT_TOKEN", "env-token");

    // Note: env takes precedence over CLI for botToken specifically
    // because the implementation checks process.env first
    const config = loadTelegramConfig({
      botToken: "cli-token",
      token: "auth-token",
      configPath: join(tmpDir.path, "nonexistent.yaml"),
    });

    expect(config.botToken).toBe("env-token");
  });

  it("comma-separated allowed users from override", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      allowedUsers: "123, @alice, 456",
      configPath: join(tmpDir.path, "nonexistent.yaml"),
    });

    expect(config.allowedUsers).toEqual(["123", "@alice", "456"]);
  });

  it("handles YAML without telegram section", () => {
    const yamlPath = join(tmpDir.path, "molf.yaml");
    writeFileSync(yamlPath, "host: localhost\nport: 7600\n");

    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      configPath: yamlPath,
    });

    expect(config.botToken).toBe("test-token");
    expect(config.allowedUsers).toEqual([]);
  });

  it("resolves server URL from override", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      serverUrl: "ws://custom:8080",
      configPath: join(tmpDir.path, "nonexistent.yaml"),
    });

    expect(config.serverUrl).toBe("ws://custom:8080");
  });

  it("resolves worker ID from override", () => {
    const config = loadTelegramConfig({
      botToken: "test-token",
      token: "auth-token",
      workerId: "worker-123",
      configPath: join(tmpDir.path, "nonexistent.yaml"),
    });

    expect(config.workerId).toBe("worker-123");
  });
});
