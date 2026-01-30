import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "@molf-ai/protocol";

const DEFAULT_CONFIG: ServerConfig = {
  host: "127.0.0.1",
  port: 7600,
  dataDir: "./data",
};

export function loadConfig(configPath?: string): ServerConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), "molf.yaml");

  if (!existsSync(resolvedPath)) {
    // No config file — return defaults with dataDir resolved from cwd
    return {
      ...DEFAULT_CONFIG,
      dataDir: resolve(process.cwd(), DEFAULT_CONFIG.dataDir),
    };
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = parseYaml(raw) ?? {};
  const configDir = dirname(resolve(resolvedPath));

  const host = typeof parsed.host === "string" ? parsed.host : DEFAULT_CONFIG.host;
  const port = typeof parsed.port === "number" ? parsed.port : DEFAULT_CONFIG.port;
  const rawDataDir = typeof parsed.dataDir === "string" ? parsed.dataDir : DEFAULT_CONFIG.dataDir;

  // Resolve relative dataDir paths from config file location
  const dataDir = resolve(configDir, rawDataDir);

  return { host, port, dataDir };
}

export function parseCliArgs(args: string[]): { configPath?: string } {
  const configIdx = args.indexOf("--config");
  if (configIdx !== -1 && configIdx + 1 < args.length) {
    return { configPath: resolve(args[configIdx + 1]) };
  }
  return {};
}
