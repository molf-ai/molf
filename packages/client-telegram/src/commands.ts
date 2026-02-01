import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { SessionMap } from "./session-map.js";
import type { ServerConnection } from "./connection.js";
import { escapeHtml } from "./format.js";

export interface CommandDeps {
  sessionMap: SessionMap;
  connection: ServerConnection;
  getWorkerId: () => string;
  setWorkerId: (id: string) => void;
  getAgentStatus: (chatId: number) => string;
}

/**
 * Command menu entries registered with Telegram via setMyCommands.
 * Single source of truth for command names and descriptions.
 */
export const COMMAND_MENU = [
  { command: "new", description: "Start a new session" },
  { command: "clear", description: "Start a new session (alias)" },
  { command: "abort", description: "Cancel the running agent" },
  { command: "stop", description: "Cancel the running agent (alias)" },
  { command: "worker", description: "Select a worker" },
  { command: "status", description: "Show connection and session status" },
  { command: "help", description: "Show help message" },
];

/**
 * Register the command menu with Telegram so commands appear in the "/" autocomplete.
 */
export async function setCommandMenu(api: { setMyCommands: (commands: typeof COMMAND_MENU) => Promise<unknown> }) {
  await api.setMyCommands(COMMAND_MENU);
}

/**
 * Help pages. Each page is a string of HTML content.
 * Currently fits in one page, but structured for extensibility.
 */
