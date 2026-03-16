import { os, authMiddleware } from "../context.js";
import type { ConfigEvent } from "../server-bus.js";

export const serverHandlers = {
  onEvents: os.server.onEvents
    .use(authMiddleware)
    .handler(async function* ({ context, signal }) {
      const queue: ConfigEvent[] = [];
      let resolve: (() => void) | null = null;

      const unsub = context.serverBus.subscribe(
        { type: "global" },
        (event: any) => {
          queue.push(event as ConfigEvent);
          if (resolve) {
            resolve();
            resolve = null;
          }
        },
      );

      try {
        while (!signal?.aborted) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            await new Promise<void>((r) => {
              resolve = r;
              if (signal) {
                signal.addEventListener("abort", () => r(), { once: true });
              }
            });
          }
        }
      } finally {
        unsub();
      }
    }),
};
