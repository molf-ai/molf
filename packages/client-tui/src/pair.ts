import { createORPCClient, RPCLink } from "./rpc-client.js";
import { contract } from "@molf-ai/protocol";
import type { RpcClient } from "@molf-ai/protocol";
import {
  saveServer,
  saveTlsCert,
  getServersPath,
  tlsTrustToWsOpts,
  probeServerCert,
  createUnauthWebSocket,
} from "@molf-ai/protocol";
import type { TlsTrust } from "@molf-ai/protocol";
import { createInterface } from "readline";

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Pair with a server using a pairing code.
 */
export async function runPairFlow(
  serverUrl: string,
  tlsTrust?: TlsTrust | null,
): Promise<string> {
  let pinnedTlsOpts = tlsTrust ? tlsTrustToWsOpts(tlsTrust) : undefined;
  let trustedCertPem: string | undefined;

  if (tlsTrust?.mode === "tofu") {
    const result = await probeServerCert(serverUrl);
    console.log(`TLS fingerprint: ${result.fingerprint}`);
    const answer = await prompt("Trust this server? [Y/n] ");
    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
      console.error("Connection rejected. Exiting.");
      process.exit(1);
    }
    trustedCertPem = result.certPem;
    pinnedTlsOpts = {
      ca: result.certPem,
      rejectUnauthorized: true,
      checkServerIdentity: (() => undefined) as unknown as () => boolean,
    };
  } else if (tlsTrust?.mode === "pinned") {
    trustedCertPem = tlsTrust.certPem;
  }

  console.log("No auth token found. Starting pairing flow.");
  console.log("Get a pairing code from the TUI: /pair <device-name>\n");

  const { ws, client } = await connectWithTimeout(serverUrl, pinnedTlsOpts);

  try {
    const code = await prompt("Enter pairing code: ");
    if (!code || !/^\d{6}$/.test(code.trim())) {
      throw new Error("Invalid pairing code. Must be 6 digits.");
    }

    const result = await client.auth.redeemPairingCode({ code: code.trim() });

    saveServer(serverUrl, {
      apiKey: result.apiKey,
      name: result.name,
    });
    if (trustedCertPem) {
      saveTlsCert(serverUrl, trustedCertPem);
    }
    console.log(`Paired as "${result.name}". Credentials saved to ${getServersPath()}\n`);

    return result.apiKey;
  } finally {
    ws.close();
  }
}

function connectWithTimeout(
  serverUrl: string,
  tlsOpts?: Pick<import("ws").ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">,
): Promise<{ ws: WebSocket; client: RpcClient }> {
  return new Promise((resolve, reject) => {
    const WS = createUnauthWebSocket(tlsOpts);

    const url = new URL(serverUrl);
    url.searchParams.set("clientId", crypto.randomUUID());
    url.searchParams.set("name", "tui-pair");
    const urlStr = url.toString();

    const ws = new WS(urlStr);

    const timeout = setTimeout(() => {
      ws.close();
      const hint = urlStr.startsWith("ws://")
        ? `\nIf the server has TLS enabled, use wss:// instead:\n  --server-url ${urlStr.replace("ws://", "wss://")}`
        : "";
      reject(new Error(`Could not connect to server at ${urlStr} (timed out after ${CONNECT_TIMEOUT_MS / 1000}s)${hint}`));
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      const link = new RPCLink({ websocket: ws });
      const client = createORPCClient(link) as RpcClient;
      resolve({ ws, client });
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Could not connect to server at ${urlStr}`));
    });
  });
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
