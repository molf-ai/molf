import { loadConfig, parseCliArgs } from "./config.js";
import { startServer } from "./server.js";

const args = parseCliArgs(process.argv.slice(2));
const config = loadConfig(args.configPath);
const server = startServer(config);

console.log(`\nAuth token: ${server.token}\n`);
console.log("Set MOLF_TOKEN environment variable to use a fixed token.");
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
