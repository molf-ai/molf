import { getLogger } from "@logtape/logtape";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { timingSafeEqual } from "crypto";

const logger = getLogger(["molf", "server", "auth"]);

export interface AuthState {
  tokenHash: string;
}

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function initAuth(dataDir: string, fixedToken?: string): { token: string } {
  const serverJsonPath = resolve(dataDir, "server.json");

  // Use fixed token if provided (from CLI --token or MOLF_TOKEN env var via parseCli)
  const token = fixedToken ?? generateToken();
  const hash = hashToken(token);

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(serverJsonPath, JSON.stringify({ tokenHash: hash }, null, 2));

  logger.debug(fixedToken ? "Auth token set from config" : "Auth token generated");
  return { token };
}

export function verifyToken(token: string, dataDir: string): boolean {
  const serverJsonPath = resolve(dataDir, "server.json");

  if (!existsSync(serverJsonPath)) {
    logger.warn("Auth verification failed: server.json not found");
    return false;
  }

  try {
    const data = JSON.parse(readFileSync(serverJsonPath, "utf-8")) as AuthState;
    const candidateHash = hashToken(token);
    const storedHash = data.tokenHash;
    // Use constant-time comparison to prevent timing attacks
    const valid = candidateHash.length === storedHash.length &&
      timingSafeEqual(Buffer.from(candidateHash), Buffer.from(storedHash));
    if (!valid) {
      logger.warn("Auth verification failed: token mismatch");
    }
    return valid;
  } catch {
    logger.warn("Auth verification failed: could not read server.json");
    return false;
  }
}
