import type { Context, NextFunction } from "grammy";

export interface AccessConfig {
  allowedUsers: string[];
}

/**
 * Parse the allowlist into sets of numeric IDs and lowercase usernames.
 */
export function parseAllowlist(raw: string[]): {
  ids: Set<number>;
  usernames: Set<string>;
} {
  const ids = new Set<number>();
  const usernames = new Set<string>();

  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("@")) {
      usernames.add(trimmed.slice(1).toLowerCase());
    } else {
      const num = Number(trimmed);
      if (Number.isInteger(num)) {
        ids.add(num);
      } else {
        // Treat as username without @
        usernames.add(trimmed.toLowerCase());
      }
    }
  }

  return { ids, usernames };
}

/**
 * Check if a user is allowed based on their Telegram user ID and username.
 */
export function isUserAllowed(
  userId: number,
  username: string | undefined,
  allowlist: { ids: Set<number>; usernames: Set<string> },
): boolean {
  // Empty allowlist means allow everyone
  if (allowlist.ids.size === 0 && allowlist.usernames.size === 0) return true;

  if (allowlist.ids.has(userId)) return true;
  if (username && allowlist.usernames.has(username.toLowerCase())) return true;

  return false;
}

/**
 * Create a grammY middleware that rejects messages from non-allowed users.
 */
export function createAccessMiddleware(config: AccessConfig) {
  const allowlist = parseAllowlist(config.allowedUsers);

  return async (ctx: Context, next: NextFunction) => {
    const user = ctx.from;
    if (!user) return; // No user info, silently ignore

    if (!isUserAllowed(user.id, user.username, allowlist)) {
      // Silently reject — don't reveal the bot is active to unauthorized users
      return;
    }

    await next();
  };
}
