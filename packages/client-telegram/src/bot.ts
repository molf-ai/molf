import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { getLogger } from "@logtape/logtape";
import type { TelegramConfig } from "./config.js";

const logger = getLogger(["molf", "telegram", "bot"]);

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
    logger.error("Unhandled error in middleware", { error: err });
  });

  let stopped = false;

  return {
    bot,
    start: () => {
      if (stopped) return;
      logger.info("Starting bot polling...");
      bot.start({
        onStart: (me) => {
          logger.info("Bot is running", { username: me.username });
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
