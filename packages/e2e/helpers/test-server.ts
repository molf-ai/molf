import { startServer } from "../../server/src/server.js";
import type { ServerInstance } from "../../server/src/server.js";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

export interface TestServer {
  url: string;
  token: string;
  port: number;
  tmp: TmpDir;
  instance: ServerInstance;
  cleanup(): void;
}

export function startTestServer(): TestServer {
  const tmp = createTmpDir("molf-server-test-");
  const instance = startServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: tmp.path,
    llm: { provider: "gemini", model: "test" },
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
