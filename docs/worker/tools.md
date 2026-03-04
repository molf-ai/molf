# Built-in Tools

Workers expose six built-in tools to the LLM. These are always available regardless of configuration. In addition, workers can load tools from external MCP servers via `.mcp.json` — see [MCP Integration](/worker/mcp) for details. All tools execute in the worker's working directory, and relative paths are resolved against that directory automatically.


## Tool Composition

A worker's full tool set is assembled from three sources:

| Source | Count | Description |
|--------|-------|-------------|
| Built-in tools | 6 (fixed) | Always loaded; documented on this page |
| Skill tool | 1 (fixed) | Server-registered; loads skill content on demand |
| Task tool | 0–1 | Server-registered; spawns subagents when agent definitions are available |
| Cron tool | 0–1 | Server-registered; manages scheduled jobs when cron is enabled |
| MCP tools | 0 – 43 | Loaded from `.mcp.json` at startup; named `{server}_{tool}` |

**Total tool limit**: 50 tools (hard cap). A warning is logged when the count
reaches 30 or more. MCP tools that would exceed the cap are dropped with a
warning during startup.

MCP tool names follow the pattern `{sanitizedServerName}_{sanitizedToolName}`
(e.g., `filesystem_read_file`, `github_search_repos`). Their descriptions are
prefixed with `[serverName]` so the LLM can distinguish them from built-in
tools.

## shell_exec

Execute a shell command and return combined output and exit code. Stdout and stderr are captured as a single interleaved stream. Commands run via the user's default shell.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | `string` | Yes | — | The shell command to execute |
| `cwd` | `string` | No | Worker workdir | Working directory for the command |
| `timeout` | `number` | No | `120000` (120s) | Timeout in milliseconds |

### Output

The LLM receives a single formatted text string with the combined output and exit code:

```
{output}

exit code: {exitCode}
```

The `agent.shellExec` client API returns:

| Field | Type | Description |
|-------|------|-------------|
| `output` | `string` | Combined stdout + stderr (interleaved) |
| `exitCode` | `number` | Process exit code |
| `truncated` | `boolean` | Whether output was truncated |
| `outputPath` | `string?` | Path to full output file (only set when truncated) |

On error (e.g. timeout), returns an error message.

### Details

- **Output truncation**: The combined output is truncated when it exceeds **2000 lines** or **50KB** (whichever limit is hit first). When truncated, the full output is saved to `.molf/tool-output/{toolCallId}.txt` and the truncated preview includes a hint pointing to the full file. Use `read_file` with `startLine`/`endLine` parameters to view specific sections of the full output, or `grep` to search it.
- **Stream interleaving**: Stdout and stderr are drained concurrently into a single buffer, providing chunk-level interleaving of the two streams.
- **Shell resolution**: Uses `$SHELL` environment variable, but blacklists fish and nu. Falls back to `/bin/zsh` on macOS, then `bash`, then `/bin/sh`.
- **Timeout behavior**: Sends SIGTERM to the entire process group, waits 200ms, then sends SIGKILL if the process hasn't exited.
- **Process isolation**: Commands run in a detached process group on non-Windows systems.

---

## read_file

Read the contents of a file. Supports text files with optional line ranges, and binary files (images, PDFs, audio) returned as base64.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | File path (relative to workdir) |
| `startLine` | `number` | No | — | First line to read (1-indexed) |
| `endLine` | `number` | No | — | Last line to read (1-indexed) |

### Output (Text Files)

The tool returns a formatted text string:

```
Content of {path} ({totalLines} lines):
{file content}
```

If the content exceeds 100,000 characters, it is truncated.

### Output (Binary Files)

For binary files, the tool returns a text description (`[Binary file: {path}, {mimeType}, {size} bytes]`) along with the file data as an attachment. The server inlines image attachments directly into the LLM context for visual analysis.

**Max binary size**: 15 MB.

### Supported Binary Types

| Category | Extensions |
|----------|------------|
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg` |
| Documents | `.pdf` |
| Audio | `.mp3`, `.ogg`, `.wav`, `.m4a`, `.flac`, `.aac` |

### Opaque Binary Types

The following file types return an error instead of content, as they cannot be meaningfully interpreted by the LLM:

`.zip`, `.tar`, `.gz`, `.exe`, `.dll`, `.so`, `.wasm`, `.jar`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.sqlite`, `.db`, and others.

