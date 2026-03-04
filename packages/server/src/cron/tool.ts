import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { CronSchedule, CronPayload } from "@molf-ai/protocol";
import type { CronService } from "./service.js";
import { parseDuration, parseDateTime, validateCronExpr } from "./time.js";

interface CronToolArgs {
  action: "add" | "list" | "remove" | "update";
  name?: string;
  at?: string;
  every?: string;
  cron?: string;
  tz?: string;
  message?: string;
  enabled?: boolean;
  job_id?: string;
}

/**
 * Build the "cron" tool for the LLM to create/list/remove/update scheduled jobs.
 */
export function buildCronTool(
  cronService: CronService,
  workspaceId: string,
  workerId: string,
): { name: string; toolDef: ToolSet[string] } {
  return {
    name: "cron",
    toolDef: tool({
      description:
        "Manage scheduled tasks. Use this to create, list, update, or remove recurring or one-shot jobs. " +
        "Jobs inject a message into the current workspace session and trigger an agent turn when they fire.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "list", "remove", "update"], description: "The action to perform" },
          name: { type: "string", description: "Human-readable name for the job" },
          at: { type: "string", description: "ISO 8601 datetime for a one-shot schedule (e.g. '2026-03-03T20:00:00+03:00')" },
          every: { type: "string", description: "Duration for repeating interval (e.g. '30m', '2h', '1d')" },
          cron: { type: "string", description: "Cron expression for complex schedules (e.g. '0 9 * * 1-5')" },
          tz: { type: "string", description: "IANA timezone for cron expressions (e.g. 'Europe/Kyiv')" },
          message: { type: "string", description: "Message to inject into session when the job fires" },
          enabled: { type: "boolean", description: "Enable or disable a job (for update)" },
          job_id: { type: "string", description: "Job ID (required for remove and update)" },
        },
        required: ["action"],
      }),
      execute: async (raw: unknown) => {
        const args = (raw ?? {}) as CronToolArgs;
        try {
          switch (args.action) {
            case "add":
              return await handleAdd(cronService, workspaceId, workerId, args);
            case "list":
              return handleList(cronService, workspaceId, workerId);
            case "remove":
              return await handleRemove(cronService, workspaceId, workerId, args);
            case "update":
              return await handleUpdate(cronService, workspaceId, workerId, args);
            default:
              return { error: `Unknown action: ${args.action}` };
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
}

function resolveSchedule(args: {
  at?: string;
  every?: string;
  cron?: string;
  tz?: string;
}): CronSchedule {
  if (args.at) {
    return { kind: "at", at: parseDateTime(args.at) };
  }
  if (args.every) {
    return { kind: "every", interval_ms: parseDuration(args.every) };
  }
  if (args.cron) {
    if (!validateCronExpr(args.cron)) {
      throw new Error(`Invalid cron expression: "${args.cron}"`);
    }
    return { kind: "cron", expr: args.cron, ...(args.tz ? { tz: args.tz } : {}) };
  }
  throw new Error("Must provide one of: at (ISO datetime), every (duration), or cron (expression)");
}

async function handleAdd(
  cronService: CronService,
  workspaceId: string,
  workerId: string,
  args: { name?: string; at?: string; every?: string; cron?: string; tz?: string; message?: string },
) {
  if (!args.name) throw new Error("name is required for add");
  if (!args.message) throw new Error("message is required for add");

  const schedule = resolveSchedule(args);
  const payload: CronPayload = { kind: "agent_turn", message: args.message };

  const job = await cronService.add({
    name: args.name,
    schedule,
    payload,
    workerId,
    workspaceId,
    enabled: true,
  });

  return {
    success: true,
    job: { id: job.id, name: job.name, schedule: job.schedule, nextRunAt: job.nextRunAt },
  };
}

function handleList(cronService: CronService, workspaceId: string, workerId: string) {
  const jobs = cronService.list(workerId, workspaceId);
  if (jobs.length === 0) return { jobs: [], message: "No scheduled jobs." };

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      schedule: j.schedule,
      message: j.payload.message,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      lastError: j.lastError,
    })),
  };
}

async function handleRemove(
  cronService: CronService,
  workspaceId: string,
  workerId: string,
  args: { job_id?: string },
) {
  if (!args.job_id) throw new Error("job_id is required for remove");
  const removed = await cronService.remove(workerId, workspaceId, args.job_id);
  if (!removed) throw new Error(`Job ${args.job_id} not found`);
  return { success: true, message: `Job ${args.job_id} removed.` };
}

async function handleUpdate(
  cronService: CronService,
  workspaceId: string,
  workerId: string,
  args: {
    job_id?: string;
    name?: string;
    at?: string;
    every?: string;
    cron?: string;
    tz?: string;
    message?: string;
    enabled?: boolean;
  },
) {
  if (!args.job_id) throw new Error("job_id is required for update");

  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.enabled !== undefined) patch.enabled = args.enabled;

  // If a schedule param is provided, replace the entire schedule
  if (args.at || args.every || args.cron) {
    patch.schedule = resolveSchedule(args);
  }

  // If message is provided, replace the payload
  if (args.message !== undefined) {
    patch.payload = { kind: "agent_turn", message: args.message };
  }

  const updated = await cronService.update(workerId, workspaceId, args.job_id, patch);
  if (!updated) throw new Error(`Job ${args.job_id} not found`);
  return { success: true, message: `Job ${args.job_id} updated.` };
}
