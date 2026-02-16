import { connectToServer } from "../../worker/src/connection.js";
import { ToolExecutor } from "../../worker/src/tool-executor.js";
import { getOrCreateWorkerId } from "../../worker/src/identity.js";
import type { WorkerSkillInfo } from "@molf-ai/protocol";
import { createTmpDir, type TmpDir } from "@molf-ai/test-utils";

export interface TestWorker {
  workerId: string;
  tmp: TmpDir;
  cleanup(): void;
}

export async function connectTestWorker(
  url: string,
  token: string,
  name: string,
  tools?: Record<string, { description: string; execute?: (args: any) => Promise<unknown> }>,
  skills?: WorkerSkillInfo[],
): Promise<TestWorker> {
  const tmp = createTmpDir("molf-worker-test-");
  const workerId = getOrCreateWorkerId(tmp.path);

  const executor = new ToolExecutor(tmp.path);
  if (tools) {
    for (const [toolName, def] of Object.entries(tools)) {
      executor.registerTool({
        name: toolName,
        description: def.description,
        execute: def.execute,
      });
    }
  }

  const conn = await connectToServer({
    serverUrl: url,
    token,
    workerId,
    name,
    workdir: tmp.path,
    toolExecutor: executor,
    skills: skills ?? [],
    metadata: { workdir: tmp.path },
  });

  return {
    workerId,
    tmp,
    cleanup() {
      conn.close();
      tmp.cleanup();
    },
  };
}
