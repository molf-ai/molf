import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

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

export function initAuth(dataDir: string): { token: string } {
  const serverJsonPath = resolve(dataDir, "server.json");

  // Check for env var override
  const envToken = process.env.MOLF_TOKEN;
  if (envToken) {
    const hash = hashToken(envToken);
    // Save hash for verification
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(serverJsonPath, JSON.stringify({ tokenHash: hash }, null, 2));
    return { token: envToken };
  }

  // Check if token already exists
  if (existsSync(serverJsonPath)) {
    // Token already generated — we can't recover it, generate a new one
    // (This happens on server restart without MOLF_TOKEN env var)
  }

  // Generate new token
  const token = generateToken();
  const hash = hashToken(token);

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(serverJsonPath, JSON.stringify({ tokenHash: hash }, null, 2));

  return { token };
}

export function verifyToken(token: string, dataDir: string): boolean {
  const serverJsonPath = resolve(dataDir, "server.json");

  if (!existsSync(serverJsonPath)) {
    return false;
  }

  try {
    const data = JSON.parse(readFileSync(serverJsonPath, "utf-8")) as AuthState;
    return hashToken(token) === data.tokenHash;
  } catch {
    return false;
  }
}
