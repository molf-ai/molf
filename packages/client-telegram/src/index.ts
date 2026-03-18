import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { z } from "zod";
import type { Context } from "grammy";
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { getRotatingFileSink } from "@logtape/file";
import { parseCli, loadServer, loadTlsCertPem, resolveTlsTrust, tlsTrustToWsOpts } from "@molf-ai/protocol";
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
import { SetupGate } from "./setup-gate.js";
import { InlineKeyboard } from "grammy";
import { escapeHtml } from "./format.js";

const argsSchema = z.object({
  "server-url": z.string().default("wss://127.0.0.1:7600"),
  token: z.string().optional(),
  "worker-id": z.string().optional(),
  "bot-token": z.string().optional(),
  "allowed-users": z.string().optional(),
  "tls-ca": z.string().transform((p) => resolve(p)).optional(),
});

const args = parseCli(
  {
    name: "molf-telegram",
    version: "0.1.0",
    description: "Molf Telegram bot client",
    options: {
      "server-url": {
        type: "string",
        short: "s",
        description: "WebSocket server URL",
        default: "wss://127.0.0.1:7600",
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
      "tls-ca": {
        type: "string",
        description: "Path to trusted CA certificate PEM file",
        env: "MOLF_TLS_CA",
      },
    },
    schema: argsSchema,
  },
);

const config = loadTelegramConfig({
  botToken: args["bot-token"],
  serverUrl: args["server-url"],
  token: args.token,
  workerId: args["worker-id"],
  allowedUsers: args["allowed-users"],
});

if (!config.botToken) {
  console.error("Error: Telegram bot token is required.");
  console.error("Provide via --bot-token or TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

// Resolve token and TLS trust (no network connections yet)
const savedEntry = loadServer(config.serverUrl);
if (!config.token || config.token.length === 0) {
  if (savedEntry?.apiKey) {
    config.token = savedEntry.apiKey;
  } else {
    config.token = ""; // will trigger pairing via setup gate
  }
}

const savedCertPem = loadTlsCertPem(config.serverUrl);
const tlsTrust = resolveTlsTrust({
  serverUrl: config.serverUrl,
  tlsCaPath: args["tls-ca"],
  savedCertPem: savedCertPem ?? undefined,
});
const tlsOpts = tlsTrust ? tlsTrustToWsOpts(tlsTrust) : undefined;

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
    logger.warn("No allowed users configured — all messages will be rejected. Set TELEGRAM_ALLOWED_USERS env var or --allowed-users flag.");
  }

  // 1. Create setup gate (determines if TLS approval / pairing is needed)
  const gate = new SetupGate({
    serverUrl: config.serverUrl,
    token: config.token,
    tlsTrust,
    tlsOpts,
  });

  // 2. Create bot (single instance for entire lifecycle)
  const { bot, start, stop } = createBot(config);

  // 3. Install middleware chain
  //    access control → setup gate → normal handlers
  bot.use(createAccessMiddleware({ allowedUsers: config.allowedUsers }));
  bot.use(gate.middleware());

  // 4. Register normal handlers (blocked by gate middleware until setup completes)

  // These are initialized after gate.waitReady() resolves.
  // The gate middleware prevents any updates from reaching these handlers until ready.
  let commandDeps: Parameters<typeof registerCommands>[1] | null = null;
  let handler: MessageHandler | null = null;
  // approvalMgr is declared below after connectToServer; callbacks use it via closure.

  // Native commands
  registerCommands(bot, {
    get sessionMap() { return commandDeps!.sessionMap; },
    get connection() { return commandDeps!.connection; },
    get getWorkerId() { return commandDeps!.getWorkerId; },
    get setWorkerId() { return commandDeps!.setWorkerId; },
    get getAgentStatus() { return commandDeps!.getAgentStatus; },
    get onWorkspaceSwitch() { return commandDeps!.onWorkspaceSwitch; },
    get onSessionSwitch() { return commandDeps!.onSessionSwitch; },
  });

  // Handle callback queries
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("tool_")) {
      await approvalMgr!.handleCallback(ctx.callbackQuery.id, data);
    } else if (data.startsWith("worker_select_")) {
      await handleWorkerSelectCallback(ctx, data, commandDeps!);
    } else if (data.startsWith("workspace_select_")) {
      await handleWorkspaceSelectCallback(ctx, data, commandDeps!);
    } else if (data.startsWith("session_switch_") || data === "session_stay") {
      await handleSessionSwitchCallback(ctx, data, commandDeps!);
    } else if (data === "cron_dismiss") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } else if (data.startsWith("model_select_")) {
      await handleModelSelectCallback(ctx, data, commandDeps!);
    } else if (data.startsWith("help_page_")) {
      await handleHelpCallback(ctx, data);
    }
  });

  // Message handler (DM text only)
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await handler!.handleMessage(ctx);
  });

  // Media handlers (DMs only)
  const mediaHandler = async (ctx: Context) => {
    if (ctx.chat?.type !== "private") return;
    await handler!.handleMedia(ctx);
  };
  bot.on("message:photo", mediaHandler);
  bot.on("message:document", mediaHandler);
  bot.on("message:audio", mediaHandler);
  bot.on("message:voice", mediaHandler);
  bot.on("message:video", mediaHandler);
  bot.on("message:sticker", mediaHandler);

  // 5. Start polling immediately — bot is responsive during setup
  start();

  // 6. Wait for setup to complete (TLS approval + pairing via Telegram)
  const setupResult = await gate.waitReady();
  logger.info("Setup complete, connecting to server", { serverUrl: config.serverUrl });

  // 7. Initialize server connection and normal operation
  const resolvedTlsOpts = setupResult.tlsTrust ? tlsTrustToWsOpts(setupResult.tlsTrust) : undefined;

  // Dispatchers and managers are initialized below; onReconnect captures them via closure.
  let dispatcher: SessionEventDispatcher;
  let workspaceDispatcher: WorkspaceEventDispatcher;
  let renderer: Renderer;
  let approvalMgr: ApprovalManager;
  let sessionMap: SessionMap;

  const connection = await connectToServer({
    serverUrl: config.serverUrl,
    token: setupResult.token,
    tlsOpts: resolvedTlsOpts,
    onReconnect: () => {
      logger.info("Reconnected — re-subscribing all sessions and workspaces");
      dispatcher.resubscribeAll();
      workspaceDispatcher.resubscribeAll();
    },
  });

  let workerId = await resolveWorkerId(connection.client, config.workerId);
  logger.info("Using worker", { workerId });

  sessionMap = new SessionMap(connection.client, workerId);

  // Restore sessions from previous runs
  try {
    const restored = await sessionMap.restore();
    if (restored > 0) {
      logger.info("Restored sessions from server", { count: restored });
    }
  } catch (err) {
    logger.warn("Failed to restore sessions", { error: err });
  }

  dispatcher = new SessionEventDispatcher(connection);
  workspaceDispatcher = new WorkspaceEventDispatcher(connection, workerId);

  const workspaceEventUnsubs = new Map<string, () => void>();

  function ensureWorkspaceSubscription(workspaceId: string) {
    if (workspaceEventUnsubs.has(workspaceId)) return;

    const unsub = workspaceDispatcher.subscribe(workspaceId, async (event) => {
      if (event.type === "session_created") {
        const chatIds = sessionMap.chatIdsInWorkspace(workspaceId);
        for (const chatId of chatIds) {
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

  renderer = new Renderer({
    api: bot.api,
    dispatcher,
  });

  approvalMgr = new ApprovalManager({
    api: bot.api,
    connection,
    dispatcher,
  });

  handler = new MessageHandler({
    sessionMap,
    connection,
    renderer,
    approvalManager: approvalMgr,
    botToken: config.botToken,
  });

  // Wire up command deps now that everything is initialized
  commandDeps = {
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
      approvalMgr!.watchSession(chatId, sessionId);
    },
  };

  // Start subscriptions for restored sessions
  for (const chatId of sessionMap.activeChatIds()) {
    const sessionId = sessionMap.get(chatId)!;
    renderer.startSession(chatId, sessionId);
    approvalMgr.watchSession(chatId, sessionId);
  }

  // Subscribe to workspace events for all known workspaces
  try {
    const workspaces = await connection.client.workspace.list({ workerId });
    for (const ws of workspaces) {
      ensureWorkspaceSubscription(ws.id);
    }
  } catch (err) {
    logger.warn("Failed to subscribe to workspace events", { error: err });
  }

  // Register command menu with Telegram
  await setCommandMenu(bot.api);

  // 8. Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    stop();
    handler!.cleanup();
    renderer.cleanup();
    approvalMgr!.cleanup();
    for (const unsub of workspaceEventUnsubs.values()) unsub();
    workspaceDispatcher.cleanup();
    dispatcher.cleanup();
    connection.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  const logger = getLogger(["molf", "telegram"]);
  logger.error("Fatal error", { error: err });
  process.exit(1);
});
