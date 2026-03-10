import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { z } from "zod";
import type { Context } from "grammy";
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { getRotatingFileSink } from "@logtape/file";
import { parseCli, loadCredential, saveCredential, getCredentialsPath } from "@molf-ai/protocol";
import { loadTelegramConfig } from "./config.js";
import { connectToServer, resolveWorkerId } from "./connection.js";
import { createBot } from "./bot.js";
import { createAccessMiddleware } from "./access.js";
import { SessionMap } from "./session-map.js";
import { registerCommands, handleHelpCallback, handleWorkerSelectCallback, handleWorkspaceSelectCallback, handleSessionSwitchCallback, handleModelSelectCallback, setCommandMenu } from "./commands.js";
import { MessageHandler } from "./handler.js";
import { Renderer } from "./renderer.js";
import { ApprovalManager } from "./approval.js";
import { SessionEventDispatcher } from "./event-dispatcher.js";
import { WorkspaceEventDispatcher } from "./workspace-dispatcher.js";
import { InlineKeyboard } from "grammy";
import { escapeHtml } from "./format.js";

const argsSchema = z.object({
  "server-url": z.string().default("ws://127.0.0.1:7600"),
  token: z.string().optional(),
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
        description: "Server auth token or API key",
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

// Resolve token: CLI/env/config → credentials.json
if (!config.token || config.token.length === 0) {
  const saved = loadCredential(config.serverUrl);
  if (saved) {
    config.token = saved.apiKey;
  } else {
    config.token = ""; // will trigger unpaired mode
  }
}

import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";

/**
 * Unpaired mode: starts the Telegram bot, accepts only /pair <code> from allowed users.
 * Returns the API key once pairing succeeds.
 */
async function runUnpairedMode(
  cfg: typeof config,
  logger: ReturnType<typeof getLogger>,
): Promise<string> {
  const { bot, start, stop } = createBot(cfg);

  console.log("Bot started in pairing mode. Send /pair <code> from Telegram to pair.");

  return new Promise<string>((resolve, reject) => {
    // Access control
    bot.use(createAccessMiddleware({ allowedUsers: cfg.allowedUsers }));

    bot.command("pair", async (ctx) => {
      const code = ctx.match?.trim();
      if (!code || !/^\d{6}$/.test(code)) {
        await ctx.reply("Usage: /pair <6-digit code>\n\nGet a pairing code from:\nmolf-server pair --name <device-name>");
        return;
      }

      try {
        await ctx.reply("Pairing...");

        // Create temporary unauthenticated connection with timeout
        const url = new URL(cfg.serverUrl);
        url.searchParams.set("clientId", crypto.randomUUID());
        url.searchParams.set("name", "telegram-pair");

        const { wsClient, trpc: pairTrpc } = await connectForPairing(url.toString());

        try {
          const result = await pairTrpc.auth.redeemPairingCode.mutate({ code });
          saveCredential(cfg.serverUrl, { apiKey: result.apiKey, name: result.name });

          await ctx.reply(
            `Paired as "${result.name}". Credentials saved.\nBot is now connecting to the server...`,
          );

          logger.info("Paired via Telegram", { name: result.name });
          stop();
          resolve(result.apiKey);
        } finally {
          wsClient.close();
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        logger.warn("Pairing failed", { error: msg });
        await ctx.reply(`Pairing failed: ${msg}`);
      }
    });

    // Reject all other messages
    bot.on("message", async (ctx) => {
      await ctx.reply(
        "Bot is not paired with a Molf server yet.\n" +
        "Use /pair <code> to pair.\n\n" +
        "Get a code: molf-server pair --name <device-name>",
      );
    });

    start();
  });
}

const PAIR_CONNECT_TIMEOUT_MS = 5_000;

function connectForPairing(url: string): Promise<{
  wsClient: ReturnType<typeof createWSClient>;
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wsClient.close();
      reject(new Error(`Could not connect to server (timed out after ${PAIR_CONNECT_TIMEOUT_MS / 1000}s)`));
    }, PAIR_CONNECT_TIMEOUT_MS);

    const wsClient = createWSClient({
      url,
      retryDelayMs: () => PAIR_CONNECT_TIMEOUT_MS + 1000,
      onOpen: () => {
        clearTimeout(timeout);
        const trpc = createTRPCClient<AppRouter>({
          links: [wsLink({ client: wsClient })],
        });
        resolve({ wsClient, trpc });
      },
    });
  });
}

