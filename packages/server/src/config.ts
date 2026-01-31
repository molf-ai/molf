import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";
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

const serverArgsSchema = z.object({
  config: z.string().transform((p) => resolve(p)).optional(),
  host: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

export function parseServerArgs(argv?: string[]) {
  return parseCli(
    {
      name: "molf-server",
      version: "0.1.0",
      description: "Molf server",
      usage: "bun run dev:server -- [options]",
      options: {
        config: {
          type: "string",
          short: "c",
          description: "Path to molf.yaml config file",
        },
        host: {
          type: "string",
          short: "H",
          description: "Host to bind to",
          default: "127.0.0.1",
        },
        port: {
          type: "string",
          short: "p",
          description: "Port to listen on",
          default: "7600",
        },
      },
      schema: serverArgsSchema,
    },
    argv,
  );
}
