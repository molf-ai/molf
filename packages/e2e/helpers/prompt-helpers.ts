import type { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent } from "@molf-ai/protocol";

type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>;

const wsIdCache = new Map<string, string>();

/**
 * Get the default workspace ID for a worker. Calls ensureDefault on the
 * first invocation per workerId and caches the result for subsequent calls.
 */
export async function getDefaultWsId(trpc: TrpcClient, workerId: string): Promise<string> {
  const cached = wsIdCache.get(workerId);
  if (cached) return cached;
  const { workspace } = await trpc.workspace.ensureDefault.mutate({ workerId });
  wsIdCache.set(workerId, workspace.id);
  return workspace.id;
}

/** Clear the workspace ID cache between test suites to avoid stale values. */
export function clearWsIdCache(): void {
  wsIdCache.clear();
}

/**
 * Submit a prompt and wait for the agent to finish (turn_complete or error).
 * Uses onStarted to wait for the subscription to be established before sending.
 */
export async function promptAndWait(
  trpc: TrpcClient,
  params: { sessionId: string; text: string; fileRefs?: Array<{ path: string; mimeType: string }> },
  timeoutMs = 10_000,
): Promise<{ messageId: string }> {
  return new Promise<{ messageId: string }>((resolve, reject) => {
    let resultPromise: Promise<{ messageId: string }>;

    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`promptAndWait timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = trpc.agent.onEvents.subscribe(
      { sessionId: params.sessionId },
      {
        onStarted: () => {
          // Subscription is established server-side — safe to send prompt
          resultPromise = trpc.agent.prompt.mutate(params);
        },
        onData: (event) => {
          if (event.type === "turn_complete" || event.type === "error") {
            clearTimeout(timer);
            sub.unsubscribe();
            resolve(resultPromise);
          }
        },
        onError: (err) => {
          clearTimeout(timer);
          sub.unsubscribe();
          reject(err);
        },
      },
    );
  });
}

/**
 * Collect all events for a session until a stop condition is met.
 * Returns the collected events array (populated asynchronously), an unsubscribe
 * function, and a `started` promise that resolves once the subscription is
 * established server-side.
 */
export function collectEvents(
  trpc: TrpcClient,
  sessionId: string,
): { events: AgentEvent[]; started: Promise<void>; unsubscribe: () => void } {
  const events: AgentEvent[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => (resolveStarted = r));
  const sub = trpc.agent.onEvents.subscribe(
    { sessionId },
    {
      onStarted: () => resolveStarted(),
      onData: (event) => events.push(event),
    },
  );
  return { events, started, unsubscribe: () => sub.unsubscribe() };
}

/**
 * Submit a prompt and collect all events until turn_complete.
 * Returns the collected events and the prompt result.
 * Uses onStarted to wait for the subscription to be established before sending.
 */
export async function promptAndCollect(
  trpc: TrpcClient,
  params: { sessionId: string; text: string; fileRefs?: Array<{ path: string; mimeType: string }> },
  timeoutMs = 10_000,
): Promise<{ events: AgentEvent[]; messageId: string }> {
  const events: AgentEvent[] = [];

  return new Promise<{ events: AgentEvent[]; messageId: string }>((resolve, reject) => {
    let resultPromise: Promise<{ messageId: string }>;

    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`promptAndCollect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = trpc.agent.onEvents.subscribe(
      { sessionId: params.sessionId },
      {
        onStarted: () => {
          // Subscription is established server-side — safe to send prompt
          resultPromise = trpc.agent.prompt.mutate(params);
        },
        onData: (event) => {
          events.push(event);
          if (event.type === "turn_complete" || event.type === "error") {
            clearTimeout(timer);
            sub.unsubscribe();
            resultPromise.then(
              (r) => resolve({ events, messageId: r.messageId }),
              reject,
            );
          }
        },
        onError: (err) => {
          clearTimeout(timer);
          sub.unsubscribe();
          reject(err);
        },
      },
    );
  });
}

/**
 * Wait until a condition is met, polling every `intervalMs`.
 * Throws after `timeoutMs` if the condition is never satisfied.
 */
export async function waitUntil(
  check: () => boolean,
  timeoutMs = 5000,
  label = "condition",
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
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
 *
 * Currently a centralized sleep — the server doesn't emit a persistence-complete
 * event. Centralizing the delay here means we can replace it with event-based
 * sync in the future without changing every call site.
 */
export function waitForPersistence(ms = 300): Promise<void> {
  return sleep(ms);
}
