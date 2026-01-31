export interface EnvGuard {
  /** Set an env var for the duration of the test. */
  set(key: string, value: string): void;
  /** Delete an env var for the duration of the test. */
  delete(key: string): void;
  /** Restore all env vars to their original state. Call in afterAll/afterEach. */
  restore(): void;
}

export function createEnvGuard(): EnvGuard {
  const originals = new Map<string, string | undefined>();

  return {
    set(key: string, value: string) {
      if (!originals.has(key)) {
        originals.set(key, process.env[key]);
      }
      process.env[key] = value;
    },
    delete(key: string) {
      if (!originals.has(key)) {
        originals.set(key, process.env[key]);
      }
      delete process.env[key];
    },
    restore() {
      for (const [key, value] of originals) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      originals.clear();
    },
  };
}
