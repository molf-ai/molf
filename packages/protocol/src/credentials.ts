import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

export interface ServerCredential {
  apiKey: string;
  name: string;
}

export interface CredentialsFile {
  servers: Record<string, ServerCredential>;
}

const CREDENTIALS_DIR = resolve(homedir(), ".molf");
const CREDENTIALS_PATH = resolve(CREDENTIALS_DIR, "credentials.json");

/** Normalize server URL for use as a map key (strip trailing slash, lowercase host). */
function normalizeUrl(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "wss:" ? "443" : "80")}`;
  } catch {
    return serverUrl;
  }
}

function readCredentials(): CredentialsFile {
  if (!existsSync(CREDENTIALS_PATH)) {
    return { servers: {} };
  }
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return { servers: {} };
  }
}

function writeCredentials(data: CredentialsFile): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2));
  chmodSync(CREDENTIALS_PATH, 0o600);
}

/** Load a saved credential for a server URL. Returns null if not found. */
export function loadCredential(serverUrl: string): ServerCredential | null {
  const key = normalizeUrl(serverUrl);
  const data = readCredentials();
  return data.servers[key] ?? null;
}

/** Save a credential for a server URL. Overwrites any existing entry. */
export function saveCredential(serverUrl: string, credential: ServerCredential): void {
  const key = normalizeUrl(serverUrl);
  const data = readCredentials();
  data.servers[key] = credential;
  writeCredentials(data);
}

/** Remove a saved credential for a server URL. */
export function removeCredential(serverUrl: string): boolean {
  const key = normalizeUrl(serverUrl);
  const data = readCredentials();
  if (!(key in data.servers)) return false;
  delete data.servers[key];
  writeCredentials(data);
  return true;
}

/** Get the credentials file path (for display purposes). */
export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}
