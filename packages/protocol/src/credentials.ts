import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

export interface ServerCredential {
  apiKey?: string;
  name?: string;
}

export interface CredentialsFile {
  servers: Record<string, ServerCredential>;
}

function getCredentialsDir(): string {
  return process.env.MOLF_CREDENTIALS_DIR ?? resolve(homedir(), ".molf");
}

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
  const path = resolve(getCredentialsDir(), "credentials.json");
  if (!existsSync(path)) {
    return { servers: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { servers: {} };
  }
}

function writeCredentials(data: CredentialsFile): void {
  const dir = getCredentialsDir();
  const path = resolve(dir, "credentials.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
  chmodSync(path, 0o600);
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

/** Remove a saved credential for a server URL. Also removes any stored TLS cert. */
export function removeCredential(serverUrl: string): boolean {
  const key = normalizeUrl(serverUrl);
  const data = readCredentials();
  if (!(key in data.servers)) return false;
  delete data.servers[key];
  writeCredentials(data);
  removeTlsCert(serverUrl);
  return true;
}

/** Convert a server URL to a filename slug for cert storage. */
function urlToSlug(serverUrl: string): string {
  return normalizeUrl(serverUrl).replace("://", "_").replace(/:/g, "_") + ".pem";
}

/** Save a TLS certificate PEM file for a server URL. */
export function saveTlsCert(serverUrl: string, certPem: string): void {
  const dir = resolve(getCredentialsDir(), "known_certs");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, urlToSlug(serverUrl));
  writeFileSync(path, certPem);
  chmodSync(path, 0o600);
}

/** Load a TLS certificate PEM for a server URL. Returns null if not found. */
export function loadTlsCertPem(serverUrl: string): string | null {
  const path = resolve(getCredentialsDir(), "known_certs", urlToSlug(serverUrl));
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Remove a stored TLS certificate for a server URL. */
export function removeTlsCert(serverUrl: string): void {
  const path = resolve(getCredentialsDir(), "known_certs", urlToSlug(serverUrl));
  try {
    unlinkSync(path);
  } catch {
    // File didn't exist
  }
}

/** Get the credentials file path (for display purposes). */
export function getCredentialsPath(): string {
  return resolve(getCredentialsDir(), "credentials.json");
}
