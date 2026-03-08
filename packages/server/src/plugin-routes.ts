import { getLogger } from "@logtape/logtape";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, authedProcedure } from "./context.js";
import type { PluginLoader } from "./plugin-loader.js";

const logger = getLogger(["molf", "server", "plugin-routes"]);

/**
 * Build the plugin tRPC router.
 * Provides generic dispatch to plugin-registered routes.
 */
export function buildPluginRouter(pluginLoader: PluginLoader) {
  return router({
    list: authedProcedure.query(() => {
      return pluginLoader.getPluginList();
    }),

    query: authedProcedure
      .input(
        z.object({
          plugin: z.string(),
          method: z.string(),
          input: z.unknown(),
        }),
      )
      .query(async ({ input }) => {
        return dispatchRoute(pluginLoader, input.plugin, input.method, "query", input.input);
      }),

    mutate: authedProcedure
      .input(
        z.object({
          plugin: z.string(),
          method: z.string(),
          input: z.unknown(),
        }),
      )
      .mutation(async ({ input }) => {
        return dispatchRoute(pluginLoader, input.plugin, input.method, "mutation", input.input);
      }),
  });
}

async function dispatchRoute(
  pluginLoader: PluginLoader,
  pluginName: string,
  method: string,
  expectedType: "query" | "mutation",
  rawInput: unknown,
): Promise<unknown> {
  // Find the route entry for this plugin + method
  for (const entry of pluginLoader.pluginRoutes) {
    if (entry.pluginName !== pluginName) continue;
    const route = entry.routes[method];
    if (!route) continue;

    if (route.type !== expectedType) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Route "${pluginName}.${method}" is a ${route.type}, not a ${expectedType}`,
      });
    }

    // Validate input
    const parsed = route.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid input for "${pluginName}.${method}": ${parsed.error}`,
      });
    }

    // Call handler (isolate plugin errors)
    let result: unknown;
    try {
      result = await route.handler(parsed.data, entry.context);
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      logger.error("Plugin route handler threw", { plugin: pluginName, method, error: err });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Plugin "${pluginName}.${method}" handler failed`,
      });
    }

    // Validate output
    const outputParsed = route.output.safeParse(result);
    if (!outputParsed.success) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Plugin "${pluginName}.${method}" returned invalid output`,
      });
    }

    return outputParsed.data;
  }

  throw new TRPCError({
    code: "NOT_FOUND",
    message: `No route "${method}" found for plugin "${pluginName}"`,
  });
}
