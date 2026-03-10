import { configure, getConsoleSink, jsonLinesFormatter } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { getRotatingFileSink } from "@logtape/file";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { parseServerArgs, resolveServerConfig } from "./config.js";
import { startServer } from "./server.js";

const args = parseServerArgs();
const config = resolveServerConfig(args);

// Configure LogTape before starting server
const logLevel = (process.env.MOLF_LOG_LEVEL ?? "info") as "debug" | "info" | "warning" | "error";
const disableFileLog = process.env.MOLF_LOG_FILE === "none";

const sinks: Record<string, ReturnType<typeof getConsoleSink>> = {
  console: getConsoleSink({ formatter: getPrettyFormatter({ timestamp: "rfc3339", wordWrap: false, categoryWidth: 18, properties: true }) }),
};
const sinkNames: string[] = ["console"];

if (!disableFileLog) {
  const logDir = resolve(config.dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  (sinks as Record<string, unknown>).file = getRotatingFileSink(resolve(logDir, "server.log"), {
    formatter: jsonLinesFormatter,
    maxSize: 5 * 1024 * 1024,
    maxFiles: 5,
  });
  sinkNames.push("file");
}

await configure({
  sinks,
  loggers: [
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: sinkNames },
    { category: ["molf"], lowestLevel: logLevel, sinks: sinkNames },
  ],
});

const server = await startServer(config);

console.log(`\nAuth token: ${server.token}\n`);
console.log("Pass this token to the TUI client to connect.");
console.log("Use /pair in the TUI to create pairing codes for other devices.");
console.log("Set MOLF_TOKEN env var for a fixed token across restarts.");
console.log("Press Ctrl+C to stop.\n");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
