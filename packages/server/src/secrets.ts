import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { resolve, dirname, join } from "path";
import { randomBytes } from "crypto";
import type { ApiKeyEntry } from "./auth.js";

export interface SecretsData {
  auth: {
    masterTokenHash: string;
    apiKeys: ApiKeyEntry[];
  };
  providerKeys: Record<string, string>;
}

const SECRETS_FILE = "secrets.json";

/**
 * Read secrets from `{dataDir}/secrets.json`.
 * On first read, migrates from legacy `server.json` + `provider-keys.json` if they exist.
 */
export function readSecrets(dataDir: string): SecretsData | null {
  const secretsPath = resolve(dataDir, SECRETS_FILE);

  if (!existsSync(secretsPath)) {
    // Attempt migration from legacy files
    const migrated = migrateFromLegacy(dataDir);
    if (migrated) return migrated;
    return null;
  }

  try {
    return JSON.parse(readFileSync(secretsPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write secrets to `{dataDir}/secrets.json` atomically with 0o600 permissions.
 */
export function writeSecrets(dataDir: string, data: SecretsData): void {
  mkdirSync(dataDir, { recursive: true });
  const secretsPath = resolve(dataDir, SECRETS_FILE);
  const tmpPath = join(dirname(secretsPath), `.secrets-tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, secretsPath);
}

/**
 * Migrate legacy `server.json` and `provider-keys.json` into `secrets.json`.
 * Deletes the old files on success. Returns the merged data, or null if no legacy files exist.
 */
function migrateFromLegacy(dataDir: string): SecretsData | null {
  const serverJsonPath = resolve(dataDir, "server.json");
  const providerKeysPath = resolve(dataDir, "provider-keys.json");

  const hasServerJson = existsSync(serverJsonPath);
  const hasProviderKeys = existsSync(providerKeysPath);

  if (!hasServerJson && !hasProviderKeys) return null;

  // Read legacy auth data
  let auth: SecretsData["auth"] = { masterTokenHash: "", apiKeys: [] };
  if (hasServerJson) {
    try {
      const raw = JSON.parse(readFileSync(serverJsonPath, "utf-8"));
      // Handle old format: { tokenHash } → { masterTokenHash }
      const masterTokenHash = raw.masterTokenHash ?? raw.tokenHash ?? "";
      auth = { masterTokenHash, apiKeys: raw.apiKeys ?? [] };
    } catch {
      // Corrupt file — use empty auth
    }
  }

  // Read legacy provider keys
  let providerKeys: Record<string, string> = {};
  if (hasProviderKeys) {
    try {
      providerKeys = JSON.parse(readFileSync(providerKeysPath, "utf-8"));
    } catch {
      // Corrupt file — use empty keys
    }
  }

  const merged: SecretsData = { auth, providerKeys };
  writeSecrets(dataDir, merged);

  // Delete legacy files
  if (hasServerJson) unlinkSync(serverJsonPath);
  if (hasProviderKeys) unlinkSync(providerKeysPath);

  return merged;
}
