import { z } from "zod";
import type { Context } from "grammy";
import { parseCli } from "@molf-ai/protocol";
import { loadTelegramConfig } from "./config.js";
import { connectToServer, resolveWorkerId } from "./connection.js";
import { createBot } from "./bot.js";
import { createAccessMiddleware } from "./access.js";
import { SessionMap } from "./session-map.js";
import { registerCommands, handleHelpCallback, handleWorkerSelectCallback, setCommandMenu } from "./commands.js";
import { MessageHandler } from "./handler.js";
import { Renderer } from "./renderer.js";
import { ApprovalManager } from "./approval.js";

const argsSchema = z.object({
  "server-url": z.string().default("ws://127.0.0.1:7600"),
  token: z.string().min(1, "Auth token is required"),
  "worker-id": z.string().optional(),
  "bot-token": z.string().optional(),
  "allowed-users": z.string().optional(),
  config: z.string().optional(),
});

const args = parseCli(
  {
    name: "molf-telegram",
    version: "0.1.0",
    description: "Molf Telegram bot client",
    usage: "bun run dev:client-telegram -- [options]",
    options: {
      "server-url": {
        type: "string",
        short: "s",
        description: "WebSocket server URL",
        default: "ws://127.0.0.1:7600",
        env: "MOLF_SERVER_URL",
      },
      token: {
        type: "string",
        short: "t",
        description: "Server auth token",
        required: true,
        env: "MOLF_TOKEN",
      },
      "worker-id": {
        type: "string",
        short: "w",
        description: "Target worker ID",
        env: "MOLF_WORKER_ID",
      },
      "bot-token": {
        type: "string",
        short: "b",
        description: "Telegram bot token",
        env: "TELEGRAM_BOT_TOKEN",
      },
      "allowed-users": {
        type: "string",
        description: "Comma-separated allowed Telegram user IDs/usernames",
        env: "TELEGRAM_ALLOWED_USERS",
      },
      config: {
        type: "string",
        short: "c",
        description: "Path to molf.yaml config file",
      },
    },
    schema: argsSchema,
  },
);

// Load config (YAML + env + CLI args)
const config = loadTelegramConfig({
  botToken: args["bot-token"],
  serverUrl: args["server-url"],
  token: args.token,
  workerId: args["worker-id"],
  allowedUsers: args["allowed-users"],
  configPath: args.config,
});

if (!config.botToken) {
  console.error("Error: Telegram bot token is required.");
  console.error("Provide via --bot-token, TELEGRAM_BOT_TOKEN env var, or telegram.botToken in molf.yaml");
  process.exit(1);
}

if (!config.token) {
  console.error("Error: Server auth token is required.");
  console.error("Provide via --token or MOLF_TOKEN env var");
  process.exit(1);
}

async function main() {
  // 1. Connect to Molf server
  console.log(`[telegram] Connecting to server at ${config.serverUrl}...`);
  const connection = connectToServer({
    serverUrl: config.serverUrl,
    token: config.token,
  });

  // 2. Resolve worker ID
  let workerId = await resolveWorkerId(connection.trpc, config.workerId);
  console.log(`[telegram] Using worker: ${workerId}`);

  // 3. Create bot
  const { bot, start, stop } = createBot(config);

  // 4. Create shared state
  const sessionMap = new SessionMap(connection.trpc, workerId);

  // 4a. Restore sessions from previous runs
  try {
    const restored = await sessionMap.restore();
    if (restored > 0) {
      console.log(`[telegram] Restored ${restored} session(s) from server`);
    }
  } catch (err) {
    console.warn("[telegram] Failed to restore sessions:", err);
  }

  const renderer = new Renderer({
    api: bot.api,
    connection,
    streamingThrottleMs: config.streamingThrottleMs,
  });

  const approvalManager = new ApprovalManager({
    api: bot.api,
    connection,
  });

  const handler = new MessageHandler({
    sessionMap,
    connection,
    renderer,
    ackReaction: config.ackReaction,
    botToken: config.botToken,
  });

  // 4b. Start subscriptions for restored sessions
  for (const chatId of sessionMap.activeChatIds()) {
    const sessionId = sessionMap.get(chatId)!;
    renderer.startSession(chatId, sessionId);
    approvalManager.watchSession(chatId, sessionId);
  }

  // 5. Register command menu with Telegram
  await setCommandMenu(bot.api);

  // 6. Set up middleware chain

  // Command deps with mutable workerId
  const commandDeps = {
    sessionMap,
    connection,
    getWorkerId: () => workerId,
    setWorkerId: (id: string) => { workerId = id; },
    getAgentStatus: (chatId: number) => renderer.getAgentStatus(chatId),
  };

  // Access control
  bot.use(createAccessMiddleware({ allowedUsers: config.allowedUsers }));

  // Native commands
  registerCommands(bot, commandDeps);

  // Handle callback queries for tool approval, worker selection, and help pagination
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("tool_")) {
      await approvalManager.handleCallback(ctx.callbackQuery.id, data);
    } else if (data.startsWith("worker_select_")) {
      await handleWorkerSelectCallback(ctx, data, commandDeps);
    } else if (data.startsWith("help_page_")) {
      await handleHelpCallback(ctx, data);
    }
  });

  // Message handler (DM text only)
  bot.on("message:text", async (ctx) => {
    // Only handle DMs (private chats)
    if (ctx.chat.type !== "private") return;
    await handler.handleMessage(ctx);
  });

  // Media handlers (DMs only)
  const mediaHandler = async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;
    await handler.handleMedia(ctx);
  };
  bot.on("message:photo", mediaHandler);
  bot.on("message:document", mediaHandler);
  bot.on("message:audio", mediaHandler);
  bot.on("message:voice", mediaHandler);
  bot.on("message:video", mediaHandler);
  bot.on("message:sticker", mediaHandler);

  // 7. Graceful shutdown
  const shutdown = () => {
    console.log("\n[telegram] Shutting down...");
    stop();
    handler.cleanup();
    renderer.cleanup();
    approvalManager.cleanup();
    connection.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 8. Start polling
  start();
}

main().catch((err) => {
  console.error("[telegram] Fatal error:", err);
  process.exit(1);
});