async function main() {
  // Configure LogTape logging
  const logLevel = (process.env.MOLF_LOG_LEVEL ?? "info") as "debug" | "info" | "warning" | "error";
  const logFile = process.env.MOLF_LOG_FILE;

  const sinks: Record<string, ReturnType<typeof getConsoleSink>> = {
    console: getConsoleSink({ formatter: getPrettyFormatter({ timestamp: "rfc3339", wordWrap: false, categoryWidth: 18, properties: true }) }),
  };
  const sinkNames: string[] = ["console"];

  if (logFile && logFile !== "none") {
    mkdirSync(dirname(logFile), { recursive: true });
    (sinks as Record<string, unknown>).file = getRotatingFileSink(logFile, {
      formatter: jsonLinesFormatter,
      maxSize: 5 * 1024 * 1024,
      maxFiles: 3,
    });
    sinkNames.push("file");
  }

  await configure({
    sinks,
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: sinkNames },
      { category: ["molf"], lowestLevel: logLevel, sinks: sinkNames },
    ],
  });

  const logger = getLogger(["molf", "telegram"]);

  if (config.allowedUsers.length === 0) {
    logger.warn("No allowed users configured — all messages will be rejected. Set TELEGRAM_ALLOWED_USERS or telegram.allowedUsers in molf.yaml.");
  }

  // If no token, run unpaired mode: bot only accepts /pair <code> until paired
  if (!config.token || config.token.length === 0) {
    logger.info("No server token found. Starting in pairing mode.");
    config.token = await runUnpairedMode(config, logger);
    logger.info("Paired successfully. Continuing with normal operation.");
  }

  // 1. Connect to Molf server
  logger.info("Connecting to server", { serverUrl: config.serverUrl });
  const connection = connectToServer({
    serverUrl: config.serverUrl,
    token: config.token,
  });

  // 2. Resolve worker ID
  let workerId = await resolveWorkerId(connection.trpc, config.workerId);
  logger.info("Using worker", { workerId });

  // 3. Create bot
  const { bot, start, stop } = createBot(config);

  // 4. Create shared state
  const sessionMap = new SessionMap(connection.trpc, workerId);

  // 4a. Restore sessions from previous runs
  try {
    const restored = await sessionMap.restore();
    if (restored > 0) {
      logger.info("Restored sessions from server", { count: restored });
    }
  } catch (err) {
    logger.warn("Failed to restore sessions", { error: err });
  }

  const dispatcher = new SessionEventDispatcher(connection);
  const workspaceDispatcher = new WorkspaceEventDispatcher(connection, workerId);

  // Track workspace event subscriptions (workspaceId → unsub)
  const workspaceEventUnsubs = new Map<string, () => void>();

  function ensureWorkspaceSubscription(workspaceId: string) {
    if (workspaceEventUnsubs.has(workspaceId)) return;

    const unsub = workspaceDispatcher.subscribe(workspaceId, async (event) => {
      if (event.type === "session_created") {
        const chatIds = sessionMap.chatIdsInWorkspace(workspaceId);
        for (const chatId of chatIds) {
          // Skip if this chat already switched to the new session
          if (sessionMap.get(chatId) === event.sessionId) continue;
          try {
            const kb = new InlineKeyboard()
              .text("Switch", `session_switch_${event.sessionId}`)
              .text("Stay", "session_stay");
            await bot.api.sendMessage(
              chatId,
              `New session: <b>${escapeHtml(event.sessionName)}</b>`,
              { parse_mode: "HTML", reply_markup: kb },
            );
          } catch {
            // Ignore send failures
          }
        }
      } else if (event.type === "cron_fired") {
        const chatIds = sessionMap.chatIdsInWorkspace(workspaceId);
        for (const chatId of chatIds) {
          try {
            let text = event.error
              ? `Scheduled task "<b>${escapeHtml(event.jobName)}</b>" failed: ${escapeHtml(event.error)}`
              : `Scheduled task "<b>${escapeHtml(event.jobName)}</b>" fired`;
            if (event.message) {
              text += `\n\n${escapeHtml(event.message)}`;
            }
            const kb = new InlineKeyboard()
              .text("Switch to session", `session_switch_${event.targetSessionId}`)
              .text("Dismiss", "cron_dismiss");
            await bot.api.sendMessage(chatId, text, {
              parse_mode: "HTML",
              reply_markup: kb,
            });
          } catch {
            // Ignore send failures
          }
        }
      }
    });

    workspaceEventUnsubs.set(workspaceId, unsub);
  }

  const renderer = new Renderer({
    api: bot.api,
    dispatcher,
    streamingThrottleMs: config.streamingThrottleMs,
  });

  const approvalManager = new ApprovalManager({
    api: bot.api,
    connection,
    dispatcher,
  });

  const handler = new MessageHandler({
    sessionMap,
    connection,
    renderer,
    approvalManager,
    ackReaction: config.ackReaction,
    botToken: config.botToken,
  });

  // 4b. Start subscriptions for restored sessions
  for (const chatId of sessionMap.activeChatIds()) {
    const sessionId = sessionMap.get(chatId)!;
    renderer.startSession(chatId, sessionId);
    approvalManager.watchSession(chatId, sessionId);
  }

  // 4c. Subscribe to workspace events for all known workspaces
  try {
    const workspaces = await connection.trpc.workspace.list.query({ workerId });
    for (const ws of workspaces) {
      ensureWorkspaceSubscription(ws.id);
    }
  } catch (err) {
    logger.warn("Failed to subscribe to workspace events", { error: err });
  }

  // 5. Register command menu with Telegram
  await setCommandMenu(bot.api);

  // 6. Set up middleware chain

  // Command deps with mutable workerId
  const commandDeps = {
    sessionMap,
    connection,
    getWorkerId: () => workerId,
    setWorkerId: (id: string) => {
      workerId = id;
      workspaceDispatcher.setWorkerId(id);
    },
    getAgentStatus: (chatId: number) => renderer.getAgentStatus(chatId),
    onWorkspaceSwitch: (workspaceId: string) => ensureWorkspaceSubscription(workspaceId),
    onSessionSwitch: (chatId: number, sessionId: string) => {
      renderer.startSession(chatId, sessionId);
      approvalManager.watchSession(chatId, sessionId);
    },
  };

  // Access control
  bot.use(createAccessMiddleware({ allowedUsers: config.allowedUsers }));

  // Native commands
  registerCommands(bot, commandDeps);

  // Handle callback queries for tool approval, worker/workspace selection, and help pagination
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("tool_")) {
      await approvalManager.handleCallback(ctx.callbackQuery.id, data);
    } else if (data.startsWith("worker_select_")) {
      await handleWorkerSelectCallback(ctx, data, commandDeps);
    } else if (data.startsWith("workspace_select_")) {
      await handleWorkspaceSelectCallback(ctx, data, commandDeps);
    } else if (data.startsWith("session_switch_") || data === "session_stay") {
      await handleSessionSwitchCallback(ctx, data, commandDeps);
    } else if (data === "cron_dismiss") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } else if (data.startsWith("model_select_")) {
      await handleModelSelectCallback(ctx, data, commandDeps);
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
    logger.info("Shutting down...");
    stop();
    handler.cleanup();
    renderer.cleanup();
    approvalManager.cleanup();
    for (const unsub of workspaceEventUnsubs.values()) unsub();
    workspaceDispatcher.cleanup();
    dispatcher.cleanup();
    connection.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 8. Start polling
  start();
}

main().catch((err) => {
  const logger = getLogger(["molf", "telegram"]);
  logger.error("Fatal error", { error: err });
  process.exit(1);
});
