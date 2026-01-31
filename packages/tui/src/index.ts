import React from "react";
import { render } from "ink";
import { z } from "zod";
import { parseCli } from "@molf-ai/protocol";
import { App } from "./app.js";

const tuiArgsSchema = z.object({
  "server-url": z.string().default("ws://127.0.0.1:7600"),
  token: z.string().min(1, "Auth token is required"),
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
        description: "Auth token",
        required: true,
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

render(
  React.createElement(App, {
    serverUrl: args["server-url"],
    token: args.token,
    workerId: args["worker-id"],
    sessionId: args["session-id"],
  }),
);
