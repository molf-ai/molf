import { Cron } from "croner";

/**
 * Parse a duration string like "30s", "5m", "2h", "1d" into milliseconds.
 * Throws on invalid input.
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration: "${input}". Expected format like "30s", "5m", "2h", "1d".`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(value * multipliers[unit]);
}

/**
 * Parse an ISO 8601 datetime string into epoch milliseconds.
 * Throws on invalid input.
 */
export function parseDateTime(input: string): number {
  const ms = new Date(input).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid datetime: "${input}". Expected ISO 8601 format.`);
  }
  return ms;
}

/**
 * Validate a cron expression. Returns true if valid.
 */
export function validateCronExpr(expr: string): boolean {
  try {
    new Cron(expr, { legacyMode: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next occurrence of a cron expression as epoch milliseconds.
 * Returns null if the expression has no future occurrences.
 */
export function nextCronRun(expr: string, tz?: string): number | null {
  const job = new Cron(expr, { legacyMode: false, timezone: tz });
  const next = job.nextRun();
  return next ? next.getTime() : null;
}
