# MCP Integration

MCP (Model Context Protocol) is a standard for exposing tools from external services. Workers support connecting to MCP servers, discovering their tools, and routing the LLM's tool calls to them. Everything is configuration-driven via `.mcp.json` — no code changes are required to add new MCP servers.

## Quick Start

Create a `.mcp.json` file in your worker's working directory:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {}
    }
  }
}
```

Restart the worker. The filesystem server's tools become available automatically — no CLI flags or code changes needed.

Each tool is registered under a qualified name combining the server name and the original tool name. For example, a tool named `read_file` from the `filesystem` server becomes `filesystem_read_file`. The LLM can call it like any other built-in tool.

## Configuration Reference

### File Location

The configuration file is read from `{workdir}/.mcp.json` on every worker startup. The file is optional — if absent, no MCP servers are loaded.

### Schema

`mcpServers` is a `Record<string, StdioServerConfig | HttpServerConfig>`. The key is the server name, which is used to qualify tool names and in log messages.

#### Stdio Server (`"type": "stdio"`)

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | Yes | — | Must be `"stdio"` |
| `command` | Yes | — | Executable to run (e.g. `npx`, `node`) |
| `args` | No | `[]` | Command arguments |
| `env` | No | `{}` | Extra environment variables for the subprocess |
| `enabled` | No | `true` | Set to `false` to skip this server |

#### HTTP Server (`"type": "http"`)

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | Yes | — | Must be `"http"` |
| `url` | Yes | — | Absolute URL of the MCP endpoint |
| `headers` | No | `{}` | HTTP headers (e.g. `Authorization`) |
| `enabled` | No | `true` | Set to `false` to skip this server |

### Environment Variable Interpolation

Use `${VAR_NAME}` in string fields to substitute environment variables at startup.

**Applies to:** `command`, `args` items, `env` values, `url`, and `headers` values.

**Special variable:** `${WORKDIR}` resolves to the worker's working directory.

**Missing variables:** Replaced with an empty string. A warning is logged for each missing variable. Env keys are NOT interpolated — only values are.

## Tool Naming

MCP tools are registered under a qualified name:

```
{sanitizedServerName}_{sanitizedToolName}
```

Sanitization replaces any character that is not alphanumeric, `-`, or `_` with `_`. Examples:

| Server name | Tool name | Qualified name |
|-------------|-----------|----------------|
| `filesystem` | `read_file` | `filesystem_read_file` |
| `my-github` | `search repos` | `my_github_search_repos` |

Tool descriptions are prefixed with `[serverName]` so the LLM can distinguish them from built-in tools:

```
[filesystem] Read a file from the system
```

**Limits:**

- **Duplicates**: If two tools from the same server produce the same sanitized name, the duplicate is dropped with a warning.

## Tool Composition

A worker's full tool set is assembled from three sources:

| Source | Count | Description |
|--------|-------|-------------|
| Built-in tools | 6 (fixed) | Always loaded; see [Built-in Tools](/worker/tools) |
| Skill tool | 1 (fixed) | Server-registered; loads skill content on demand |
| Task tool | 0–1 | Server-registered; spawns subagents when agent definitions are available |
| Cron tool | 0–1 | Server-registered; manages scheduled jobs when cron is enabled |
| MCP tools | 0+ | Loaded from `.mcp.json` at startup; named `{server}_{tool}` |

## How Tools Are Loaded

On startup, the worker follows this sequence:

1. Reads `.mcp.json` from the working directory (skips entirely if the file is absent)
2. Connects to all enabled servers in parallel (30-second connection timeout each)
3. Lists tools from each connected server (10-second timeout)
4. Adapts each tool into Molf's tool format (qualified name, prefixed description, schema enforcement, structured result envelope)
5. Registers adapted tools with `ToolExecutor` -- they are indistinguishable from built-in tools at runtime
7. Sets up a `ToolListChanged` listener for each server to handle dynamic updates

::: info
Failed connections do NOT fail worker startup. The worker logs a warning and continues with whatever tools it could load.
:::

## Dynamic Tool Updates

When an MCP server sends a `ToolListChanged` notification:

1. The worker removes the old tools from that server (by name prefix)
2. Re-fetches the tool list from the server
3. Re-adapts and re-registers the new tools
4. Logs a summary of tools added and removed

No worker restart is required.

## Transport Types

### Stdio (subprocess)

Spawns a local subprocess via `StdioClientTransport`.

**Use for:** npm packages (`npx ...`), local scripts (`node server.js`)

- Subprocess stderr is captured and logged with the prefix `MCP [serverName] stderr: ...`
- Only safe environment keys are passed to subprocesses: `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, plus any variables declared in the `env` field. This prevents accidental credential leaks.
- The process is cleaned up on worker exit (SIGTERM, then SIGKILL after a grace period)

