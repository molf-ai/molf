import { router, authedProcedure } from "../context.js";
import { loadSessionOrThrow } from "./_helpers.js";
import {
  toolListInput,
  toolApproveInput,
  toolDenyInput,
} from "@molf-ai/protocol";

export const toolRouter = router({
  list: authedProcedure
    .input(toolListInput)
    .query(async ({ input, ctx }) => {
      const session = loadSessionOrThrow(ctx.sessionMgr, input.sessionId);

      const worker = ctx.connectionRegistry.getWorker(session.workerId);
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

  approve: authedProcedure
    .input(toolApproveInput)
    .mutation(async ({ input, ctx }) => {
      const response = input.always ? "always" : "once";
      const applied = ctx.approvalGate.reply(input.approvalId, response);
      return { applied };
    }),

  deny: authedProcedure
    .input(toolDenyInput)
    .mutation(async ({ input, ctx }) => {
      const applied = ctx.approvalGate.reply(input.approvalId, "reject", input.feedback);
      return { applied };
    }),
});
