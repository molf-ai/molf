import { startServer } from "../../server/src/server.js";
import type { ServerInstance } from "../../server/src/server.js";
import type { PluginConfigEntry } from "../../server/src/plugin-loader.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

export interface TestServer {
  url: string;
  token: string;
  port: number;
  tmp: TmpDir;
  instance: ServerInstance;
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

export async function startTestServer(opts?: { approval?: boolean; plugins?: PluginConfigEntry[] }): Promise<TestServer> {
  const tmp = createTmpDir("molf-server-test-");
  const instance = await startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: tmp.path,
    model: "gemini/test",
    providerConfig: createTestProviderConfig(tmp.path),
    approval: opts?.approval ?? false,
    plugins: opts?.plugins,
  });
  const addr = instance.wss.address() as { port: number };

  return {
    url: `ws://127.0.0.1:${addr.port}`,
    token: instance.token,
    port: addr.port,
    tmp,
    instance,
    cleanup() {
      instance.close();
      tmp.cleanup();
    },
  };
}
