# Built-in Tools

Workers expose six built-in tools to the LLM. These are always available regardless of configuration. In addition, workers can load tools from external MCP servers via `.mcp.json` — see [MCP Integration](/worker/mcp) for details. All tools execute in the worker's working directory, and relative paths are resolved against that directory automatically.


## Tool Composition

A worker's full tool set is assembled from three sources:

| Source | Count | Description |
|--------|-------|-------------|
| Built-in tools | 6 (fixed) | Always loaded; documented on this page |
| Skill tool | 1 (fixed) | Server-registered; loads skill content on demand |
| MCP tools | 0 – 44 | Loaded from `.mcp.json` at startup; named `{server}_{tool}` |

**Total tool limit**: 50 tools (hard cap). A warning is logged when the count
reaches 30 or more. MCP tools that would exceed the cap are dropped with a
warning during startup.

MCP tool names follow the pattern `{sanitizedServerName}_{sanitizedToolName}`
(e.g., `filesystem_read_file`, `github_search_repos`). Their descriptions are
prefixed with `[serverName]` so the LLM can distinguish them from built-in
tools.

## shell_exec

Execute a shell command and return stdout, stderr, and exit code. Commands run via the user's default shell.

### Input

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | `string` | Yes | — | The shell command to execute |
| `cwd` | `string` | No | Worker workdir | Working directory for the command |
| `timeout` | `number` | No | `120000` (120s) | Timeout in milliseconds |

### Output

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | `string` | Standard output |
| `stderr` | `string` | Standard error |
| `exitCode` | `number` | Process exit code |
| `stdoutTruncated` | `boolean` | Whether stdout was truncated |
| `stderrTruncated` | `boolean` | Whether stderr was truncated |
| `stdoutOutputPath` | `string` | Path to full stdout file (only set when truncated) |
| `stderrOutputPath` | `string` | Path to full stderr file (only set when truncated) |

On error (e.g. timeout), returns `{ error: string }` instead.

### Details

- **Output truncation**: Stdout and stderr are independently truncated when they exceed **2000 lines** or **50KB** (whichever limit is hit first). When truncated, the full output is saved to `.molf/tool-output/{toolCallId}_stdout.txt` (or `_stderr.txt`) and the truncated preview includes a hint pointing to the full file. Use `read_file` with `startLine`/`endLine` parameters to view specific sections of the full output, or `grep` to search it.
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

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | File contents (max 100,000 characters) |
| `totalLines` | `number` | Total line count in the file |
| `truncated` | `boolean` | Whether content was truncated |

### Output (Binary Files)

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"binary"` | Discriminator |
| `data` | `string` | Base64-encoded file content |
| `mimeType` | `string` | MIME type of the file |
| `path` | `string` | File path |
| `size` | `number` | File size in bytes |

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

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Written file path |
| `bytesWritten` | `number` | Number of bytes written |

On error, returns `{ error: string }`.

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

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Edited file path |
| `replacements` | `number` | Number of replacements made |

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

| Field | Type | Description |
|-------|------|-------------|
| `files` | `string[]` | Matching file paths (max 100) |
| `count` | `number` | Total number of matches |
| `truncated` | `boolean` | Whether the results were truncated at 100 |

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

| Field | Type | Description |
|-------|------|-------------|
| `matches` | `Array<{ file, line, text }>` | Matching lines with file path and line number |
| `count` | `number` | Total match count |
| `truncated` | `boolean` | Whether results were truncated |

### Details

- **Max matches**: 100 results returned.
- **Max line length**: 500 characters per match (longer lines are truncated).
- **Timeout**: 15 seconds.
- **Search backend**: Prefers `rg` (ripgrep) for speed. Falls back to system `grep` if `rg` is not installed.

---

## See Also

- [Worker Overview](/worker/overview) — how workers run, connect, and resolve paths
- [Skills](/worker/skills) — extend the agent's capabilities with Markdown skill files
- [Contributing](/reference/contributing) — how to add a new built-in tool
- [MCP Integration](/worker/mcp) — extend the tool set with external MCP servers
