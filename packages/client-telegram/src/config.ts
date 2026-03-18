export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
  serverUrl: string;
  token: string;
  workerId?: string;
}

export function loadTelegramConfig(overrides: {
  botToken?: string;
  serverUrl?: string;
  token?: string;
  workerId?: string;
  allowedUsers?: string;
}): TelegramConfig {
  // Resolve allowed users: env > CLI
  const envAllowed = overrides.allowedUsers ?? process.env.TELEGRAM_ALLOWED_USERS;
  let allowedUsers: string[];
  if (envAllowed) {
    allowedUsers = envAllowed.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    allowedUsers = [];
  }

  // Resolve bot token: env > CLI
  const botToken =
    process.env.TELEGRAM_BOT_TOKEN ??
    overrides.botToken ??
    "";

  // Resolve server connection
  const serverUrl =
    overrides.serverUrl ??
    process.env.MOLF_SERVER_URL ??
    "wss://127.0.0.1:7600";

  const token =
    overrides.token ??
    process.env.MOLF_TOKEN ??
    "";

  const workerId =
    overrides.workerId ??
    process.env.MOLF_WORKER_ID ??
    undefined;

  return {
    botToken,
    allowedUsers,
    serverUrl,
    token,
    workerId,
  };
}
