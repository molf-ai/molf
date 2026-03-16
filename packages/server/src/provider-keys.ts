import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync } from "fs";
import { resolve, dirname, join } from "path";
import { randomBytes } from "crypto";

export class ProviderKeyStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "provider-keys.json");
  }

  /** Get all stored keys. */
  getAll(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return {};
    }
  }

  /** Get a key for a specific provider. */
  get(providerID: string): string | undefined {
    return this.getAll()[providerID];
  }

  /** Set a key for a provider. */
  set(providerID: string, key: string): void {
    const keys = this.getAll();
    keys[providerID] = key;
    this.write(keys);
  }

  /** Remove a key for a provider. Returns true if key existed. */
  remove(providerID: string): boolean {
    const keys = this.getAll();
    if (!(providerID in keys)) return false;
    delete keys[providerID];
    this.write(keys);
    return true;
  }

  private write(keys: Record<string, string>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    // Atomic write
    const tmpPath = join(dir, `.provider-keys-tmp-${randomBytes(6).toString("hex")}`);
    writeFileSync(tmpPath, JSON.stringify(keys, null, 2), "utf-8");
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.filePath);
  }
}
