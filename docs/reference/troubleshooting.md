# Troubleshooting

Common issues and solutions, organized by component.

## Using Logs

Before diving into specific issues, enable debug logging to get the most information:

```bash
MOLF_LOG_LEVEL=debug pnpm dev:server
MOLF_LOG_LEVEL=debug pnpm dev:worker -- --name my-worker
```

Log files are written in JSONL format. Use `jq` to filter:

```bash
# Server logs
cat data/logs/server.log | jq 'select(.level == "error")'

# Worker logs
cat .molf/logs/worker.log | jq 'select(.level == "error")'
```

See [Logging](./logging.md) for full details on log locations and configuration.

## Connection Issues

### TLS certificate errors

**Symptom**: `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or similar OpenSSL errors.

**Cause**: The server uses a self-signed TLS certificate by default. Clients and workers must either trust it via TOFU or provide a CA certificate.

**Solutions**:
- On first connect, the worker/client will prompt you to approve the server's certificate fingerprint. Accept it and the cert is pinned to `~/.molf/known_certs/`.
- For development, disable TLS on the server: `pnpm dev:server -- --no-tls`. Workers must then connect with `ws://` instead of `wss://`:
  ```bash
  pnpm dev:worker -- --name my-worker --server-url ws://127.0.0.1:7600
  ```
- For production with a proper CA: `--tls-ca /path/to/ca.pem` on the worker/client, or set `MOLF_TLS_CA`.

### Certificate fingerprint changed

**Symptom**: Connection fails after a server reinstall or cert regeneration.

**Cause**: The pinned certificate no longer matches the server's new certificate.

**Solution**: Remove the old pinned cert from `~/.molf/known_certs/` and reconnect to trigger a new TOFU prompt.

### Connection refused

**Symptom**: `ECONNREFUSED` when worker or client tries to connect.

**Checklist**:
- Is the server running? Check terminal output for the "Auth token:" line.
- Is the host/port correct? Default is `127.0.0.1:7600`.
- Is a firewall blocking the port?
- Is the URL scheme correct? Use `wss://` with TLS (default), `ws://` without.

### Authentication failures

**Symptom**: WebSocket closes immediately after connect, or "unauthorized" errors.

**Checklist**:
- Is the token correct? The server prints its token on startup.
- If using `MOLF_TOKEN`, is it set on both the server and the connecting client/worker?
- If using an API key from pairing, has the key been revoked? Check with `auth.listApiKeys`.
- API keys use the `yk_` prefix. Make sure you're using the full key string.

### Worker not connecting

**Symptom**: Worker starts but never registers with the server.

**Checklist**:
- Check the server URL scheme: default is `wss://127.0.0.1:7600` (note `wss://`, not `ws://`).
- If TLS is disabled on the server, the worker must use `ws://`.
- Check for TLS trust issues (see above).
- Connection timeout is 5 seconds. If the server is unreachable, the worker will retry with exponential backoff (1s initial, 30s max).

## Provider Issues

### Missing API key

**Symptom**: `No provider found for model "provider/model-name"` or similar.

**Solution**: Set the API key environment variable for your provider:

| Provider | Env Var |
|----------|---------|
| Google (Gemini) | `GEMINI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| xAI | `XAI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| DeepInfra | `DEEPINFRA_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cohere | `COHERE_API_KEY` |
| Together AI | `TOGETHER_AI_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| Amazon Bedrock | `AWS_ACCESS_KEY_ID` |
| Google Vertex | `GOOGLE_APPLICATION_CREDENTIALS` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

### Model not found

**Symptom**: Error resolving a model name.

**Checklist**:
- Model IDs use the `provider/model-name` format (e.g., `google/gemini-2.5-flash`).
- Check available models: the `provider.listModels` oRPC procedure shows all models the server can see.
- The models.dev catalog refreshes every 60 minutes. If a newly released model isn't showing up, restart the server.

### models.dev fetch failures

**Symptom**: Warnings about failing to fetch the model catalog.

