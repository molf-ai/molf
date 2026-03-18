# LLM Providers

Molf Assistant uses the Vercel AI SDK (`ai` package) for all LLM interactions. It supports 16 bundled providers and can be extended with custom provider definitions.

Providers can be configured via environment variables at startup or via runtime key management. The server starts without requiring any API keys.

## Bundled Providers

| Provider | API Key Variable |
|----------|-----------------|
| `google` | `GEMINI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openai-compatible` | `OPENAI_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `deepinfra` | `DEEPINFRA_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `cohere` | `COHERE_API_KEY` |
| `togetherai` | `TOGETHER_AI_API_KEY` |
| `perplexity` | `PERPLEXITY_API_KEY` |
| `amazon-bedrock` | `AWS_ACCESS_KEY_ID` |
| `google-vertex` | `GOOGLE_APPLICATION_CREDENTIALS` |
| `azure` | `AZURE_OPENAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |

Providers become active when their API key is present — either from an environment variable at startup or added at runtime via the TUI `/providers` command or the `provider.setKey` oRPC procedure.

To enable all providers with detected keys regardless of the config file:

```bash
MOLF_ENABLE_ALL_PROVIDERS=1 pnpm dev:server
```

Or in `config.json`:

```jsonc
// config.json
{
  "enable_all_providers": true
}
```

Alternatively, use the wildcard entry in `enabled_providers`:

```jsonc
// config.json
{
  "enabled_providers": ["*"]
}
```

To enable only specific providers:

```jsonc
// config.json
{
  "enabled_providers": ["google", "anthropic"]
}
```

Providers also become available when a key is added at runtime via `provider.setKey` or the TUI `/providers` command — no restart required.

## Model Resolution

Models are specified in `provider/model-name` format (e.g., `google/gemini-2.5-flash` or `anthropic/claude-sonnet-4-20250514`).

The model for a given prompt is resolved in this priority order:

1. **Prompt-level** -- model specified in the `agent.prompt` call
2. **Workspace config** -- model set via `workspace.setConfig`
3. **Server default** -- set via `MOLF_DEFAULT_MODEL` env var or `model` in `config.json`

## Provider Initialization

The provider registry follows a 7-step pipeline on startup:

1. Load stored API keys from `secrets.json` via `ProviderKeyStore`
2. Load the model catalog (from models.dev or bundled snapshot)
3. Build the allowed providers list from `config.json`
4. Detect API keys in environment variables
5. Merge stored keys with env keys (env takes precedence)
6. Create SDK instances for providers that have any key
7. Resolve the default model if configured (optional — server starts without one)

## Managing Provider Keys at Runtime

Provider API keys can be added and removed while the server is running, without a restart.

### Via the TUI

Use the `/providers` command to browse all 16 supported providers. The picker shows:
- Which providers already have keys (from environment variables or stored)
- The key source (`env` for environment variables, `stored` for runtime-added keys)
- The number of models available for each provider

Select a provider to open the key management screen.

Use the `/keys` command to list and remove stored provider API keys.

### Via oRPC

| Procedure | Type | Description |
|-----------|------|-------------|
| `provider.setKey` | mutation | Store an API key for a provider. Takes effect immediately. Persisted in `secrets.json`. |
| `provider.removeKey` | mutation | Remove a stored API key for a provider. Takes effect immediately. |

After `setKey` or `removeKey`, the provider registry reloads and a `provider_state_changed` event is broadcast to all connected clients.

### Key Precedence

Environment variables (e.g., `GEMINI_API_KEY`) take precedence over keys stored at runtime.

### Persistence

Stored keys are written to `{dataDir}/secrets.json` with 0o600 permissions (readable only by the owner). Keys persist across server restarts.

## models.dev Catalog

The server fetches an up-to-date model catalog from [models.dev](https://models.dev) to provide model metadata and validation.

| Setting | Value |
|---------|-------|
| Catalog URL | `https://models.dev/api/models` |
| Fetch timeout | 5s |
| Refresh interval | 60 min |

The fallback chain when fetching models:

1. In-memory cache
2. Disk cache (persisted between restarts)
3. Bundled snapshot (shipped with the package)
4. Live fetch from models.dev API

To disable the models.dev catalog entirely:

```bash
MODELS_DEV_DISABLE=1 pnpm dev:server
```

## Custom Providers

Define custom providers in `config.json` under the `custom_providers` key:

```jsonc
// config.json
{
  "custom_providers": {
    "my-provider": {
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.my-provider.com/v1"
      },
      "models": {
        "my-model": { "name": "My Model" }
      }
    }
  }
}
```

Custom providers are registered alongside the bundled ones and can be referenced using the same `provider/model` format.

### Via oRPC

Custom providers can also be managed at runtime without editing `config.json` directly:

| Procedure | Type | Description |
|-----------|------|-------------|
| `provider.addCustomProvider` | mutation | Add a custom provider to `config.json` |
| `provider.updateCustomProvider` | mutation | Update an existing custom provider |
| `provider.removeCustomProvider` | mutation | Remove a custom provider |
| `provider.getCustomProvider` | query | Retrieve a custom provider's config |
| `provider.listCustomProviders` | query | List all custom providers |

## Provider-Specific Behavior

Some providers have special handling:

- **Anthropic** -- enables the interleaved-thinking beta header automatically
- **OpenAI** -- GPT-5 and later models use the responses API instead of the chat completions API

## Behavior Configuration

The `behavior` section in `config.json` controls agent behavior:

```jsonc
// config.json
{
  "behavior": {
    "temperature": 0.7,
    "contextPruning": true
  }
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `temperature` | LLM sampling temperature | Provider default |
| `contextPruning` | Enable automatic context pruning | `true` |

The `BehaviorConfig` also supports `systemPrompt` and `maxSteps` (default: 10) when set programmatically.

## See Also

- [Configuration](/guide/configuration) -- full configuration reference including provider API keys
- [Sessions](/server/sessions) -- how model resolution works per-prompt
- [Architecture](/reference/architecture) -- provider registry in the package graph
