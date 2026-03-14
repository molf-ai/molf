import { os, authMiddleware } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";

export const toolHandlers = {
  list: os.tool.list
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const session = loadSessionOrThrow(context.sessionMgr, input.sessionId);

      const worker = context.connectionRegistry.getWorker(session.workerId);
      if (!worker) {
        return { tools: [] };
      }

      return {
        tools: worker.tools.map((t) => ({
          name: t.name,
          description: t.description,
          workerId: session.workerId,
        })),
      };
    }),

  approve: os.tool.approve
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const response = input.always ? "always" : "once";
      const applied = context.approvalGate.reply(input.approvalId, response);
      return { applied };
    }),

  deny: os.tool.deny
    .use(authMiddleware)
    .handler(async ({ input, context }) => {
      const applied = context.approvalGate.reply(input.approvalId, "reject", input.feedback);
      return { applied };
    }),
};
