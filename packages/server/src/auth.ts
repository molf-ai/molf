import { getLogger } from "@logtape/logtape";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { timingSafeEqual } from "crypto";

const logger = getLogger(["molf", "server", "auth"]);

// --- Types ---

export interface ApiKeyEntry {
  id: string;
  name: string;
  hash: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface ServerAuthData {
  masterTokenHash: string;
  apiKeys: ApiKeyEntry[];
}

export interface CredentialResult {
  valid: boolean;
  type: "master" | "apiKey" | null;
  keyId?: string;
  keyName?: string;
}

// --- Helpers ---

function hashCredential(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // base64url encoding (no padding)
  const b64 = Buffer.from(bytes).toString("base64url");
  return `yk_${b64}`;
}

// --- server.json I/O ---

function readAuthData(dataDir: string): ServerAuthData | null {
  const serverJsonPath = resolve(dataDir, "server.json");
  if (!existsSync(serverJsonPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(serverJsonPath, "utf-8"));

    // Migrate old format: { tokenHash } → { masterTokenHash, apiKeys }
    if (raw.tokenHash && !raw.masterTokenHash) {
      return { masterTokenHash: raw.tokenHash, apiKeys: raw.apiKeys ?? [] };
    }

    return {
      masterTokenHash: raw.masterTokenHash,
      apiKeys: raw.apiKeys ?? [],
    };
  } catch {
    return null;
  }
}

function writeAuthData(dataDir: string, data: ServerAuthData): void {
  const serverJsonPath = resolve(dataDir, "server.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(serverJsonPath, JSON.stringify(data, null, 2));
}

// --- Public API ---

export function initAuth(dataDir: string, fixedToken?: string): { token: string } {
  const token = fixedToken ?? generateToken();
  const masterHash = hashCredential(token);

  // Preserve existing API keys across restarts
  const existing = readAuthData(dataDir);
  const apiKeys = existing?.apiKeys ?? [];

  writeAuthData(dataDir, { masterTokenHash: masterHash, apiKeys });

  logger.debug(fixedToken ? "Auth token set from config" : "Auth token generated");
  return { token };
}

export function verifyCredential(credential: string, dataDir: string): CredentialResult {
  const data = readAuthData(dataDir);
  if (!data) {
    logger.warn("Auth verification failed: server.json not found or corrupt");
    return { valid: false, type: null };
  }

  // API key check (yk_ prefix)
  if (credential.startsWith("yk_")) {
    const candidateHash = hashCredential(credential);
    for (const key of data.apiKeys) {
      if (constantTimeEqual(candidateHash, key.hash)) {
        if (key.revokedAt !== null) {
          logger.warn("Auth verification failed: API key revoked", { keyName: key.name });
          return { valid: false, type: null };
        }
        return { valid: true, type: "apiKey", keyId: key.id, keyName: key.name };
      }
    }
    logger.warn("Auth verification failed: API key not found");
    return { valid: false, type: null };
  }

  // Master token check
  const candidateHash = hashCredential(credential);
  if (constantTimeEqual(candidateHash, data.masterTokenHash)) {
    return { valid: true, type: "master" };
  }

  logger.warn("Auth verification failed: token mismatch");
  return { valid: false, type: null };
}

// --- API Key management ---

export function addApiKey(dataDir: string, entry: Omit<ApiKeyEntry, "revokedAt">): void {
  const data = readAuthData(dataDir);
  if (!data) throw new Error("server.json not found");

  data.apiKeys.push({ ...entry, revokedAt: null });
  writeAuthData(dataDir, data);
  logger.info("API key added", { keyName: entry.name, keyId: entry.id });
}

export function listApiKeys(dataDir: string): ApiKeyEntry[] {
  const data = readAuthData(dataDir);
  return data?.apiKeys ?? [];
}

export function revokeApiKey(dataDir: string, id: string): boolean {
  const data = readAuthData(dataDir);
  if (!data) return false;

  const key = data.apiKeys.find((k) => k.id === id);
  if (!key || key.revokedAt !== null) return false;

  key.revokedAt = Date.now();
  writeAuthData(dataDir, data);
  logger.info("API key revoked", { keyName: key.name, keyId: key.id });
  return true;
}
