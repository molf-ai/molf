import { createTRPCClient, createWSClient, wsLink } from "./trpc-client.js";
import type { AppRouter } from "@molf-ai/server";
import {
  saveCredential,
  saveTlsCert,
  getCredentialsPath,
  tlsTrustToWsOpts,
  probeServerCert,
  createUnauthWebSocket,
} from "@molf-ai/protocol";
import type { TlsTrust } from "@molf-ai/protocol";
import { createInterface } from "readline";

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Pair with a server using a pairing code.
 *
 * Secure flow:
 * 1. If TOFU: probe cert via raw TLS, prompt user to approve fingerprint
 * 2. Build pinned TLS opts from approved cert
 * 3. Connect fresh WebSocket with pinned opts (rejectUnauthorized: true)
 * 4. Exchange pairing code over the secure connection
 */
export async function runPairFlow(
  serverUrl: string,
  name: string,
  tlsTrust?: TlsTrust | null,
): Promise<string> {
  let pinnedTlsOpts = tlsTrust ? tlsTrustToWsOpts(tlsTrust) : undefined;
  let trustedCertPem: string | undefined;

  // TOFU: probe cert via raw TLS, then prompt before connecting
  if (tlsTrust?.mode === "tofu") {
    const result = await probeServerCert(serverUrl);
    console.log(`TLS fingerprint: ${result.fingerprint}`);
    const answer = await prompt("Trust this server? [Y/n] ");
    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
      console.error("Connection rejected. Exiting.");
      process.exit(1);
    }
    trustedCertPem = result.certPem;
    // Reconnect with pinned cert
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

  // Connect with pinned TLS for pairing
  const { wsClient, trpc } = await connectWithTimeout(serverUrl, name, pinnedTlsOpts);

  try {
    const code = await prompt("Enter pairing code: ");
    if (!code || !/^\d{6}$/.test(code.trim())) {
      throw new Error("Invalid pairing code. Must be 6 digits.");
    }

    const result = await trpc.auth.redeemPairingCode.mutate({ code: code.trim() });

    saveCredential(serverUrl, {
      apiKey: result.apiKey,
      name: result.name,
    });
    if (trustedCertPem) {
      saveTlsCert(serverUrl, trustedCertPem);
    }
    console.log(`Paired as "${result.name}". Credentials saved to ${getCredentialsPath()}`);

    return result.apiKey;
  } finally {
    wsClient.close();
  }
}

function connectWithTimeout(
  serverUrl: string,
  name: string,
  tlsOpts?: Pick<import("ws").ClientOptions, "ca" | "rejectUnauthorized" | "checkServerIdentity">,
): Promise<{
  wsClient: ReturnType<typeof createWSClient>;
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
}> {
  return new Promise((resolve, reject) => {
    const WS = createUnauthWebSocket(tlsOpts);

    const url = new URL(serverUrl);
    url.searchParams.set("clientId", crypto.randomUUID());
    url.searchParams.set("name", name);
    const urlStr = url.toString();

    const timeout = setTimeout(() => {
      wsClient.close();
      const hint = urlStr.startsWith("ws://")
        ? `\nIf the server has TLS enabled, use wss:// instead:\n  --server-url ${urlStr.replace("ws://", "wss://")}`
        : "";
      reject(new Error(`Could not connect to server at ${urlStr} (timed out after ${CONNECT_TIMEOUT_MS / 1000}s)${hint}`));
    }, CONNECT_TIMEOUT_MS);

    const wsClient = createWSClient({
      url: urlStr,
      WebSocket: WS,
      retryDelayMs: () => CONNECT_TIMEOUT_MS + 1000,
      onOpen: () => {
        clearTimeout(timeout);
        const trpc = createTRPCClient<AppRouter>({
          links: [wsLink({ client: wsClient })],
        });
        resolve({ wsClient, trpc });
      },
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
