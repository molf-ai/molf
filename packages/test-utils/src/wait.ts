/**
 * Poll a condition until it returns true, or throw after a timeout.
 *
 * Preferred over `Bun.sleep` / `setTimeout` in tests — makes the test
 * deterministic by expressing *what* it waits for rather than *how long*.
 */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition",
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

/**
 * Flush pending microtasks and one macro-task cycle.
 *
 * Use after fire-and-forget async work (e.g. event emission, persistence)
 * when there's no observable condition to poll. Prefer `waitUntil` when
 * a concrete condition exists.
 */
export function flushAsync(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
