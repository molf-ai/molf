const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export function backoffDelay(attempt: number): number {
  const delay = Math.min(INITIAL_BACKOFF_MS * BACKOFF_MULTIPLIER ** attempt, MAX_BACKOFF_MS);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}
