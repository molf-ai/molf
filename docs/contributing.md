# Contributing

This page covers the design principles, package conventions, and step-by-step instructions for adding tools, skills, and tRPC procedures to Molf Assistant.

## Design Principles

### No test-only mocks in production code

Never add mock implementations, test flags, or dependency injection indirection to production code solely for testability. Use the test framework's mocking capabilities (`mock.module`, spies, etc.) instead. Production code improvements that also benefit tests (e.g., proper async cleanup, subscription-ready signals) are welcome — the bar is "would this change be justified without tests?"

### One implementation = no interface

Don't create an interface or type when there is only one real implementation. Extract an interface only when there are (or will immediately be) multiple concrete implementations.

### Don't propagate options you don't use

If a parameter is only passed through to a child and has exactly one sensible value at runtime, it shouldn't exist. A function signature is an API — every parameter is a commitment.

### Solve the actual problem, not a general case

Before adding an abstraction, ask: "Does this solve a problem that exists today, or one I'm imagining?" If the answer is imaginary — don't add it.

### No leaky abstractions

A module's API should not expose concerns that belong to a different layer. If a parameter only makes sense when you know about the caller's internals (file paths, caching strategy, transport details), it doesn't belong in the callee's signature. Each layer owns its domain.

## Package Conventions

| Concern | Convention |
|---------|-----------|
| Runtime | Bun |
| Language | TypeScript (strict mode, ESNext target) |
| Validation | Zod 4 |
| Transport | tRPC v11 over WebSocket (`ws`) |
| LLM | Vercel AI SDK (`ai`) + 16 bundled provider packages (see [Providers](/server/providers)) |
| Testing | `bun:test`, all new code must have coverage |
| TUI | Ink 5 + React 18 |
| Telegram | grammY |

## Adding a Built-in Tool

Built-in tools are split across two packages: the **definition** (schema + metadata) lives in `protocol`, and the **handler** (execution logic) lives in `worker`.

**1. Create the tool definition in protocol:**

```typescript
// packages/protocol/src/tool-definitions/my-tool.ts
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const myToolInputSchema = z.object({
  input: z.string().describe("Description of the input"),
  optional: z.boolean().optional().describe("An optional flag"),
});

export const myToolDefinition: ToolDefinition = {
  name: "my_tool",
  description: "What this tool does",
  inputSchema: myToolInputSchema,
};
```

**2. Register the definition in the protocol index:**

Add exports to `packages/protocol/src/tool-definitions/index.ts` and include the definition in the `builtinToolDefinitions` array.

**3. Create the handler in the worker:**

```typescript
// packages/worker/src/tools/my-tool.ts
import { errorMessage } from "@molf-ai/protocol";
import type { ToolResultEnvelope, ToolHandlerContext } from "@molf-ai/protocol";

export async function myToolHandler(
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
): Promise<ToolResultEnvelope> {
  const { input, optional } = args as { input: string; optional?: boolean };

  try {
    // Implementation here
    return { output: "Result text" };
  } catch (err) {
    return { output: "", error: `Failed: ${errorMessage(err)}` };
  }
}
```

**4. Register the handler in the worker tools index:**

Add the handler to `BUILTIN_HANDLERS` in `packages/worker/src/tools/index.ts`.

**5. Add path argument metadata** (if your tool has file path parameters):

Add entries to `BUILTIN_PATH_ARGS` in the same file so paths are resolved relative to the worker's workdir.

**6. Write tests:**

- Unit tests in `packages/worker/tests/` covering behavior, edge cases, and error handling
- Schema tests in `packages/protocol/tests/` if the input schema has complex validation

## Adding a Skill

Skills require no code changes. Create a Markdown file:

```
{workdir}/.agents/skills/{skill-name}/SKILL.md
```

With YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does
---

Detailed instructions for the LLM when this skill is activated...
```

Restart the worker to pick up the new skill. See [Skills](/worker/skills) for details.

## Adding a tRPC Procedure

**1. Define the schema** in `packages/protocol/src/`:

```typescript
// In the appropriate schema file
export const myInput = z.object({
  sessionId: z.string().uuid(),
  value: z.string(),
});

export const myOutput = z.object({
  success: z.boolean(),
});
```

**2. Add the procedure** to the router in `packages/server/src/router.ts`:

```typescript
myProcedure: authedProcedure
  .input(myInput)
  .output(myOutput)
  .mutation(async ({ input, ctx }) => {
    // Implementation
    return { success: true };
  }),
```

**3. Write tests:**

- Unit test the procedure logic in `packages/server/tests/`
- Integration test the full round-trip in `packages/e2e/tests/integration/`

## Running Tests

Quick reference:

```bash
# All tests (unit + integration)
bun run test

# Unit tests only
bun run test:unit

# Integration tests only
bun run test:e2e

# Single test file
bun test packages/server/tests/session-mgr.test.ts

# Tests for a specific package
bun test packages/server/tests/

# Coverage report
bun run test:coverage

# Type-check a package
bunx tsc --noEmit -p packages/server/tsconfig.json
```

## See Also

- [Testing](/reference/testing) — test tiers, mocking patterns, and coverage
- [Architecture](/reference/architecture) — package dependency graph and module tables
- [Skills](/worker/skills) — creating skills requires no code changes
