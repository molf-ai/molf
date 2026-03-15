import { readFileSync } from "fs";
import { startServer } from "../../server/src/server.js";
import type { ServerInstance } from "../../server/src/server.js";
import type { PluginConfigEntry } from "../../server/src/plugin-loader.js";
import { generateSelfSignedCert, computeFingerprint } from "../../server/src/tls.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

export interface TestServer {
  url: string;
  token: string;
  port: number;
  tmp: TmpDir;
  instance: ServerInstance;
  /** Present when TLS is enabled */
  tlsFingerprint?: string;
  /** PEM cert content for client CA trust */
  certPem?: string;
  cleanup(): void;
}

export function createTestProviderConfig(dataDir: string) {
  return {
    model: "gemini/test" as const,
    dataDir,
    providers: {
      gemini: {
        npm: "@ai-sdk/google",
        models: {
          test: {
            name: "Test Model",
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
    },
  };
}

export async function startTestServer(opts?: {
  approval?: boolean;
  plugins?: PluginConfigEntry[];
  tls?: boolean;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  uploadTimeoutMs?: number;
}): Promise<TestServer> {
  const tmp = createTmpDir("molf-server-test-");
  const useTls = opts?.tls ?? false;

  let tlsCertPath: string | undefined;
  let tlsKeyPath: string | undefined;
  let certPem: string | undefined;
  let tlsFingerprint: string | undefined;

  if (useTls) {
    const { certPath, keyPath } = generateSelfSignedCert(tmp.path);
    tlsCertPath = certPath;
    tlsKeyPath = keyPath;
    certPem = readFileSync(certPath, "utf-8");
    tlsFingerprint = computeFingerprint(certPem);
  }

  const instance = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: tmp.path,
    model: "gemini/test",
    providerConfig: createTestProviderConfig(tmp.path),
    tls: useTls,
    tlsCertPath,
    tlsKeyPath,
    approval: opts?.approval ?? false,
    plugins: opts?.plugins,
    pingIntervalMs: opts?.pingIntervalMs,
    pongTimeoutMs: opts?.pongTimeoutMs,
    uploadTimeoutMs: opts?.uploadTimeoutMs,
  });

  const port = instance.port;
  const proto = useTls ? "wss" : "ws";

  return {
    url: `${proto}://127.0.0.1:${port}`,
    token: instance.token,
    port,
    tmp,
    instance,
    tlsFingerprint,
    certPem,
    cleanup() {
      instance.close();
      tmp.cleanup();
    },
  };
}
