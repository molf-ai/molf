import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { JsonValue, Attachment } from "@molf-ai/protocol";
import type { WorkerRegistration } from "./connection-registry.js";
import type { ToolDispatch } from "./tool-dispatch.js";
import { toolEnhancements } from "./tool-enhancements.js";
import type { ApprovalGate } from "./approval/approval-gate.js";
import { ToolDeniedError, ToolRejectedError } from "./approval/approval-gate.js";
import { attachmentToContentParts } from "./attachment-resolver.js";

/** Race a promise against an AbortSignal. Rejects with Error("Aborted") if signal fires first. */
export function raceAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Build a server-local "skill" tool that lets the LLM load skill content on demand.
 * Returns null if the worker has no skills, otherwise returns { name, toolDef } for registration.
 */
export function buildSkillTool(
  worker: WorkerRegistration,
  approvalGate: ApprovalGate,
  sessionId: string,
  workerId: string,
): { name: string; toolDef: ToolSet[string] } | null {
  if (worker.skills.length === 0) return null;

  const skillMap = new Map(worker.skills.map((s) => [s.name, s]));
  const skillNames = worker.skills.map((s) => s.name);

  const descriptionLines = worker.skills.map(
    (s) => `  <skill name="${s.name}">${s.description || s.name}</skill>`,
  );
  const description = `Load detailed instructions for a skill.\n<skills>\n${descriptionLines.join("\n")}\n</skills>`;

  return {
    name: "skill",
    toolDef: tool({
      description,
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: skillNames,
            description: "The skill to load",
          },
        },
        required: ["name"],
      }),
      execute: async (args: unknown, { abortSignal }: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const toolArgs = (args ?? {}) as Record<string, unknown>;

        // Approval gate: evaluate then request/wait if needed
        const { action, patterns, alwaysPatterns, matchingRules } = await approvalGate.evaluate(
          "skill",
          toolArgs,
          sessionId,
          workerId,
        );

        if (action === "deny") {
          return new ToolDeniedError("skill", patterns[0], matchingRules).message;
        }

        if (action === "ask") {
          const approvalId = approvalGate.requestApproval(
            "skill",
            toolArgs,
            patterns,
            alwaysPatterns,
            sessionId,
            workerId,
          );
          try {
            await raceAbort(approvalGate.waitForApproval(approvalId), abortSignal);
          } catch (err) {
            if (err instanceof Error && err.message === "Aborted") {
              approvalGate.cancel(approvalId);
            }
            if (err instanceof ToolRejectedError) {
              return err.message;
            }
            throw err;
          }
        }

        const { name } = toolArgs as { name: string };
        const skill = skillMap.get(name);
        if (!skill) {
          return { error: `Unknown skill "${name}". Available skills: ${skillNames.join(", ")}` };
        }
        return { content: skill.content };
      },
    }),
  };
}

export function buildRemoteTools(
  worker: WorkerRegistration,
  workerId: string,
  deps: {
    approvalGate: ApprovalGate;
    toolDispatch: ToolDispatch;
    truncationMeta: Map<string, { truncated?: boolean; outputId?: string }>;
    attachmentMeta: Map<string, Attachment[]>;
  },
  sessionCtx?: { sessionId: string; loadedInstructions: Set<string> },
): ToolSet {
  const tools: ToolSet = {};
  for (const toolInfo of worker.tools) {
    const enhancement = toolEnhancements.get(toolInfo.name);

    tools[toolInfo.name] = tool({
      description: toolInfo.description,
      inputSchema: jsonSchema(toolInfo.inputSchema as any),
      execute: async (args: unknown, { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal }) => {
        let toolArgs = (args ?? {}) as Record<string, unknown>;

        // Optional beforeExecute hook
        if (enhancement?.beforeExecute && sessionCtx) {
          toolArgs = enhancement.beforeExecute(toolArgs, {
            toolCallId,
            toolName: toolInfo.name,
            sessionId: sessionCtx.sessionId,
            loadedInstructions: sessionCtx.loadedInstructions,
          });
        }

        // Approval gate: evaluate then request/wait if needed
        if (sessionCtx) {
          const { action, patterns, alwaysPatterns, matchingRules } = await deps.approvalGate.evaluate(
            toolInfo.name,
            toolArgs,
            sessionCtx.sessionId,
            workerId,
          );

          if (action === "deny") {
            // Return as tool result (not throw) so the AI SDK records a proper tool-result
            return new ToolDeniedError(toolInfo.name, patterns[0], matchingRules).message;
          }

          if (action === "ask") {
            const approvalId = deps.approvalGate.requestApproval(
              toolInfo.name,
              toolArgs,
              patterns,
              alwaysPatterns,
              sessionCtx.sessionId,
              workerId,
            );
            try {
              await raceAbort(deps.approvalGate.waitForApproval(approvalId), abortSignal);
            } catch (err) {
              if (err instanceof Error && err.message === "Aborted") {
                deps.approvalGate.cancel(approvalId);
              }
              // For ToolRejectedError, return as result so the SDK creates a tool-result.
              // For abort errors, re-throw so the stream is cancelled properly.
              if (err instanceof ToolRejectedError) {
                return err.message;
              }
              throw err;
            }
          }
        }

        const { output, error, meta, attachments } = await deps.toolDispatch.dispatch(workerId, {
          toolCallId,
          toolName: toolInfo.name,
          args: toolArgs,
        });

        // Stash truncation metadata for mapAgentEvent to attach to tool_call_end
        if (meta?.truncated || meta?.outputId) {
          deps.truncationMeta.set(toolCallId, {
            truncated: meta.truncated,
            outputId: meta.outputId,
          });
        }

        if (error) {
          throw new Error(error);
        }

        // Stash attachments for toModelOutput
        if (attachments?.length) {
          deps.attachmentMeta.set(toolCallId, attachments);
        }

        // Run afterExecute hook (instruction injection happens here)
        if (enhancement?.afterExecute && sessionCtx) {
          return enhancement.afterExecute(output, meta, {
            toolCallId,
            toolName: toolInfo.name,
            sessionId: sessionCtx.sessionId,
            loadedInstructions: sessionCtx.loadedInstructions,
          });
        }

        return output;
      },
      toModelOutput: ({ output, toolCallId }) => {
        // Check for stashed attachments (binary files)
        const attachments = deps.attachmentMeta.get(toolCallId);
        if (attachments) {
          deps.attachmentMeta.delete(toolCallId);
          const textPart = { type: "text" as const, text: typeof output === "string" ? output : JSON.stringify(output) };
          const fileParts = attachments.flatMap(attachmentToContentParts);
          return { type: "content" as const, value: [textPart, ...fileParts] };
        }

        // No attachments — return text as-is
        return typeof output === "string"
          ? { type: "text" as const, value: output }
          : { type: "json" as const, value: output as JsonValue };
      },
    });
  }
  return tools;
}
