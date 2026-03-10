import { createTRPCClient, createWSClient, wsLink } from "./trpc-client.js";
import type { AppRouter } from "@molf-ai/server";
import { saveCredential, getCredentialsPath } from "@molf-ai/protocol";
import { createInterface } from "readline";

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Pair with a server using a pairing code.
 * Verifies server is reachable first, then prompts for code, redeems, and saves credentials.
 */
export async function runPairFlow(serverUrl: string): Promise<string> {
  console.log("No auth token found. Starting pairing flow.");
  console.log("Get a pairing code from the TUI: /pair <device-name>\n");

  const url = new URL(serverUrl);
  url.searchParams.set("clientId", crypto.randomUUID());
  url.searchParams.set("name", "tui-pair");

  // Connect with timeout — fail fast if server is unreachable
  const { wsClient, trpc } = await connectWithTimeout(url.toString());

  try {
    const code = await prompt("Enter pairing code: ");
    if (!code || !/^\d{6}$/.test(code.trim())) {
      throw new Error("Invalid pairing code. Must be 6 digits.");
    }

    const result = await trpc.auth.redeemPairingCode.mutate({ code: code.trim() });

    saveCredential(serverUrl, { apiKey: result.apiKey, name: result.name });
    console.log(`Paired as "${result.name}". Credentials saved to ${getCredentialsPath()}\n`);

    return result.apiKey;
  } finally {
    wsClient.close();
  }
}

function connectWithTimeout(url: string): Promise<{
  wsClient: ReturnType<typeof createWSClient>;
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wsClient.close();
      reject(new Error(`Could not connect to server at ${url} (timed out after ${CONNECT_TIMEOUT_MS / 1000}s)`));
    }, CONNECT_TIMEOUT_MS);

    const wsClient = createWSClient({
      url,
      retryDelayMs: () => CONNECT_TIMEOUT_MS + 1000, // Don't retry within our timeout window
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
