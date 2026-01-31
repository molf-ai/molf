export function waitForEvent<T extends { type: string }>(
  subscribe: (handler: (event: T) => void) => () => void,
  eventType: string,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for "${eventType}" event after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = subscribe((event) => {
      if (event.type === eventType) {
        clearTimeout(timer);
        unsub();
        resolve(event);
      }
    });
  });
}
