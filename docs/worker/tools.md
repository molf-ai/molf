# Built-in Tools

The worker registers six built-in tools that the LLM can call during a session. These tools handle shell execution, file operations, and codebase search.

## Overview

| Tool | Description |
|------|-------------|
| `shell_exec` | Execute a shell command |
| `read_file` | Read file contents (text or binary) |
| `write_file` | Write content to a file |
| `edit_file` | Find-and-replace within a file |
| `glob` | Find files matching a glob pattern |
| `grep` | Search file contents with regex |

In addition to the six worker-side tools, the server builds a `skill` tool when skills are available. See [Skills](/worker/skills) for details.

## Tool Reference

### `shell_exec`

Execute a shell command and return combined stdout/stderr and exit code.

Commands run via the user's shell (`$SHELL`), with fallbacks to `/bin/zsh` (macOS), `bash`, or `/bin/sh`. Shells known to be incompatible (`fish`, `nu`) are skipped automatically.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | -- | Shell command to execute |
| `cwd` | string | No | Worker workdir | Working directory for the command |
| `timeout` | number | No | 120,000 (120s) | Timeout in milliseconds |

**Output format:**

```
{combined stdout + stderr}

exit code: {exitCode}
```

Stdout and stderr are drained concurrently into a single buffer, providing chunk-level interleaving of both streams.

**Timeout behavior:** Sends SIGTERM to the entire process group, waits 200 ms for graceful shutdown, then sends SIGKILL if the process is still alive. Commands run in a detached process group for clean cleanup.

**Truncation:** The handler manages its own truncation. If combined output exceeds the truncation threshold, the full output is saved to `.molf/tool-output/{toolCallId}.txt` and a truncated preview is returned with a pointer to the full file.

### `read_file`

Read the contents of a file. Supports optional line-range reading for large files. For binary files (images, PDFs, audio), returns the file as a lazy `File` attachment (zero-copy, streamed on demand) that can be inlined into the LLM context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | -- | Absolute or relative path to the file |
| `startLine` | number | No | -- | First line to read (1-indexed, inclusive) |
| `endLine` | number | No | -- | Last line to read (1-indexed, inclusive) |

### `write_file`

Write content to a file. Creates the file if it does not exist, overwrites if it does.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | -- | Absolute or relative path to the file |
| `content` | string | Yes | -- | Content to write |
| `createDirectories` | boolean | No | `false` | Create parent directories if they do not exist |

### `edit_file`

Edit a file by replacing exact string matches. Fails if `oldString` is not found or matches multiple locations (unless `replaceAll` is `true`).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | -- | Absolute or relative path to the file |
| `oldString` | string | Yes | -- | Exact text to find |
| `newString` | string | Yes | -- | Replacement text |
| `replaceAll` | boolean | No | `false` | Replace all occurrences instead of requiring a unique match |

### `glob`

Find files matching a glob pattern. Returns matching file paths sorted by modification time, newest first.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | string | Yes | -- | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`) |
| `path` | string | No | Worker workdir | Directory to search in |

### `grep`

Search file contents using regex patterns. Uses ripgrep (`rg`) if available, falls back to system `grep`. Returns matching lines with file path and line number, sorted by file modification time.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | string | Yes | -- | Regex pattern to search for |
| `path` | string | No | Worker workdir | File or directory to search in |
| `include` | string | No | -- | File glob filter (e.g., `*.ts`, `*.{js,jsx}`) |

## Workdir Path Resolution

All built-in tools resolve relative paths against the worker's working directory. Some tools also default their path argument to the workdir when it is omitted:

| Tool | Path Argument | Defaults to Workdir |
|------|---------------|---------------------|
| `shell_exec` | `cwd` | Yes |
| `read_file` | `path` | No |
| `write_file` | `path` | No |
| `edit_file` | `path` | No |
| `glob` | `path` | Yes |
| `grep` | `path` | Yes |

This resolution is handled by the `ToolExecutor` via `pathArgs` metadata on each tool. The LLM can use relative paths like `src/main.ts` and they resolve correctly against the workdir.

## Tool Result Envelope

Every tool execution returns a result with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `output` | string | The tool's text output |
| `error` | string? | Error message if execution failed |
| `meta` | object? | Metadata: `truncated`, `outputId`, `exitCode`, `outputPath` |
| `attachments` | Attachment[]? | Binary attachments (e.g., images from `read_file`) |

## Truncation and Storage

Tool output is subject to truncation limits:

| Limit | Value |
|-------|-------|
| Maximum lines | 2,000 |
| Maximum bytes | 50 KB |

When a tool's output exceeds these limits, the `truncateAndStore` function:

1. Saves the full output to `{workdir}/.molf/tool-output/{toolCallId}.txt`
2. Returns a truncated preview with a message pointing to the full file
3. Sets `meta.truncated = true` and `meta.outputId` on the result

The truncation message suggests using `read_file` with line offsets or `grep` to access specific sections of the full output.

Some tools (like `shell_exec`) manage their own truncation. When a handler explicitly sets `meta.truncated` (to `true` or `false`), the safety-net truncation pass is skipped.

## Hooks

Tool execution fires two hooks through the plugin system:

- `before_tool_execute` -- called before the handler runs; can modify arguments or block execution
- `after_tool_execute` -- called after the handler returns; can modify the result

See [Plugins](/reference/plugins#worker-hooks) for the full hook reference.

## See Also

- [Worker Overview](/worker/overview) -- startup, connection, workdir layout
- [Skills](/worker/skills) -- the server-side `skill` tool and SKILL.md format
- [MCP Integration](/worker/mcp) -- external tools via MCP servers
- [Tool Approval](/server/tool-approval) -- server-side approval rules for tool calls
