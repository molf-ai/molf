# LLM Providers

Molf Assistant uses the Vercel AI SDK (`ai` package) for all LLM interactions. It supports 16 bundled providers and can be extended with custom provider definitions.

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

Providers are auto-detected based on the presence of their API key environment variable. Only providers with a detected key are available.

To enable all providers with detected keys regardless of the config file:

```bash
MOLF_ENABLE_ALL_PROVIDERS=1 pnpm dev:server
```

Or in `molf.yaml`:

```yaml
enable_all_providers: true
```

To enable only specific providers:

```yaml
enabled_providers:
  - google
  - anthropic
```

## Model Resolution

Models are specified in `provider/model-name` format (e.g., `google/gemini-2.5-flash` or `anthropic/claude-sonnet-4-20250514`).

The model for a given prompt is resolved in this priority order:

1. **Prompt-level** -- model specified in the `agent.prompt` call
2. **Workspace config** -- model set via `workspace.setConfig`
3. **Server default** -- set via `MOLF_DEFAULT_MODEL` env var or `model` in `molf.yaml`

## Provider Initialization

The provider registry follows a 7-step pipeline on startup:

1. Parse the model ID into provider and model name
2. Load the model catalog (from models.dev or bundled snapshot)
3. Build the list of allowed providers from config
4. Detect API keys in environment variables
5. Create SDK instances for detected providers
6. Resolve the requested language model
7. Return the provider state and resolved model

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

Define custom providers in `molf.yaml` under the `providers` key:

```yaml
providers:
  my-provider:
    # Custom provider configuration
```

Custom providers are registered alongside the bundled ones and can be referenced using the same `provider/model` format.

## Provider-Specific Behavior

Some providers have special handling:

- **Anthropic** -- enables the interleaved-thinking beta header automatically
- **OpenAI** -- GPT-5 and later models use the responses API instead of the chat completions API

## Behavior Configuration

The `behavior` section in `molf.yaml` controls agent behavior:

```yaml
behavior:
  temperature: 0.7
  contextPruning: true
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
