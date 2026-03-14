import { getLogger } from "@logtape/logtape";
import { ORPCError } from "@orpc/server";
import { os, authMiddleware } from "./context.js";
import type { PluginLoader } from "./plugin-loader.js";

const logger = getLogger(["molf", "server", "plugin-routes"]);

/**
 * Build the plugin oRPC handlers.
 * Provides generic dispatch to plugin-registered routes.
 */
export function buildPluginHandlers(pluginLoader: PluginLoader) {
  return {
    list: os.plugin.list
      .use(authMiddleware)
      .handler(() => {
        return pluginLoader.getPluginList();
      }),

    query: os.plugin.query
      .use(authMiddleware)
      .handler(async ({ input }) => {
        return dispatchRoute(pluginLoader, input.plugin, input.method, "query", input.input);
      }),

    mutate: os.plugin.mutate
      .use(authMiddleware)
      .handler(async ({ input }) => {
        return dispatchRoute(pluginLoader, input.plugin, input.method, "mutation", input.input);
      }),
  };
}

async function dispatchRoute(
  pluginLoader: PluginLoader,
  pluginName: string,
  method: string,
  expectedType: "query" | "mutation",
  rawInput: unknown,
): Promise<{ result: unknown }> {
  // Find the route entry for this plugin + method
  for (const entry of pluginLoader.pluginRoutes) {
    if (entry.pluginName !== pluginName) continue;
    const route = entry.routes[method];
    if (!route) continue;

    if (route.type !== expectedType) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Route "${pluginName}.${method}" is a ${route.type}, not a ${expectedType}`,
      });
    }

    // Validate input
    const parsed = route.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Invalid input for "${pluginName}.${method}": ${parsed.error}`,
      });
    }

    // Call handler (isolate plugin errors)
    let result: unknown;
    try {
      result = await route.handler({ input: parsed.data, context: entry.context });
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      logger.error("Plugin route handler threw", { plugin: pluginName, method, error: err });
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: `Plugin "${pluginName}.${method}" handler failed`,
      });
    }

    // Validate output
    const outputParsed = route.output.safeParse(result);
    if (!outputParsed.success) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: `Plugin "${pluginName}.${method}" returned invalid output`,
      });
    }

    return { result: outputParsed.data };
  }

  throw new ORPCError("NOT_FOUND", {
    message: `No route "${method}" found for plugin "${pluginName}"`,
  });
}
