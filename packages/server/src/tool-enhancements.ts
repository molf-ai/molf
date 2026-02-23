import type { ToolResultMetadata } from "@molf-ai/protocol";

export interface ToolEnhancement {
  afterExecute?: (
    output: string,
    meta: ToolResultMetadata | undefined,
    ctx: EnhancementContext,
  ) => string;
  beforeExecute?: (
    args: Record<string, unknown>,
    ctx: EnhancementContext,
  ) => Record<string, unknown>;
}

export interface EnhancementContext {
  toolCallId: string;
  toolName: string;
  sessionId: string;
  loadedInstructions: Set<string>;
}

const toolEnhancements = new Map<string, ToolEnhancement>();

// read_file enhancement: inject discovered instruction files into tool output
toolEnhancements.set("read_file", {
  afterExecute(output, meta, ctx) {
    if (meta?.instructionFiles?.length) {
      const newFiles = meta.instructionFiles.filter(
        (f) => !ctx.loadedInstructions.has(f.path),
      );
      if (newFiles.length > 0) {
        for (const f of newFiles) {
          ctx.loadedInstructions.add(f.path);
        }
        const blocks = newFiles
          .map(
            (f) =>
              `\n<system-reminder>\nNested instructions discovered from ${f.path}:\n\n${f.content}\n</system-reminder>`,
          )
          .join("\n");
        output += blocks;
      }
    }
    return output;
  },
});

export { toolEnhancements };
