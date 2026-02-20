import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled?: boolean;
}

export interface HttpServerConfig {
  type: "http";
  url: string;
  headers: Record<string, string>;
  enabled?: boolean;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const stdioConfigSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().optional(),
});

const httpConfigSchema = z.object({
  type: z.literal("http"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().optional(),
});

const mcpServerConfigSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !("type" in v) ? { type: "stdio", ...v } : v),
  z.discriminatedUnion("type", [stdioConfigSchema, httpConfigSchema]),
);

const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
});

export function interpolateEnv(value: string, lookup: Record<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => {
    const result = lookup[name];
    if (result === undefined) {
      console.warn(`MCP config: environment variable ${name} is not set, replacing with empty string`);
      return "";
    }
    return result;
  });
}

export function loadMcpConfig(workdir: string): McpConfig | null {
  const configPath = join(workdir, ".mcp.json");
  if (!existsSync(configPath)) {
    return null;
  }

  const raw = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`MCP config at ${configPath} is not valid JSON: ${e}`);
  }

  const result = mcpConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`MCP config at ${configPath} is invalid: ${result.error.message}`);
  }

  // Interpolate env vars in all string fields
  const envLookup = { ...process.env, WORKDIR: workdir } as Record<string, string>;
  const config = result.data;
  const interpolated: McpConfig = { mcpServers: {} };

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (serverConfig.type === "stdio") {
      interpolated.mcpServers[serverName] = {
        type: "stdio",
        command: interpolateEnv(serverConfig.command, envLookup),
        args: serverConfig.args.map(a => interpolateEnv(a, envLookup)),
        env: Object.fromEntries(
          Object.entries(serverConfig.env).map(([k, v]) => [k, interpolateEnv(v, envLookup)])
        ),
        enabled: serverConfig.enabled,
      };
    } else {
      interpolated.mcpServers[serverName] = {
        type: "http",
        url: interpolateEnv(serverConfig.url, envLookup),
        headers: Object.fromEntries(
          Object.entries(serverConfig.headers).map(([k, v]) => [k, interpolateEnv(v, envLookup)])
        ),
        enabled: serverConfig.enabled,
      };
    }
  }

  return interpolated;
}
