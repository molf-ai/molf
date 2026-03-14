# Plugins

Molf Assistant has an extensible plugin system for both the server and the worker. Plugins can add hooks, routes, tools, and services. Two plugins ship by default: `@molf-ai/plugin-cron` (server-side cron scheduling) and `@molf-ai/plugin-mcp` (worker-side MCP client integration).

## Defining a Plugin

Use `definePlugin` from the `protocol` package to create a plugin descriptor:

```typescript
import { getLogger } from "@logtape/logtape";
import { definePlugin } from "@molf-ai/protocol";
import { z } from "zod";

export default definePlugin({
  name: "my-plugin",

  // Optional: validated config schema
  configSchema: z.object({
    interval: z.number().default(60),
  }),

  // Server-side initialization (optional)
  server(api) {
    const logger = getLogger(["molf", "plugin", "my-plugin"]);
    api.on("turn_end", (event) => {
      logger.info("Turn completed", { sessionId: event.sessionId });
    });

    // Return cleanup if needed
    return {
      destroy() {
        // Called on server shutdown
      },
    };
  },

  // Worker-side initialization (optional)
  worker(api) {
    api.addTool("my_tool", {
      description: "Does something",
      inputSchema: { type: "object", properties: {} },
      async execute(args) {
        return { output: "done" };
      },
    });
  },
});
```

### PluginDescriptor

```typescript
interface PluginDescriptor<TConfig = unknown> {
  name: string;
  configSchema?: ZodType<TConfig>;   // Zod schema for plugin config validation
  server?: (api: ServerPluginApi<TConfig>) => PluginCleanup | Promise<PluginCleanup>;
  worker?: (api: WorkerPluginApi<TConfig>) => PluginCleanup | Promise<PluginCleanup>;
}
```

A plugin can implement `server`, `worker`, or both. The `configSchema` is validated against the config provided in `molf.yaml`. Both init functions may return a `{ destroy() }` cleanup object.

## Plugin Configuration

Plugins are configured in `molf.yaml`:

```yaml
plugins:
  # Simple specifier (no config)
  - "@molf-ai/plugin-cron"

  # With config
  - name: "my-plugin"
    config:
      interval: 30
```

The default plugins are `["@molf-ai/plugin-cron", "@molf-ai/plugin-mcp"]`.

## Server Plugin API

The `server(api)` callback receives a `ServerPluginApi` with these capabilities:

### Hook Registration

```typescript
api.on("before_tool_call", (event) => {
  // Inspect or modify the event
  return { args: { ...event.args, modified: true } };
}, { priority: 10 });
```

