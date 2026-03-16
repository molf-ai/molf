import { os } from "./context.js";
import { sessionHandlers } from "./routers/session.js";
import { agentHandlers } from "./routers/agent.js";
import { toolHandlers } from "./routers/tool.js";
import { workerHandlers } from "./routers/worker.js";
import { fsHandlers } from "./routers/fs.js";
import { providerHandlers } from "./routers/provider.js";
import { workspaceHandlers } from "./routers/workspace.js";
import { authHandlers } from "./routers/auth.js";
import { configHandlers } from "./routers/config.js";
import { serverHandlers } from "./routers/server-events.js";
import type { PluginLoader } from "./plugin-loader.js";
import { buildPluginHandlers } from "./plugin-routes.js";

export function createAppRouter(pluginLoader: PluginLoader) {
  return os.router({
    session: sessionHandlers,
    agent: agentHandlers,
    tool: toolHandlers,
    worker: workerHandlers,
    fs: fsHandlers,
    provider: providerHandlers,
    workspace: workspaceHandlers,
    auth: authHandlers,
    config: configHandlers,
    server: serverHandlers,
    plugin: buildPluginHandlers(pluginLoader),
  });
}

/** Default router instance with no-op plugin loader (used by tests). */
export const appRouter = createAppRouter({
  getPluginList: () => [],
  pluginRoutes: [],
  workerPluginSpecifiers: [],
} as any);

export type AppRouter = typeof appRouter;
