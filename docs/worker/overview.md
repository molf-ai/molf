# Worker Overview

A worker is a headless process that connects to the Molf server, registers its available tools and skills, and executes tool calls dispatched by the server. Each worker operates within a specific working directory, and all file operations are scoped to that directory.

Workers connect **to** the server and wait for instructions — they never communicate directly with clients.

**Responsibilities:**

- Execute tool calls (shell commands, file I/O, search) on behalf of the LLM
- Load and report skills from the working directory
- Handle file uploads from clients
- Reconnect automatically after disconnections

## Running a Worker

```bash
bun run dev:worker -- --name my-worker --token <server-token>
```

### CLI Flags

| Flag | Short | Description | Default | Env Var |
|------|-------|-------------|---------|---------|
| `--name` | `-n` | Worker name (required) | — | — |
| `--workdir` | `-w` | Working directory | Current directory | — |
| `--server-url` | `-s` | WebSocket server URL | `ws://127.0.0.1:7600` | `MOLF_SERVER_URL` |
| `--token` | `-t` | Auth token (required) | — | `MOLF_TOKEN` |

**Example** — point a worker at a specific project:

```bash
bun run dev:worker -- \
  --name my-project \
  --workdir ~/projects/my-app \
  --token abc123
```

## Worker Identity

Each worker has a persistent UUID stored at `{workdir}/.molf/worker.json`:

```json
{ "workerId": "550e8400-e29b-41d4-a716-446655440000" }
```

- Created automatically on first run.
- Reused on subsequent runs from the same working directory.
- Sessions are bound to a worker by its UUID. Because the ID persists, sessions remain bound after a worker restart or reconnection — no manual re-linking required.

## Connection & Reconnection

Workers connect to the server over WebSocket. The connection URL includes the auth token, worker ID, and worker name as query parameters:

```
ws://{host}:{port}?token={token}&clientId={workerId}&name={workerName}
```

On connect, the worker registers itself with `worker.register`, reporting its tools, skills, and metadata (working directory path, AGENTS.md content). It then subscribes to `worker.onToolCall` and `worker.onUpload` to receive dispatched work.

### Connection States

| State | Description |
|-------|-------------|
| `disconnected` | Not connected to the server |
| `connecting` | Initial connection attempt in progress |
| `registered` | Connected and registered with the server |
| `reconnecting` | Connection lost, attempting to reconnect |

### Automatic Reconnection

If the connection drops, the worker reconnects automatically with exponential backoff:

| Parameter | Value |
|-----------|-------|
| Initial delay | 1 second |
| Maximum delay | 30 seconds |
| Multiplier | 2x |
| Jitter | ±25% |

Tool result delivery retries up to **3 times** with a 1-second base delay if the initial submission fails.

## Logging

Each worker logs to both the console and a rotating file in the working directory.

| Sink | Output | Format |
|------|--------|--------|
| Console | stdout | Pretty-formatted |
| File | `{workdir}/.molf/logs/worker.log` | JSONL |

Control logging via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLF_LOG_LEVEL` | `"info"` | `"debug"`, `"info"`, `"warning"`, `"error"` |
| `MOLF_LOG_FILE` | Enabled | Set to `"none"` to disable file logging |

```bash
# Debug logging
MOLF_LOG_LEVEL=debug bun run dev:worker -- --name my-worker --token <token>
```

At `info` level: startup, skills loaded, MCP tools loaded, server connection. At `debug`: MCP state transitions, tool reload events.

See [Logging Reference](/reference/logging) for the full category list.

## Workdir Layout

```
<workdir>/
├── AGENTS.md                     # Always-loaded instructions (see Skills)
├── .mcp.json                     # MCP server configuration (optional, see MCP)
├── skills/
│   ├── deploy/
│   │   └── SKILL.md
│   └── review/
│       └── SKILL.md
└── .molf/
    ├── worker.json
    ├── logs/
    │   └── worker.log
    ├── uploads/
    │   └── <uuid>-<filename>
    └── tool-output/
        └── <toolCallId>.txt
```

- **AGENTS.md** — Project-level instructions injected into every system prompt. See [Skills](/worker/skills).
- **.mcp.json** — Optional. Declares MCP servers whose tools are loaded automatically on startup. See [MCP Integration](/worker/mcp).
- **skills/** — On-demand skill definitions loaded lazily by the LLM. See [Skills](/worker/skills).
- **.molf/worker.json** — Persistent worker identity.
- **.molf/logs/** — Rotating JSONL log files. See [Logging Reference](/reference/logging).
- **.molf/uploads/** — Uploaded files, saved as `{uuid}-{sanitized_filename}` with path traversal protection.
- **.molf/tool-output/** — Full output of truncated tool results. When a tool's output exceeds the truncation threshold (2000 lines or 50KB), the complete output is saved here so it can be accessed via `read_file` or `grep`. File names are derived from the tool call ID.

## Path Resolution

All built-in tools resolve relative paths against the worker's working directory. Some tools also default their path argument to the workdir when it's omitted:

| Tool | Path Argument | Defaults to Workdir |
|------|---------------|---------------------|
| `shell_exec` | `cwd` | Yes |
| `read_file` | `path` | No |
| `write_file` | `path` | No |
| `edit_file` | `path` | No |
| `glob` | `path` | Yes |
| `grep` | `path` | Yes |

This resolution is handled transparently by the tool executor — the LLM can use relative paths like `src/main.ts` and they resolve correctly.

## MCP Tool Loading

Workers optionally load tools from external MCP (Model Context Protocol) servers.
Place a `.mcp.json` file in the workdir and the worker will connect to the
declared servers on startup, adapt their tools, and register them alongside
the built-in tools.

MCP tool loading is automatic — no CLI flags or restarts are needed beyond
creating or editing `.mcp.json`.

See [MCP Integration](/worker/mcp) for configuration format, transport types,
and troubleshooting.

## See Also

- [Built-in Tools](/worker/tools) — detailed reference for all six tools (input/output schemas, limits, behavior)
- [Skills](/worker/skills) — how to create and manage SKILL.md files and AGENTS.md
- [Configuration](/guide/configuration) — worker CLI flags and environment variables
- [MCP Integration](/worker/mcp) — connect external MCP servers to expose additional tools
