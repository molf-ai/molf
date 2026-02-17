import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
  ackReaction: string;
  streamingThrottleMs: number;
  serverUrl: string;
  token: string;
  workerId?: string;
}

const DEFAULTS = {
  ackReaction: "eyes",
  streamingThrottleMs: 300,
  serverUrl: "ws://127.0.0.1:7600",
};

export function loadTelegramConfig(overrides: {
  botToken?: string;
  serverUrl?: string;
  token?: string;
  workerId?: string;
  allowedUsers?: string;
  configPath?: string;
}): TelegramConfig {
  // Load YAML config if it exists
  const configPath = overrides.configPath ?? resolve(process.cwd(), "molf.yaml");
  let yamlConfig: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) ?? {};
    yamlConfig = (typeof parsed.telegram === "object" && parsed.telegram !== null)
      ? (parsed.telegram as Record<string, unknown>)
      : {};
  }

  // Resolve allowed users: env > yaml
  const envAllowed = overrides.allowedUsers ?? process.env.TELEGRAM_ALLOWED_USERS;
  let allowedUsers: string[];
  if (envAllowed) {
    allowedUsers = envAllowed.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(yamlConfig.allowedUsers)) {
    allowedUsers = (yamlConfig.allowedUsers as unknown[]).map(String);
  } else {
    allowedUsers = [];
  }

  // Resolve bot token: env > cli > yaml
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN ??
    overrides.botToken ??
    (typeof yamlConfig.botToken === "string" ? yamlConfig.botToken : "");

  // Resolve server connection
  const serverUrl =
    overrides.serverUrl ??
    process.env.MOLF_SERVER_URL ??
    DEFAULTS.serverUrl;

  const token =
    overrides.token ??
    process.env.MOLF_TOKEN ??
    "";

  const workerId =
    overrides.workerId ??
    process.env.MOLF_WORKER_ID ??
    undefined;

  // Resolve telegram-specific settings from yaml
  const ackReaction =
    typeof yamlConfig.ackReaction === "string" && yamlConfig.ackReaction.length > 0
      ? yamlConfig.ackReaction
      : DEFAULTS.ackReaction;

  const streamingThrottleMs =
    typeof yamlConfig.streamingThrottleMs === "number"
      ? yamlConfig.streamingThrottleMs
      : DEFAULTS.streamingThrottleMs;

  return {
    botToken,
    allowedUsers,
    ackReaction,
    streamingThrottleMs,
    serverUrl,
    token,
    workerId,
  };
}
