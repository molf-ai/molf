import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getLogger } from "@logtape/logtape";
import type { SessionMap } from "./session-map.js";
import type { ServerConnection } from "./connection.js";
import { escapeHtml } from "./format.js";

const logger = getLogger(["molf", "telegram", "command"]);

export interface CommandDeps {
  sessionMap: SessionMap;
  connection: ServerConnection;
  getWorkerId: () => string;
  setWorkerId: (id: string) => void;
  getAgentStatus: (chatId: number) => string;
  onWorkspaceSwitch?: (workspaceId: string) => void;
  onSessionSwitch?: (chatId: number, sessionId: string) => void;
}

/**
 * Command menu entries registered with Telegram via setMyCommands.
 * Single source of truth for command names and descriptions.
 */
export const COMMAND_MENU = [
  { command: "new", description: "Start a new session" },
  { command: "clear", description: "Start a new session (alias)" },
  { command: "abort", description: "Cancel current task (optionally: /abort new instructions)" },
  { command: "stop", description: "Cancel current task (optionally: /stop new instructions)" },
  { command: "workspace", description: "Switch workspace" },
  { command: "worker", description: "Select a worker" },
  { command: "model", description: "Select a model" },
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
    "",
    "<b>Shell shortcut</b>",
    "",
    "!&lt;command&gt; — run a shell command directly on the worker",
    "Example: !ls -la",
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

  bot.command("workspace", async (ctx) => {
    await handleWorkspace(ctx, deps);
  });

  bot.command("worker", async (ctx) => {
    await handleWorker(ctx, deps);
  });

  bot.command("model", async (ctx) => {
    await handleModel(ctx, deps);
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
    const { workers } = await deps.connection.client.agent.list();
    const worker = workers.find((w) => w.workerId === selectedWorkerId);
    const workerName = worker ? escapeHtml(worker.name) : selectedWorkerId;

    deps.setWorkerId(selectedWorkerId);
    deps.sessionMap.setWorkerId(selectedWorkerId);
    const { resumed } = await deps.sessionMap.switchToLatest(chatId);
    const entry = deps.sessionMap.getEntry(chatId);
    if (entry) deps.onWorkspaceSwitch?.(entry.workspaceId);

    const msg = resumed
      ? `Switched to worker: <b>${workerName}</b>. Resumed previous session.`
      : `Switched to worker: <b>${workerName}</b>. New session started.`;

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        msg,
        { parse_mode: "HTML" },
      );
    } catch {
      // Ignore edit failures
    }
  } catch (err) {
    logger.error("Failed to switch worker", { error: err });
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

/**
 * Handle workspace selection callback queries.
 */
export async function handleWorkspaceSelectCallback(
  ctx: Context,
  data: string,
  deps: CommandDeps,
): Promise<boolean> {
  const match = data.match(/^workspace_select_(.+)$/);
  if (!match) return false;

  const selectedWorkspaceId = match[1];

  try {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id);
  } catch {
    // Ignore
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return true;

  try {
    const workspaces = await deps.connection.client.workspace.list({
      workerId: deps.getWorkerId(),
    });
    const workspace = workspaces.find((ws) => ws.id === selectedWorkspaceId);
    if (!workspace) {
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          ctx.callbackQuery!.message!.message_id,
          "Workspace not found.",
        );
      } catch {
        // Ignore
      }
      return true;
    }

    const sessionName = await resolveSessionName(deps, workspace.lastSessionId);
    deps.sessionMap.switchWorkspace(
      chatId,
      workspace.id,
      workspace.name,
      workspace.lastSessionId,
      sessionName,
    );
    deps.onWorkspaceSwitch?.(workspace.id);

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        `Switched to workspace: <b>${escapeHtml(workspace.name)}</b>`,
        { parse_mode: "HTML" },
      );
    } catch {
      // Ignore
    }
  } catch (err) {
    logger.error("Failed to switch workspace", { error: err });
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        "Failed to switch workspace. Check server connection.",
      );
    } catch {
      // Ignore
    }
  }

  return true;
}

/**
 * Handle session switch callback queries (from workspace event notifications).
 * Handles both "session_switch_{id}" (switch) and "session_stay" (dismiss).
 */
