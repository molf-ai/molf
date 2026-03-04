import { router } from "./context.js";
import { sessionRouter } from "./routers/session.js";
import { agentRouter } from "./routers/agent.js";
import { toolRouter } from "./routers/tool.js";
import { workerRouter } from "./routers/worker.js";
import { fsRouter } from "./routers/fs.js";
import { providerRouter } from "./routers/provider.js";
import { workspaceRouter } from "./routers/workspace.js";
import { cronRouter } from "./routers/cron.js";

export const appRouter = router({
  session: sessionRouter,
  agent: agentRouter,
  tool: toolRouter,
  worker: workerRouter,
  fs: fsRouter,
  provider: providerRouter,
  workspace: workspaceRouter,
  cron: cronRouter,
});

export type AppRouter = typeof appRouter;
