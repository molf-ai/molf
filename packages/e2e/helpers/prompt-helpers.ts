import type { RpcClient } from "@molf-ai/protocol";
import type { AgentEvent } from "@molf-ai/protocol";

const wsIdCache = new Map<string, string>();

/**
 * Get the default workspace ID for a worker. Calls ensureDefault on the
 * first invocation per workerId and caches the result for subsequent calls.
 */
export async function getDefaultWsId(client: RpcClient, workerId: string): Promise<string> {
  const cached = wsIdCache.get(workerId);
  if (cached) return cached;
  const { workspace } = await client.workspace.ensureDefault({ workerId });
  wsIdCache.set(workerId, workspace.id);
  return workspace.id;
}

/** Clear the workspace ID cache between test suites to avoid stale values. */
export function clearWsIdCache(): void {
  wsIdCache.clear();
}

/**
 * Submit a prompt and wait for the agent to finish (turn_complete or error).
 * The await on client.agent.onEvents() resolves when the subscription is
 * established, replacing tRPC's onStarted callback.
 */
export async function promptAndWait(
  client: RpcClient,
  params: { sessionId: string; text: string; fileRefs?: Array<{ path: string; mimeType: string }> },
  timeoutMs = 10_000,
): Promise<{ messageId: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const iter = await client.agent.onEvents({ sessionId: params.sessionId });
    // Subscription established — safe to send prompt
    const resultPromise = client.agent.prompt(params);

    for await (const event of iter) {
      if (abort.signal.aborted) break;
      if (event.type === "turn_complete" || event.type === "error") {
        clearTimeout(timer);
        abort.abort();
        return resultPromise;
      }
    }

    throw new Error(`promptAndWait: subscription ended without turn_complete`);
  } catch (err) {
    if (abort.signal.aborted && (err as Error)?.name !== "AbortError") {
      throw new Error(`promptAndWait timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect all events for a session until stopped.
 * Returns the collected events array (populated asynchronously), an abort
 * function, and a `started` promise that resolves once the subscription is
 * established server-side.
 */
export function collectEvents(
  client: RpcClient,
  sessionId: string,
): { events: AgentEvent[]; started: Promise<void>; unsubscribe: () => void } {
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => (resolveStarted = r));
  let iterRef: AsyncIterableIterator<any> | null = null;

  (async () => {
    try {
      const iter = await client.agent.onEvents({ sessionId });
      iterRef = iter[Symbol.asyncIterator]();
      resolveStarted();
      for await (const event of iterRef) {
        if (abort.signal.aborted) break;
        events.push(event as AgentEvent);
      }
    } catch {
      // subscription ended
    }
  })();

  return {
    events,
    started,
    unsubscribe: () => {
      abort.abort();
      // Explicitly signal the server to close the iterator
      iterRef?.return?.(undefined);
    },
  };
}

/**
 * Submit a prompt and collect all events until turn_complete.
 * Returns the collected events and the prompt result.
 */
export async function promptAndCollect(
  client: RpcClient,
  params: { sessionId: string; text: string; fileRefs?: Array<{ path: string; mimeType: string }> },
  timeoutMs = 10_000,
): Promise<{ events: AgentEvent[]; messageId: string }> {
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const iter = await client.agent.onEvents({ sessionId: params.sessionId });
    // Subscription established — safe to send prompt
    const resultPromise = client.agent.prompt(params);

    for await (const event of iter) {
      if (abort.signal.aborted) break;
      events.push(event as AgentEvent);
      if (event.type === "turn_complete" || event.type === "error") {
        clearTimeout(timer);
        abort.abort();
        const result = await resultPromise;
        return { events, messageId: result.messageId };
      }
    }

    throw new Error(`promptAndCollect: subscription ended without turn_complete`);
  } catch (err) {
    if (abort.signal.aborted && (err as Error)?.name !== "AbortError") {
      throw new Error(`promptAndCollect timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until a condition is met, polling every `intervalMs`.
 * Throws after `timeoutMs` if the condition is never satisfied.
 */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "condition",
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

/** Simple sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for async persistence (session save, cache eviction, etc.) to settle.
 */
export function waitForPersistence(ms = 300): Promise<void> {
  return sleep(ms);
}