### HTTP (remote)

Connects to a remote URL via `StreamableHTTPClientTransport`.

**Use for:** hosted MCP services, cloud APIs

- Custom headers are supported (e.g. `Authorization: Bearer ${TOKEN}`)
- The URL must be absolute (validated at startup)

## Connection Resilience

When a stdio server disconnects, the worker schedules automatic reconnection with exponential backoff:

| Parameter | Value |
|-----------|-------|
| Initial delay | 1 second |
| Multiplier | 1.5x |
| Maximum delay | 30 seconds |

If the LLM calls a tool while the server is offline, the tool returns:

```
[serverName] is offline — reconnecting
```

This lets the LLM understand the situation rather than receiving an opaque error.

A stale connection guard prevents double-reconnect races — if a new client has already replaced a stale one, the stale reconnection attempt is discarded.

## Timeouts

| Operation | Timeout |
|-----------|---------|
| Initial connection | 30 seconds |
| List tools | 10 seconds |
| Tool call execution | 60 seconds |

## Examples

### Filesystem server

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKDIR}"],
      "env": {}
    }
  }
}
```

Tools available: `filesystem_read_file`, `filesystem_write_file`, `filesystem_list_directory`, etc.

### GitHub API (remote HTTP)

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

Set `GITHUB_TOKEN` in your environment before starting the worker.

### Local custom server (disabled by default)

```json
{
  "mcpServers": {
    "local_service": {
      "type": "stdio",
      "command": "node",
      "args": ["${WORKDIR}/tools/my-mcp-server.js"],
      "env": {
        "API_KEY": "${MCP_API_KEY}"
      },
      "enabled": false
    }
  }
}
```

Set `enabled: true` (or remove the field) to activate.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Server not connecting | `command` not found | Ensure `npx`/`node`/binary is on `PATH`. Run the command manually to test. |
| `${MY_VAR}` not interpolated | Env var not set | Export the variable before starting the worker. Missing vars become empty string. |
| Tool calls return "is offline" | Server disconnected | Check stderr logs (`MCP [name] stderr: ...`). Reconnection is automatic. |
| Tools unexpectedly absent | Duplicate names or connection failure | Check startup logs for collision warnings or connection errors. Disable unused servers with `enabled: false`. |
| Connection timeout | Remote server unreachable | Verify the URL and any firewall/auth. Connection timeout is 30s. |
| Duplicate tool warning | Two tools with same sanitized name | Rename servers or use unique tool names. |

## Tool Approval

MCP tool calls are subject to the server-side tool approval gate. They match against the `*` catch-all rule, which defaults to `ask` — meaning users are prompted to approve each MCP tool call unless a custom rule is added to the worker's `permissions.jsonc` file.

MCP tools are matched by their qualified tool name (e.g., `filesystem_read_file`). You can add rules mapping specific MCP tools to actions (`allow`, `deny`, or `ask`) by editing the worker's permissions file at `{dataDir}/workers/{workerId}/permissions.jsonc`, or by selecting "Always Approve" when prompted. Later rules override earlier ones for the same tool.

See [Tool Approval](/server/tool-approval) for how to add custom rules and the full evaluation logic.

## Planned Features

The following capabilities are planned but not yet implemented:

- **MCP sampling** — handle `sampling/createMessage` from MCP servers to delegate LLM calls back to Molf's agent
- **MCP prompts** — expose `listPrompts`/`getPrompt` as slash commands (e.g. `/mcp:serverName:promptName`)
- **MCP resources** — expose `listResources`/`readResource` via `@mention` syntax
- **OAuth support** — authenticate against remote MCP servers via the OAuth flow

## See Also

- [Worker Overview](/worker/overview) — worker identity, connection, and workdir layout
- [Built-in Tools](/worker/tools) — the six tools always available alongside MCP tools
- [Skills](/worker/skills) — extend the agent with Markdown skill files
- [Configuration](/guide/configuration) — worker CLI flags and MCP configuration
