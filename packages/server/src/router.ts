import { router } from "./context.js";
import { sessionRouter } from "./routers/session.js";
import { agentRouter } from "./routers/agent.js";
import { toolRouter } from "./routers/tool.js";
import { workerRouter } from "./routers/worker.js";
import { fsRouter } from "./routers/fs.js";
import { providerRouter } from "./routers/provider.js";
import { workspaceRouter } from "./routers/workspace.js";
import type { PluginLoader } from "./plugin-loader.js";
import { buildPluginRouter } from "./plugin-routes.js";

export function createAppRouter(pluginLoader: PluginLoader) {
  return router({
    session: sessionRouter,
    agent: agentRouter,
    tool: toolRouter,
    worker: workerRouter,
    fs: fsRouter,
    provider: providerRouter,
    workspace: workspaceRouter,
    plugin: buildPluginRouter(pluginLoader),
  });
}

/** Default router instance with no-op plugin loader (used by tests and type exports). */
export const appRouter = createAppRouter({
  getPluginList: () => [],
  pluginRoutes: [],
} as any);
export type AppRouter = typeof appRouter;
