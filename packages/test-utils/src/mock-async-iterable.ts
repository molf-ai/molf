/** A controllable async iterable for mocking subscriptions. */
export interface MockAsyncIterable {
  push: (value: any) => void;
  throw: (error?: Error) => void;
  end: () => void;
}

export function createMockAsyncIterable(): MockAsyncIterable & AsyncIterable<any> {
  const queue: Array<{ value: any; done: boolean; error?: Error }> = [];
  let resolve: ((v: any) => void) | null = null;
  let ended = false;
  let thrownError: Error | null = null;

  const iterable: AsyncIterable<any> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<any>> {
          if (thrownError) {
            const err = thrownError;
            thrownError = null;
            return Promise.reject(err);
          }
          if (queue.length > 0) {
            const item = queue.shift()!;
            if (item.error) return Promise.reject(item.error);
            return Promise.resolve({ value: item.value, done: item.done });
          }
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => { resolve = r; });
        },
      };
    },
  };

  const controller: MockAsyncIterable = {
    push(value: any) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value, done: false });
      } else {
        queue.push({ value, done: false });
      }
    },
    throw(error = new Error("disconnected")) {
      thrownError = error;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r(Promise.reject(error));
      }
    },
    end() {
      ended = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
  };

  return Object.assign(iterable, controller);
}