export const HELP_PAGES: string[] = [
  [
    "<b>Commands</b>",
    "",
    ...COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`),
  ].join("\n"),
];

/**
 * Register native bot commands.
 */
export function registerCommands(
  bot: {
    command: (cmd: string, handler: (ctx: Context) => Promise<void>) => void;
  },
  deps: CommandDeps,
) {
  bot.command("new", async (ctx) => {
    await handleNew(ctx, deps);
  });

  bot.command("clear", async (ctx) => {
    await handleNew(ctx, deps);
  });

  bot.command("abort", async (ctx) => {
    await handleAbort(ctx, deps);
  });

  bot.command("stop", async (ctx) => {
    await handleAbort(ctx, deps);
  });

  bot.command("worker", async (ctx) => {
    await handleWorker(ctx, deps);
  });

  bot.command("status", async (ctx) => {
    await handleStatus(ctx, deps);
  });

  bot.command("help", async (ctx) => {
    await handleHelp(ctx, 0);
  });
}

/**
 * Handle help pagination callback queries.
 * Call this from the bot's callback_query handler for data matching "help_page_*".
 */
export async function handleHelpCallback(ctx: Context, data: string): Promise<boolean> {
  const match = data.match(/^help_page_(\d+)$/);
  if (!match) return false;

  const page = parseInt(match[1], 10);
  if (page < 0 || page >= HELP_PAGES.length) return false;

  try {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id);
  } catch {
    // Ignore
  }

  const keyboard = buildHelpKeyboard(page);
  try {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id,
      HELP_PAGES[page],
      {
        parse_mode: "HTML",
        reply_markup: keyboard ?? undefined,
      },
    );
  } catch {
    // Ignore edit failures (e.g., message not modified)
  }

  return true;
}

/**
 * Handle worker selection callback queries.
 * Call this from the bot's callback_query handler for data matching "worker_select_*".
 */
export async function handleWorkerSelectCallback(
  ctx: Context,
  data: string,
  deps: CommandDeps,
): Promise<boolean> {
  const match = data.match(/^worker_select_(.+)$/);
  if (!match) return false;

  const selectedWorkerId = match[1];

  try {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id);
  } catch {
    // Ignore
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return true;

  try {
    // Query workers to get the name for the selected worker
    const { workers } = await deps.connection.trpc.agent.list.query();
    const worker = workers.find((w) => w.workerId === selectedWorkerId);
    const workerName = worker ? escapeHtml(worker.name) : selectedWorkerId;

    deps.setWorkerId(selectedWorkerId);
    deps.sessionMap.setWorkerId(selectedWorkerId);
    await deps.sessionMap.createNew(chatId);

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        `Switched to worker: <b>${workerName}</b>. New session started.`,
        { parse_mode: "HTML" },
      );
    } catch {
      // Ignore edit failures
    }
  } catch (err) {
    console.error("[telegram] Failed to switch worker:", err);
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        "Failed to switch worker. Check server connection.",
      );
    } catch {
      // Ignore
    }
  }

  return true;
}

async function handleNew(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    await deps.sessionMap.createNew(chatId);
    await ctx.reply("New session started.", { parse_mode: undefined });
  } catch (err) {
    console.error("[telegram] Failed to create new session:", err);
    await ctx.reply("Failed to create new session. Check server connection.");
  }
}

async function handleAbort(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = deps.sessionMap.get(chatId);
  if (!sessionId) {
    await ctx.reply("No active session.");
    return;
  }

  try {
    const { aborted } = await deps.connection.trpc.agent.abort.mutate({ sessionId });
    if (aborted) {
      await ctx.reply("Agent aborted.");
    } else {
      await ctx.reply("Nothing to abort — agent is idle.");
    }
  } catch (err) {
    console.error("[telegram] Failed to abort agent:", err);
    await ctx.reply("Failed to abort. Check server connection.");
  }
}

async function handleWorker(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const { workers } = await deps.connection.trpc.agent.list.query();

    if (workers.length === 0) {
      await ctx.reply("No workers available.");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const worker of workers) {
      keyboard
        .text(
          `${worker.name} (${worker.tools.length} tools)`,
          `worker_select_${worker.workerId}`,
        )
        .row();
    }

    await ctx.reply("Select a worker:", { reply_markup: keyboard });
  } catch (err) {
    console.error("[telegram] Failed to list workers:", err);
    await ctx.reply("Failed to list workers. Check server connection.");
  }
}

async function handleStatus(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const sessionId = deps.sessionMap.get(chatId);
  const sessionEntry = deps.sessionMap.getEntry(chatId);
  const agentStatus = deps.getAgentStatus(chatId);

  let workerName = deps.getWorkerId();
  let toolCount = 0;
  let messageCount = 0;

  try {
    const { workers } = await deps.connection.trpc.agent.list.query();
    const worker = workers.find((w) => w.workerId === deps.getWorkerId());
    if (worker) {
      workerName = worker.name;
      toolCount = worker.tools.length;
    }
  } catch {
    // Use fallback values
  }

  if (sessionId) {
    try {
      const { sessions } = await deps.connection.trpc.session.list.query();
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (session) {
        messageCount = session.messageCount;
      }
    } catch {
      // Use fallback values
    }
  }

  const lines = [
    "<b>Status</b>",
    "",
    `<b>Server:</b> ${deps.connection.trpc ? "Connected" : "Disconnected"}`,
    `<b>Agent:</b> ${escapeHtml(agentStatus)}`,
    `<b>Session:</b> ${sessionEntry ? escapeHtml(sessionEntry.sessionName) : "None"}`,
    `<b>Session ID:</b> ${sessionId ? `<code>${escapeHtml(sessionId)}</code>` : "None"}`,
    `<b>Messages:</b> ${messageCount}`,
    `<b>Worker:</b> ${escapeHtml(workerName)}`,
    `<b>Tools:</b> ${toolCount}`,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function handleHelp(ctx: Context, page: number) {
  const keyboard = buildHelpKeyboard(page);
  await ctx.reply(HELP_PAGES[page], {
    parse_mode: "HTML",
    reply_markup: keyboard ?? undefined,
  });
}

function buildHelpKeyboard(page: number): InlineKeyboard | null {
  if (HELP_PAGES.length <= 1) return null;

  const keyboard = new InlineKeyboard();

  if (page > 0) {
    keyboard.text("< Prev", `help_page_${page - 1}`);
  }
  if (page < HELP_PAGES.length - 1) {
    keyboard.text("Next >", `help_page_${page + 1}`);
  }

  return keyboard;
}
