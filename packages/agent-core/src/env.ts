export namespace Env {
  let snapshot: Record<string, string | undefined> | undefined;

  function state(): Record<string, string | undefined> {
    if (!snapshot) snapshot = { ...process.env };
    return snapshot;
  }

  export function get(key: string): string | undefined {
    return state()[key];
  }

  export function all(): Record<string, string | undefined> {
    return { ...state() };
  }

  /** Set a key in the snapshot (for tests). Does NOT modify process.env. */
  export function set(key: string, value: string): void {
    state()[key] = value;
  }

  /** Delete a key from the snapshot (for tests). Does NOT modify process.env. */
  export function delete_(key: string): void {
    delete state()[key];
  }

  /** Reset snapshot (for tests). */
  export function reset(): void {
    snapshot = undefined;
  }
}
