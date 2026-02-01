import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { TelegramConfig } from "./config.js";

export interface BotInstance {
  bot: Bot;
  start: () => void;
  stop: () => void;
}

export function createBot(config: TelegramConfig): BotInstance {
  const bot = new Bot(config.botToken);

  // Apply API throttler to prevent rate-limit errors during streaming edits
  bot.api.config.use(apiThrottler());

  // Error boundary: log errors but don't crash the polling loop
  bot.catch((err) => {
    console.error("[telegram] Unhandled error in middleware:", err.message);
  });

  let stopped = false;

  return {
    bot,
    start: () => {
      if (stopped) return;
      console.log("[telegram] Starting bot polling...");
      bot.start({
        onStart: (me) => {
          console.log(`[telegram] Bot @${me.username} is running`);
        },
      });
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      bot.stop();
    },
  };
}
