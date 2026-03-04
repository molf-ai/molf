import { router, authedProcedure } from "../context.js";
import {
  cronAddInput,
  cronListInput,
  cronRemoveInput,
  cronUpdateInput,
} from "@molf-ai/protocol";

export const cronRouter = router({
  list: authedProcedure
    .input(cronListInput)
    .query(({ input, ctx }) => {
      return ctx.cronService.list(input.workerId, input.workspaceId);
    }),

  add: authedProcedure
    .input(cronAddInput)
    .mutation(async ({ input, ctx }) => {
      return await ctx.cronService.add(input);
    }),

  remove: authedProcedure
    .input(cronRemoveInput)
    .mutation(async ({ input, ctx }) => {
      const removed = await ctx.cronService.remove(input.workerId, input.workspaceId, input.jobId);
      return { success: removed };
    }),

  update: authedProcedure
    .input(cronUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const { workerId, workspaceId, jobId, ...patch } = input;
      const job = await ctx.cronService.update(workerId, workspaceId, jobId, patch);
      return { success: !!job, job };
    }),
});
