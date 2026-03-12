import React from "react";
import { render } from "ink";
import { resolve } from "path";
import { createInterface } from "readline";
import { z } from "zod";
import { parseCli, loadCredential, loadTlsCertPem, saveTlsCert, resolveTlsTrust, tlsTrustToWsOpts, probeServerCert, checkPinnedCertExpiry } from "@molf-ai/protocol";
import { App } from "./app.js";
import { runPairFlow } from "./pair.js";

const tuiArgsSchema = z.object({
  "server-url": z.string().default("wss://127.0.0.1:7600"),
  token: z.string().optional(),
  "worker-id": z.string().optional(),
  "session-id": z.string().optional(),
  "tls-ca": z.string().transform((p) => resolve(p)).optional(),
});

const args = parseCli(
  {
    name: "molf-tui",
    version: "0.1.0",
    description: "Molf TUI client",
    options: {
      "server-url": {
        type: "string",
        short: "s",
        description: "WebSocket server URL",
        default: "wss://127.0.0.1:7600",
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
      "tls-ca": {
        type: "string",
        description: "Path to trusted CA certificate PEM file",
        env: "MOLF_TLS_CA",
      },
    },
    schema: tuiArgsSchema,
  },
);

// Resolve token and TLS trust
const serverUrl = args["server-url"];
const savedCred = loadCredential(serverUrl);
const savedCertPem = loadTlsCertPem(serverUrl);

const tlsTrust = resolveTlsTrust({
  serverUrl,
  tlsCaPath: args["tls-ca"],
  savedCertPem: savedCertPem ?? undefined,
});

let token = args.token ?? savedCred?.apiKey;

if (!token) {
  token = await runPairFlow(serverUrl, tlsTrust);
}

// Re-resolve TLS trust: pairing may have saved a cert, switching from tofu → pinned
let resolvedTlsTrust = resolveTlsTrust({
  serverUrl,
  tlsCaPath: args["tls-ca"],
  savedCertPem: loadTlsCertPem(serverUrl) ?? undefined,
});
if (token && resolvedTlsTrust?.mode === "tofu") {
  const result = await probeServerCert(serverUrl);
  console.log(`Server TLS fingerprint: ${result.fingerprint}`);
  const answer = await promptLine("Trust this server? [Y/n] ");
  if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
    console.error("Connection rejected. Exiting.");
    process.exit(1);
  }
  // Persist the cert PEM so future runs use pinned mode
  saveTlsCert(serverUrl, result.certPem);
  resolvedTlsTrust = { mode: "pinned", certPem: result.certPem, fingerprint: result.fingerprint };
}

const finalTlsOpts = resolvedTlsTrust ? tlsTrustToWsOpts(resolvedTlsTrust) : undefined;

if (resolvedTlsTrust?.mode === "pinned") {
  const { expired, daysRemaining } = checkPinnedCertExpiry(resolvedTlsTrust.certPem);
  if (expired) {
    console.log(
      "\x1b[33mWarning: pinned server certificate has expired. " +
      "Re-pair with the server to trust the new certificate.\x1b[0m",
    );
  } else if (daysRemaining <= 30) {
    console.log(
      `\x1b[33mWarning: pinned server certificate expires in ${daysRemaining} day(s).\x1b[0m`,
    );
  }
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
    tlsOpts: finalTlsOpts,
  }),
);

function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