### Nested Instruction Discovery

When `read_file` reads a file, the worker scans parent directories (from the file's directory up to the workdir, exclusive) for `AGENTS.md` or `CLAUDE.md` files. Discovered instruction files are reported to the server, which injects them into the tool output as system reminders. This means project-level instructions in subdirectories are automatically picked up without explicit configuration.

- Only one instruction file per directory (AGENTS.md takes priority over CLAUDE.md)
- Previously injected instructions are tracked per session to avoid duplicates
- After context summarization, the instruction tracker resets so instructions are re-injected

---

## write_file

Write content to a file. Creates the file if it doesn't exist, overwrites if it does.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | File path (relative to workdir) |
| `content` | `string` | Yes | — | Content to write |
| `createDirectories` | `boolean` | No | `false` | Create parent directories if missing |

### Output

Returns a confirmation string: `Wrote {bytesWritten} bytes to {path}`.

On error, returns an error message.

---

## edit_file

Edit a file by replacing exact string matches. Useful for targeted modifications without rewriting the entire file.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | Yes | — | File path (relative to workdir) |
| `oldString` | `string` | Yes | — | Exact string to find |
| `newString` | `string` | Yes | — | Replacement string |
| `replaceAll` | `boolean` | No | `false` | Replace all occurrences instead of requiring a unique match |

### Output

Returns a confirmation string: `Replaced {N} occurrence(s) in {path}`.

### Error Cases

- **Not found**: `oldString` does not exist in the file.
- **Multiple matches**: `oldString` matches more than one location and `replaceAll` is `false`. Provide a longer, more specific string or set `replaceAll: true`.

---

## glob

Find files matching a glob pattern. Returns matching file paths sorted by modification time, newest first.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | `string` | Yes | — | Glob pattern (e.g. `**/*.ts`, `src/*.json`) |
| `path` | `string` | No | Worker workdir | Directory to search in |

### Output

Returns matching file paths as a newline-separated list (max 100 entries). Returns `"No files found"` if no matches.

---

## grep

Search file contents using regex patterns. Uses ripgrep (`rg`) if available on the system, otherwise falls back to the system `grep`.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | `string` | Yes | — | Regex pattern to search for |
| `path` | `string` | No | Worker workdir | Directory or file to search in |
| `include` | `string` | No | — | Glob filter for files to search (e.g. `*.ts`) |

### Output

Returns matching lines in `{file}:{line}: {text}` format, one per line. Returns `"No matches found"` if no matches.

### Details

- **Max matches**: 100 results returned.
- **Max line length**: 500 characters per match (longer lines are truncated).
- **Timeout**: 15 seconds.
- **Search backend**: Prefers `rg` (ripgrep) for speed. Falls back to system `grep` if `rg` is not installed.

---

## Tool Approval

All tool calls initiated by the LLM pass through a server-side approval gate before being dispatched to the worker. The gate evaluates each call against per-worker rulesets to decide whether to allow it silently, deny it, or prompt the user for confirmation.

**Default rules for built-in tools:**

| Tool | Default Action | Notes |
|------|---------------|-------|
| `read_file` | allow | Default deny rules for `*.env`, `*credentials*`, `*secret*` patterns (can be overridden by later rules) |
| `glob` | allow | — |
| `grep` | allow | — |
| `write_file` | allow | Default deny rule for `*.env` patterns (can be overridden by later rules) |
| `edit_file` | allow | Default deny rule for `*.env` patterns (can be overridden by later rules) |
| `shell_exec` | ask | Requires user approval by default |

The `skill` tool also defaults to `ask`, requiring user approval before loading skill instructions. MCP tools and any unrecognized tools fall through to the `*` catch-all rule, which defaults to `ask`.

From the worker's perspective, this is transparent — the worker only receives tool calls that have already been approved. See [Tool Approval](/server/tool-approval) for the full rules reference and customization guide.

## See Also

- [Worker Overview](/worker/overview) — how workers run, connect, and resolve paths
- [Skills](/worker/skills) — extend the agent's capabilities with Markdown skill files
- [Contributing](/reference/contributing) — how to add a new built-in tool
- [MCP Integration](/worker/mcp) — extend the tool set with external MCP servers
- [Subagents](/server/subagents) — the `task` tool and subagent orchestration