See [Hook System](#hook-system) below for dispatch modes and available hooks.

### Routes

Add routes accessible via the `plugin.query` and `plugin.mutate` procedures:

```typescript
import { defineRoutes } from "@molf-ai/protocol";
import { z } from "zod";

const routes = defineRoutes({
  list: {
    type: "query",
    input: z.object({}),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
    handler: async ({ input, context }) => {
      return [{ id: "1", name: "example" }];
    },
  },
  create: {
    type: "mutation",
    input: z.object({ name: z.string() }),
    output: z.object({ id: z.string() }),
    handler: async ({ input, context }) => {
      return { id: "new-id" };
    },
  },
});

// In server(api):
api.addRoutes(routes, context);
```

Clients call plugin routes via `plugin.query({ plugin: "my-plugin", method: "list", input: {} })`.

For typed client-side access, use `createPluginClient`:

```typescript
import { createPluginClient } from "@molf-ai/protocol";

const client = createPluginClient("my-plugin", rpcClient, routes);
const items = await client.list({});
```

### Tools

```typescript
// Global tool (available in all sessions)
api.addTool("my_tool", toolDefinition);

// Per-session tool (factory called for each session)
api.addSessionTool((ctx) => {
  // ctx: { sessionId, workerId, workspaceId }
  return {
    name: "session_tool",
    toolDef: { /* ... */ },
  };
  // Return null to skip for this session
});
```

### Services

Long-running services that start after all plugins are loaded and stop in reverse order on shutdown:

```typescript
api.addService({
  async start() {
    // Initialize background work
  },
  async stop() {
    // Clean up
  },
});
```

### Other API Members

| Member | Description |
|--------|-------------|
| `api.config` | Validated plugin config (typed if `configSchema` is provided) |
| `api.dataPath(workerId?, workspaceId?)` | Scoped data directory under `plugins/{pluginName}/` |
| `api.serverDataDir` | Raw server data directory (escape hatch) |
| `api.sessionMgr` | SessionManager instance |
| `api.eventBus` | EventBus instance |
| `api.agentRunner` | AgentRunner instance |
| `api.connectionRegistry` | ConnectionRegistry instance |
| `api.workspaceStore` | WorkspaceStore instance |
| `api.workspaceNotifier` | WorkspaceNotifier instance |

## Worker Plugin API

The `worker(api)` callback receives a `WorkerPluginApi`:

```typescript
// Add/remove tools
api.addTool("tool_name", {
  description: "...",
  inputSchema: { /* JSON Schema */ },
  async execute(args, ctx) {
    return { output: "result" };
  },
});
api.removeTool("tool_name");

// Add skills and agents
api.addSkill({ name: "my-skill", description: "...", content: "..." });
api.addAgent({ name: "my-agent", description: "...", content: "...", permission: {}, maxSteps: 10 });

// Sync state to server (after adding/removing tools)
await api.syncState();

// Hook registration
api.on("before_tool_execute", (event) => { /* ... */ });
```

| Member | Description |
|--------|-------------|
| `api.config` | Validated plugin config |
| `api.workdir` | Worker's working directory |

### Plugin Loading on Workers

Workers do not configure plugins directly. On registration, the server sends plugin specifiers to the worker in the `plugins` field of the registration response. The worker imports each plugin and calls `descriptor.worker(api)`.

## Hook System

Hooks use two dispatch modes:

### Modifying Dispatch

Handlers run **sequentially**, sorted by priority (higher priority numbers run first, default is 0). Each handler sees the accumulated modifications from prior handlers. Handlers can return a partial object to modify the event data, or `{ block: "reason" }` on blockable hooks to cancel the action.

```typescript
api.on("before_prompt", (event) => {
  // Modify the system prompt
  return { systemPrompt: event.systemPrompt + "\nExtra instructions." };
}, { priority: 10 });
```

Only keys present in the original event data are merged from handler results.

### Observing Dispatch

All handlers fire **in parallel**. Fire-and-forget -- errors are logged but do not affect the caller.

```typescript
api.on("turn_end", (event) => {
  // Log or record metrics; cannot modify anything
});
```

### Blocking

Three hooks support blocking: `before_tool_call`, `before_compaction`, and `before_tool_execute`. Returning `{ block: "reason" }` from a handler on these hooks cancels the action. On non-blockable hooks, block results are ignored with a warning.

```typescript
api.on("before_tool_call", (event) => {
  if (event.toolName === "dangerous_tool") {
    return { block: "Tool is not allowed" };
  }
});
```

## Server Hooks

| Hook | Mode | Blockable | Event Data |
|------|------|-----------|------------|
| `turn_start` | observing | no | `sessionId, prompt, model` |
| `before_prompt` | modifying | no | `sessionId, systemPrompt, messages, model, tools` |
| `after_prompt` | observing | no | `sessionId, response, usage, duration` |
| `turn_end` | observing | no | `sessionId, message, toolCallCount, stepCount, duration` |
| `before_tool_call` | modifying | **yes** | `sessionId, toolCallId, toolName, args, workerId` |
| `after_tool_call` | modifying | no | `sessionId, toolCallId, toolName, args, result, duration` |
| `before_compaction` | modifying | **yes** | `sessionId, messages, reason` |
| `after_compaction` | observing | no | `sessionId, originalCount, compactedCount, summary` |
| `session_create` | observing | no | `sessionId, name, workerId, workspaceId` |
| `session_delete` | observing | no | `sessionId` |
| `session_save` | modifying | no | `sessionId, messages` |
| `worker_connect` | observing | no | `workerId, name, tools, skills` |
| `worker_disconnect` | observing | no | `workerId, reason` |
| `server_start` | observing | no | `port, dataDir` |
| `server_stop` | observing | no | (empty) |

## Worker Hooks

| Hook | Mode | Blockable | Event Data |
|------|------|-----------|------------|
| `before_tool_execute` | modifying | **yes** | `toolName, args, workdir` |
| `after_tool_execute` | modifying | no | `toolName, args, result, duration` |
| `worker_start` | observing | no | `workerId, workdir` |
| `worker_stop` | observing | no | (empty) |

## Built-in Plugin: Cron

The `@molf-ai/plugin-cron` plugin adds cron job scheduling to the server.

### Routes

| Route | Type | Description |
|-------|------|-------------|
| `list` | query | List cron jobs for a workspace |
| `add` | mutation | Create a new cron job |
| `remove` | mutation | Delete a cron job |
| `update` | mutation | Update a cron job |

### Session Tool

Registers a per-session `cron` tool that lets the LLM manage cron jobs during a session.

### Schedule Kinds

| Kind | Description | Fields |
|------|-------------|--------|
| `at` | One-shot at a specific time | `at` (Unix timestamp in ms). Auto-removed after firing. |
| `every` | Repeating at a fixed interval | `interval_ms`, optional `anchor_ms` |
| `cron` | Cron expression | `expr` (cron string), optional `tz` (timezone) |

### Storage

Cron jobs are persisted at `{dataDir}/workers/{workerId}/workspaces/{workspaceId}/cron/jobs.json`.

## Built-in Plugin: MCP

The `@molf-ai/plugin-mcp` plugin runs on the worker and integrates MCP (Model Context Protocol) servers as tools. See [MCP Integration](/worker/mcp) for configuration details.

## See also

- [Architecture](./architecture.md) -- how plugins fit into the system
- [Protocol](./protocol.md) -- `plugin.query` and `plugin.mutate` procedures
- [MCP Integration](/worker/mcp) -- `.mcp.json` configuration and transports
