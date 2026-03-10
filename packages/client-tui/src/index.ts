import React from "react";
import { render } from "ink";
import { z } from "zod";
import { parseCli, loadCredential } from "@molf-ai/protocol";
import { App } from "./app.js";
import { runPairFlow } from "./pair.js";

const tuiArgsSchema = z.object({
  "server-url": z.string().default("ws://127.0.0.1:7600"),
  token: z.string().optional(),
  "worker-id": z.string().optional(),
  "session-id": z.string().optional(),
});

const args = parseCli(
  {
    name: "molf-tui",
    version: "0.1.0",
    description: "Molf TUI client",
    usage: "bun run dev:tui -- [options]",
    options: {
      "server-url": {
        type: "string",
        short: "s",
        description: "WebSocket server URL",
        default: "ws://127.0.0.1:7600",
        env: "MOLF_SERVER_URL",
      },
      token: {
        type: "string",
        short: "t",
        description: "Auth token or API key",
        env: "MOLF_TOKEN",
      },
      "worker-id": {
        type: "string",
        short: "w",
        description: "Target worker ID",
        env: "MOLF_WORKER_ID",
      },
      "session-id": {
        type: "string",
        description: "Resume an existing session",
        env: "MOLF_SESSION_ID",
      },
    },
    schema: tuiArgsSchema,
  },
);

// Resolve token: CLI/env → credentials.json → auto-pair
const serverUrl = args["server-url"];
let token = args.token ?? loadCredential(serverUrl)?.apiKey;

if (!token) {
  token = await runPairFlow(serverUrl);
}

// Warn if connecting with master token to a remote server
if (!token.startsWith("yk_")) {
  const hostname = new URL(serverUrl.replace(/^ws/, "http")).hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    console.log(
      "\x1b[33mWarning: connecting with master token to a remote server.\n" +
      "Consider using a pairing code instead: run /pair in a local TUI session.\x1b[0m\n",
    );
  }
}

render(
  React.createElement(App, {
    serverUrl,
    token,
    workerId: args["worker-id"],
    sessionId: args["session-id"],
  }),
);
