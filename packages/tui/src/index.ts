import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const serverUrl = process.env.MOLF_SERVER_URL ?? "ws://127.0.0.1:7600";
const token = process.env.MOLF_TOKEN ?? "";
const workerId = process.env.MOLF_WORKER_ID;
const sessionId = process.env.MOLF_SESSION_ID;

if (!token) {
  console.error("Error: MOLF_TOKEN environment variable is required.");
  console.error("Run: molf server  (to start the server and get a token)");
  process.exit(1);
}

render(
  React.createElement(App, {
    serverUrl,
    token,
    workerId,
    sessionId,
  }),
);
