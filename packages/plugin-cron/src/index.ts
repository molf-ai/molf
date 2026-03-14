import { z } from "zod";
import {
  definePlugin,
  defineRoutes,
  cronAddInput,
  cronListInput,
  cronRemoveInput,
  cronUpdateInput,
  cronJobSchema,
} from "@molf-ai/protocol";
import type { ServerPluginApi, RouteMap } from "@molf-ai/protocol";
import { CronStore } from "./store.js";
import { CronService } from "./service.js";
import { buildCronTool } from "./tool.js";

// Re-export for direct usage (tests, etc.)
export { CronService } from "./service.js";
export { CronStore } from "./store.js";
export { buildCronTool } from "./tool.js";
export type { PromptFn } from "./types.js";
export { AgentBusyError } from "./types.js";

interface CronRouteCtx { service: CronService }

const cronRoutes = defineRoutes<CronRouteCtx, RouteMap<CronRouteCtx>>({
  list: {
    type: "query",
    input: cronListInput,
    output: z.array(cronJobSchema),
    handler: ({ input, context }) => context.service.list(input.workerId, input.workspaceId),
  },
  add: {
    type: "mutation",
    input: cronAddInput,
    output: cronJobSchema,
    handler: async ({ input, context }) => context.service.add(input),
  },
  remove: {
    type: "mutation",
    input: cronRemoveInput,
    output: z.object({ success: z.boolean() }),
    handler: async ({ input, context }) => {
      const removed = await context.service.remove(input.workerId, input.workspaceId, input.jobId);
      return { success: removed };
    },
  },
  update: {
    type: "mutation",
    input: cronUpdateInput,
    output: z.object({ success: z.boolean(), job: cronJobSchema.nullable() }),
    handler: async ({ input, context }) => {
      const { workerId, workspaceId, jobId, ...patch } = input;
      const job = await context.service.update(workerId, workspaceId, jobId, patch);
      return { success: !!job, job: job ?? null };
    },
  },
});

export default definePlugin({
  name: "cron",

  server(api: ServerPluginApi) {
    const store = new CronStore(
      (wId, wsId) => api.dataPath(wId, wsId),
      api.dataPath(),
    );
    const service = new CronService(api, store);

    // Wire the prompt function via agentRunner
    service.setPromptFn((sessionId, text, options) =>
      api.agentRunner.prompt(sessionId, text, undefined, undefined, options),
    );

    service.init();

    // Register cron routes via plugin system
    api.addRoutes(cronRoutes as RouteMap, { service });

    // Register cron tool as a per-session tool
    api.addSessionTool((ctx) => {
      return buildCronTool(service, ctx.workspaceId, ctx.workerId);
    });

    api.addService({
      start: async () => {},
      stop: async () => service.shutdown(),
    });
  },
});
