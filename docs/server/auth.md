# Authentication

The server uses token-based authentication for all WebSocket connections. Every oRPC procedure (except pairing code redemption) requires a valid credential in the `Authorization: Bearer` header.

## Master Token

On first start, the server generates a random auth token and prints it to the terminal. The SHA-256 hash of this token is stored in `{dataDir}/secrets.json`.

To use a fixed token across restarts:

```bash
MOLF_TOKEN=my-secret-token pnpm dev:server
```

Or pass it via CLI:

```bash
pnpm dev:server -- --token my-secret-token
```

Workers and clients authenticate by passing this token:

```bash
pnpm dev:worker -- --name my-worker --token my-secret-token
```

## API Keys

API keys provide a more permanent authentication mechanism than the master token. They are created through the pairing flow and have a `yk_` prefix followed by a base64url-encoded value.

API key hashes are stored in the `apiKeys` array in `{dataDir}/secrets.json`.

### Managing API Keys

List all issued API keys:

- `auth.listApiKeys` oRPC procedure

Revoke a specific key:

- `auth.revokeApiKey` oRPC procedure

## Pairing Flow

The pairing flow allows new devices to authenticate without manually sharing tokens.

### Steps

1. An already-authenticated client calls `auth.createPairingCode`, which generates a 6-digit code
2. The server displays the pairing code (it is also returned to the calling client)
3. The new device connects without authentication and calls `auth.redeemPairingCode` with the 6-digit code
4. The server verifies the code, generates an API key (`yk_` prefix), stores its hash, and returns the key
5. The new device saves the API key to `~/.molf/servers.json`

The `redeemPairingCode` procedure is the only public (unauthenticated) procedure. It is rate-limited to prevent brute-force attacks.

### Automatic Pairing

Workers and clients that start without a `--token` or saved credential automatically enter the pairing flow:

1. Probe the server's TLS certificate (TOFU fingerprint approval)
2. Connect without auth
3. Prompt the user to enter the 6-digit pairing code from the server terminal
4. Exchange the code for an API key
5. Save the API key and pinned TLS certificate to `~/.molf/`

On subsequent runs, the saved credentials are used automatically.

## Credential Storage

Credentials are stored at `~/.molf/servers.json` by default. Override the directory with the `MOLF_CLIENT_DIR` environment variable.

The credentials file stores one entry per server URL, containing the API key and server name.

TLS certificates are pinned in `~/.molf/known_certs/`.

::: tip Provider API keys
Provider API keys (for LLM providers like Gemini or Anthropic) are stored separately on the server at `{dataDir}/secrets.json`. See [LLM Providers](/server/llm-providers#managing-provider-keys-at-runtime).
:::

## Verification

All authenticated procedures use a middleware (`authedProcedure`) that:

1. Extracts the token from the `Authorization: Bearer` header
2. Computes its SHA-256 hash
3. Compares against the master token hash and all API key hashes using constant-time comparison
4. Rejects the connection if no match is found

## See Also

- [Configuration](/guide/configuration) -- TLS and auth configuration options
- [Server Overview](/server/overview) -- server startup and auth initialization
- [Protocol](/reference/protocol) -- `auth.*` oRPC procedures