export async function handleSessionSwitchCallback(
  ctx: Context,
  data: string,
  deps: CommandDeps,
): Promise<boolean> {
  if (data === "session_stay") {
    try {
      await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        "Staying on current session.",
      );
    } catch {
      // Ignore
    }
    return true;
  }

  const match = data.match(/^session_switch_(.+)$/);
  if (!match) return false;

  const sessionId = match[1];

  try {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id);
  } catch {
    // Ignore
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return true;

  const entry = deps.sessionMap.getEntry(chatId);
  if (entry) {
    const sessionName = await resolveSessionName(deps, sessionId);
    deps.sessionMap.switchWorkspace(
      chatId,
      entry.workspaceId,
      entry.workspaceName,
      sessionId,
      sessionName,
    );
    deps.onSessionSwitch?.(chatId, sessionId);
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        "Switched to new session.",
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
    logger.error("Failed to create new session", { error: err });
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

  const redirectText = String((ctx as any).match ?? "").trim();

  try {
    const { aborted } = await deps.connection.client.agent.abort({ sessionId });

    if (redirectText) {
      // Cancel + redirect: abort first, then send new prompt
      await deps.connection.client.agent.prompt({ sessionId, text: redirectText });
      await ctx.reply(aborted ? "Cancelled and redirected." : "Redirected.");
    } else {
      if (aborted) {
        await ctx.reply("Agent aborted.");
      } else {
        await ctx.reply("Nothing to abort — agent is idle.");
      }
    }
  } catch (err) {
    logger.error("Failed to abort agent", { error: err });
    await ctx.reply("Failed to abort. Check server connection.");
  }
}

async function handleWorkspace(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // ctx.match contains the text after /workspace
  const arg = String((ctx as any).match ?? "").trim().replace(/^["']|["']$/g, "");

  if (arg) {
    await switchWorkspaceByName(ctx, chatId, arg, deps);
    return;
  }

  try {
    const workspaces = await deps.connection.client.workspace.list({
      workerId: deps.getWorkerId(),
    });

    if (workspaces.length === 0) {
      await ctx.reply("No workspaces available.");
      return;
    }

    const entry = deps.sessionMap.getEntry(chatId);
    const currentWorkspaceId = entry?.workspaceId;
    const currentWs = workspaces.find((ws) => ws.id === currentWorkspaceId);

    const keyboard = new InlineKeyboard();
    for (const ws of workspaces) {
      const isCurrent = ws.id === currentWorkspaceId;
      const label = isCurrent ? `\u2713 ${ws.name}` : ws.name;
      keyboard.text(label, `workspace_select_${ws.id}`).row();
    }

    const header = currentWs
      ? `Current workspace: <b>${escapeHtml(currentWs.name)}</b>`
      : "No workspace selected.";

    await ctx.reply(`${header}\n\nSelect a workspace:`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err) {
    logger.error("Failed to list workspaces", { error: err });
    await ctx.reply("Failed to list workspaces. Check server connection.");
  }
}

async function switchWorkspaceByName(ctx: Context, chatId: number, name: string, deps: CommandDeps) {
  try {
    const workspaces = await deps.connection.client.workspace.list({
      workerId: deps.getWorkerId(),
    });
    const workspace = workspaces.find((ws) => ws.name === name);
    if (!workspace) {
      await ctx.reply(`Workspace "${escapeHtml(name)}" not found.`, { parse_mode: "HTML" });
      return;
    }

    const sessionName = await resolveSessionName(deps, workspace.lastSessionId);
    deps.sessionMap.switchWorkspace(
      chatId,
      workspace.id,
      workspace.name,
      workspace.lastSessionId,
      sessionName,
    );
    deps.onWorkspaceSwitch?.(workspace.id);
    await ctx.reply(`Switched to workspace: <b>${escapeHtml(workspace.name)}</b>`, { parse_mode: "HTML" });
  } catch (err) {
    logger.error("Failed to switch workspace", { error: err });
    await ctx.reply("Failed to switch workspace. Check server connection.");
  }
}

async function handleWorker(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const { workers } = await deps.connection.client.agent.list();

    if (workers.length === 0) {
      await ctx.reply("No workers available.");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const worker of workers) {
      const label = worker.connected
        ? `${worker.name} (${worker.tools.length} tools)`
        : `${worker.name} (offline)`;
      keyboard
        .text(label, `worker_select_${worker.workerId}`)
        .row();
    }

    await ctx.reply("Select a worker:", { reply_markup: keyboard });
  } catch (err) {
    logger.error("Failed to list workers", { error: err });
    await ctx.reply("Failed to list workers. Check server connection.");
  }
}

async function handleModel(ctx: Context, deps: CommandDeps) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    // Show providers first, then models on selection
    const { providers } = await deps.connection.client.provider.listProviders();
    const active = providers.filter((p: any) => p.hasKey);

    if (active.length === 0) {
      await ctx.reply("No providers configured. Set up API keys first.");
      return;
    }

    const keyboard = new InlineKeyboard();
    keyboard.text("Default (server)", "model_select___default").row();
    for (const p of active) {
      keyboard.text(`${p.name} (${p.modelCount} models)`, `model_select_provider_${p.id}`).row();
    }

    await ctx.reply("Select a provider:", { reply_markup: keyboard });
  } catch (err) {
    logger.error("Failed to list models", { error: err });
    await ctx.reply("Failed to list models. Check server connection.");
  }
}

export async function handleModelSelectCallback(
  ctx: Context,
  data: string,
  deps: CommandDeps,
): Promise<boolean> {
  const match = data.match(/^model_select_(.+)$/);
  if (!match) return false;

  const selectedModelId = match[1];

  try {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id);
  } catch {
    // Ignore
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return true;

  try {
    // Provider selection → show models for that provider
    if (selectedModelId.startsWith("provider_")) {
      const providerID = selectedModelId.slice("provider_".length);
      const { models } = await deps.connection.client.provider.listModels({ providerID });
      if (models.length === 0) {
        await ctx.api.editMessageText(chatId, ctx.callbackQuery!.message!.message_id, "No models available for this provider.");
        return true;
      }
      const keyboard = new InlineKeyboard();
      for (const model of models) {
        keyboard.text(model.name, `model_select_${model.id}`).row();
      }
      await ctx.api.editMessageText(chatId, ctx.callbackQuery!.message!.message_id, "Select a model:", { reply_markup: keyboard });
      return true;
    }

    // Ensure workspace + session exist
    await deps.sessionMap.getOrCreate(chatId);
    const entry = deps.sessionMap.getEntry(chatId)!;
    const isDefault = selectedModelId === "__default";

    await deps.connection.client.workspace.setConfig({
      workerId: deps.getWorkerId(),
      workspaceId: entry.workspaceId,
      config: { model: isDefault ? undefined : selectedModelId },
    });

    const msg = isDefault
      ? "Model reset to <b>server default</b> for this workspace."
      : `Model set to <b>${escapeHtml(selectedModelId)}</b> for this workspace.`;

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        msg,
        { parse_mode: "HTML" },
      );
    } catch {
      // Ignore edit failures
    }
  } catch (err) {
    logger.error("Failed to set model", { error: err });
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id,
        "Failed to set model. Check server connection.",
      );
    } catch {
      // Ignore
    }
  }

  return true;
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
    const { workers } = await deps.connection.client.agent.list();
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
      const { sessions } = await deps.connection.client.session.list({ sessionId, limit: 1 });
      if (sessions[0]) {
        messageCount = sessions[0].messageCount;
      }
    } catch {
      // Use fallback values
    }
  }

  const lines = [
    "<b>Status</b>",
    "",
    `<b>Server:</b> ${deps.connection.client ? "Connected" : "Disconnected"}`,
    `<b>Agent:</b> ${escapeHtml(agentStatus)}`,
    `<b>Workspace:</b> ${sessionEntry ? escapeHtml(sessionEntry.workspaceName) : "None"}`,
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

async function resolveSessionName(deps: CommandDeps, sessionId: string): Promise<string> {
  try {
    const { sessions } = await deps.connection.client.session.list({ sessionId, limit: 1 });
    if (sessions[0]) return sessions[0].name;
  } catch { /* use placeholder */ }
  return sessionId.slice(0, 8);
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
