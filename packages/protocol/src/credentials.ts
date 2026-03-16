import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

export interface ServerEntry {
  apiKey?: string;
  name?: string;
}

export interface ServersFile {
  servers: Record<string, ServerEntry>;
}

/** @deprecated Use `ServerEntry` instead. */
export type ServerCredential = ServerEntry;
/** @deprecated Use `ServersFile` instead. */
export type CredentialsFile = ServersFile;

export function getClientDataDir(): string {
  return process.env.MOLF_CLIENT_DIR ?? resolve(homedir(), ".molf");
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

function readServers(): ServersFile {
  const path = resolve(getClientDataDir(), "servers.json");
  if (!existsSync(path)) {
    return { servers: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { servers: {} };
  }
}

function writeServers(data: ServersFile): void {
  const dir = getClientDataDir();
  const path = resolve(dir, "servers.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
  chmodSync(path, 0o600);
}

/** Load a saved server entry for a server URL. Returns null if not found. */
export function loadServer(serverUrl: string): ServerEntry | null {
  const key = normalizeUrl(serverUrl);
  const data = readServers();
  return data.servers[key] ?? null;
}

/** Save a server entry for a server URL. Overwrites any existing entry. */
export function saveServer(serverUrl: string, entry: ServerEntry): void {
  const key = normalizeUrl(serverUrl);
  const data = readServers();
  data.servers[key] = entry;
  writeServers(data);
}

/** Remove a saved server entry for a server URL. Also removes any stored TLS cert. */
export function removeServer(serverUrl: string): boolean {
  const key = normalizeUrl(serverUrl);
  const data = readServers();
  if (!(key in data.servers)) return false;
  delete data.servers[key];
  writeServers(data);
  removeTlsCert(serverUrl);
  return true;
}

/** Get the servers file path (for display purposes). */
export function getServersPath(): string {
  return resolve(getClientDataDir(), "servers.json");
}

// Backward-compatible aliases
/** @deprecated Use `loadServer` instead. */
export const loadCredential = loadServer;
/** @deprecated Use `saveServer` instead. */
export const saveCredential = saveServer;
/** @deprecated Use `removeServer` instead. */
export const removeCredential = removeServer;
/** @deprecated Use `getServersPath` instead. */
export const getCredentialsPath = getServersPath;

/** Convert a server URL to a filename slug for cert storage. */
function urlToSlug(serverUrl: string): string {
  return normalizeUrl(serverUrl).replace("://", "_").replace(/:/g, "_") + ".pem";
}

/** Save a TLS certificate PEM file for a server URL. */
export function saveTlsCert(serverUrl: string, certPem: string): void {
  const dir = resolve(getClientDataDir(), "known_certs");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, urlToSlug(serverUrl));
  writeFileSync(path, certPem);
  chmodSync(path, 0o600);
}

/** Load a TLS certificate PEM for a server URL. Returns null if not found. */
export function loadTlsCertPem(serverUrl: string): string | null {
  const path = resolve(getClientDataDir(), "known_certs", urlToSlug(serverUrl));
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Remove a stored TLS certificate for a server URL. */
export function removeTlsCert(serverUrl: string): void {
  const path = resolve(getClientDataDir(), "known_certs", urlToSlug(serverUrl));
  try {
    unlinkSync(path);
  } catch {
    // File didn't exist
  }
}
