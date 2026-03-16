import { readSecrets, writeSecrets } from "./secrets.js";

export class ProviderKeyStore {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Get all stored keys. */
  getAll(): Record<string, string> {
    return readSecrets(this.dataDir)?.providerKeys ?? {};
  }

  /** Get a key for a specific provider. */
  get(providerID: string): string | undefined {
    return this.getAll()[providerID];
  }

  /** Set a key for a provider. */
  set(providerID: string, key: string): void {
    const secrets = readSecrets(this.dataDir);
    const data = secrets ?? { auth: { masterTokenHash: "", apiKeys: [] }, providerKeys: {} };
    data.providerKeys[providerID] = key;
    writeSecrets(this.dataDir, data);
  }

  /** Remove a key for a provider. Returns true if key existed. */
  remove(providerID: string): boolean {
    const secrets = readSecrets(this.dataDir);
    if (!secrets || !(providerID in secrets.providerKeys)) return false;
    delete secrets.providerKeys[providerID];
    writeSecrets(this.dataDir, secrets);
    return true;
  }
}