**Cause**: The server fetches model metadata from `https://models.dev/api/models` with a 5-second timeout. Network issues or firewalls can block this.

**Solutions**:
- The server falls back through: memory cache > disk cache > bundled snapshot. The catalog is not required for operation.
- To disable catalog fetching entirely: `MODELS_DEV_DISABLE=1`.

## Session Issues

### Context length errors

**Symptom**: LLM returns a context length exceeded error.

**Behavior**: The agent automatically retries with aggressive context pruning when this happens. Two-pass pruning first soft-trims tool outputs (head + tail of 1500 chars each, targeting 30% reduction), then hard-clears outputs (targeting 50% reduction). Tool outputs under 50,000 characters and skill tool results are excluded from pruning.

If pruning is insufficient, context summarization kicks in at 80% context window usage (minimum 6 messages), keeping the last 4 turns intact.

### Summarization not triggering

**Symptom**: Long sessions never get summarized.

**Requirements**: Summarization requires at least 6 messages AND 80% of the context window to be used. Short conversations or conversations with small tool outputs may not trigger it.

## Tool Issues

### Tool dispatch timeout

**Symptom**: Tool call fails after 120 seconds with a timeout error.

**Cause**: The worker did not return a result within the 120-second dispatch timeout. This can happen with long-running shell commands or unresponsive MCP servers.

**Solutions**:
- For shell commands, consider breaking them into smaller steps.
- Check worker logs for errors in tool execution.
- If a worker disconnects during a tool call, all pending dispatches are rejected immediately.

### Tool output truncated

**Symptom**: Tool results show `[truncated]` markers.

**Behavior**: Tool output is truncated at 2,000 lines or 50 KB, whichever is hit first. The full output is saved to `.molf/tool-output/` on the worker. Clients can retrieve the full output via `fs.read` using the `outputId` from the `tool_call_end` event.

## Plugin Issues

### Plugin load failure

**Symptom**: Server fails to start with a plugin import error.

**Checklist**:
- Is the plugin installed? Default plugins (`@molf-ai/plugin-cron`, `@molf-ai/plugin-mcp`) are workspace packages.
- Does the plugin export a valid `PluginDescriptor`?
- If the plugin has a `configSchema`, does the config in `molf.yaml` match?

### MCP server connection issues

**Symptom**: MCP tools not appearing after worker connects.

**Checklist**:
- Is `.mcp.json` present in the worker's workdir?
- Is the MCP server binary installed and on the PATH?
- Check for `enabled: false` in the server definition.
- Check for tool name collisions (duplicate sanitized names within a server are dropped).
- Use `MOLF_LOG_LEVEL=debug` on the worker to see MCP connection details.

### MCP hot-reload not working

**Symptom**: Changes to `.mcp.json` don't take effect.

**Behavior**: The MCP plugin watches `.mcp.json` via chokidar. Changes should be detected within 500ms. If not:
- Check that the file is valid JSON.
- Restart the worker if the watcher has stalled.
- Environment variable interpolation (`${VAR_NAME}`) is resolved at load time; changes to env vars require a restart.

## Worker State Issues

### Skills/agents not updating

**Symptom**: Changes to `.agents/skills/` or `.agents/agents/` files aren't reflected.

**Behavior**: The StateWatcher monitors these directories via chokidar with a 500ms debounce. New skill directories are detected via polling every 5 seconds. Changes are synced to the server via the SyncCoordinator.

**If changes aren't picked up**:
- Check file locations: skills go in `.agents/skills/{name}/SKILL.md`, agents in `.agents/agents/{name}.md`.
- Fallback paths: `.claude/skills/` and `.claude/agents/` are also checked.
- Agent files must have YAML frontmatter with at least a `description` field, or they are silently skipped.
- Restart the worker if the watcher is not responding.

## See also

- [Logging](./logging.md) -- log configuration and file locations
- [Architecture](./architecture.md) -- understanding the component flow
- [Configuration](/guide/configuration) -- all config options, env vars, and CLI flags
