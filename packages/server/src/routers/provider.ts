import { z } from "zod";
import { router, authedProcedure } from "../context.js";

export const providerRouter = router({
  listProviders: authedProcedure.query(async ({ ctx }) => {
    const providers = ctx.providerState.providers;
    return {
      providers: Object.values(providers).map((p) => ({
        id: p.id,
        name: p.name,
        modelCount: Object.keys(p.models).length,
      })),
    };
  }),

  listModels: authedProcedure
    .input(z.object({ providerID: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const providers = ctx.providerState.providers;
      const providerID = input?.providerID;

      const models: Array<{
        id: string;
        name: string;
        providerID: string;
        capabilities: { reasoning: boolean; toolcall: boolean; temperature: boolean };
        cost: { input: number; output: number };
        limit: { context: number; output: number };
        status: string;
      }> = [];

      for (const [pid, provider] of Object.entries(providers)) {
        if (providerID && pid !== providerID) continue;
        for (const model of Object.values(provider.models)) {
          models.push({
            id: `${model.providerID}/${model.id}`,
            name: model.name,
            providerID: model.providerID,
            capabilities: {
              reasoning: model.capabilities.reasoning,
              toolcall: model.capabilities.toolcall,
              temperature: model.capabilities.temperature,
            },
            cost: { input: model.cost.input, output: model.cost.output },
            limit: { context: model.limit.context, output: model.limit.output },
            status: model.status,
          });
        }
      }

      return { models };
    }),
});
