import type { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@molf-ai/server";
import type { AgentEvent } from "@molf-ai/protocol";

type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>;

/**
 * Submit a prompt and wait for the agent to finish (turn_complete or error).
 * The prompt is submitted after a brief delay to allow the event subscription
 * to establish over WebSocket.
 */
export async function promptAndWait(
  trpc: TrpcClient,
  params: { sessionId: string; text: string; fileRefs?: Array<{ path: string; mimeType: string }> },
  timeoutMs = 10_000,
): Promise<{ messageId: string }> {
  return new Promise<{ messageId: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`promptAndWait timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = trpc.agent.onEvents.subscribe(
      { sessionId: params.sessionId },
      {
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

    // Give subscription a moment to connect, then send prompt
    const resultPromise = sleep(100).then(() =>
      trpc.agent.prompt.mutate(params),
    );
  });
}

/**
 * Collect all events for a session until a stop condition is met.
 * Returns the collected events array (populated asynchronously) and an unsubscribe function.
 */
export function collectEvents(
  trpc: TrpcClient,
  sessionId: string,
): { events: AgentEvent[]; unsubscribe: () => void } {
  const events: AgentEvent[] = [];
  const sub = trpc.agent.onEvents.subscribe(
    { sessionId },
    {
      onData: (event) => events.push(event),
    },
  );
  return { events, unsubscribe: () => sub.unsubscribe() };
}

/**
 * Submit a prompt and collect all events until turn_complete.
 * Returns the collected events and the prompt result.
 */
export async function promptAndCollect(
  trpc: TrpcClient,
  params: { sessionId: string; text: string; fileRefs?: Array<{ path: string; mimeType: string }> },
  timeoutMs = 10_000,
): Promise<{ events: AgentEvent[]; messageId: string }> {
  const events: AgentEvent[] = [];

  return new Promise<{ events: AgentEvent[]; messageId: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`promptAndCollect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = trpc.agent.onEvents.subscribe(
      { sessionId: params.sessionId },
      {
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

    const resultPromise = sleep(100).then(() =>
      trpc.agent.prompt.mutate(params),
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
