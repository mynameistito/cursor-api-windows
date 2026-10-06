# Architecture

`cursor-api` packages a Windows CLI, a background daemon, an HTTP API server, and a separate Node.js bridge process. The daemon runs locally and binds its API server to loopback; it is not a hosted service.

## Runtime components

```text
Coding-agent client
        │ HTTP (loopback)
        ▼
cursor-api.exe ── local HTTP server and API adapters
        │                         │
        │ local bridge calls      └── OpenAI / Anthropic request translation
        ▼
Bundled Node.js process ── @cursor/sdk ── Cursor Composer
```

1. **CLI (`apps/cli/src/cli.ts`)** parses commands such as `start`, `stop`, `key`, and `port`.
2. **Supervisor (`apps/cli/src/daemon.ts`)** starts and monitors the background runtime. PID/state and logs are stored under the user's AppData directory.
3. **HTTP server (`apps/cli/src/server.ts`)** listens on `127.0.0.1` at the configured port (default `6903`). It adapts Node HTTP requests to Web `Request`/`Response` objects, routes API calls, and streams server-sent events.
4. **API adapters (`apps/cli/src/api/` and `apps/cli/src/anthropic.ts`)** translate supported client request/response formats to and from Composer input and output.
5. **SDK bridge (`apps/cli/src/bridge.ts`)** launches the bundled Node runtime and `@cursor/sdk` bridge. Keeping it separate allows native SQLite and Node HTTP/2 requirements without embedding those dependencies into the compiled CLI executable.

The bridge is the primary chat path. If it is unavailable, the daemon can continue without it and use the direct fallback path, which may have different capabilities. Do not assume the fallback provides feature parity.

## Request lifecycle

1. The user stores a Cursor API key with `cursor-api key set` and starts the daemon.
2. The supervisor loads settings and the saved key, launches the bridge, then starts the local server.
3. The client sends a supported OpenAI-compatible or Anthropic-compatible request to the local server.
4. The server authenticates the local request, validates/translates its payload, and sends the corresponding Composer request through the SDK bridge (or fallback path).
5. The adapter returns a compatible JSON response or streams events to the client.

See [the API reference](api.md) for routes, auth behavior, and compatibility limits.

## Configuration and local data

| Item                  | Default                               |
| --------------------- | ------------------------------------- |
| Listen host           | `127.0.0.1`                           |
| Listen port           | `6903`                                |
| Settings              | `%APPDATA%\cursor-api\settings.json`  |
| Encrypted Cursor key  | `%APPDATA%\cursor-api\api-key.enc`    |
| PID and runtime state | `%APPDATA%\cursor-api\run\`           |
| Logs                  | `%APPDATA%\cursor-api\logs\`          |
| Program install       | `%LOCALAPPDATA%\Programs\cursor-api\` |

Change the port with `cursor-api port set <port>`, then restart the daemon to apply it. The `CURSOR_API_HOME` environment variable changes the install/resource root; it does not relocate the settings and key directories under AppData.

The CLI encrypts the saved key using AES-256-GCM with a key derived from the Windows username and computer name. This is encryption at rest, but it is not Windows Credential Manager or DPAPI protection. Treat the Windows account and machine as part of the security boundary. The key is used to authenticate requests to Cursor; client applications instead use the local API key behavior described in [Authentication](api.md#authentication).

## Repository map

```text
apps/cli/       Windows CLI, daemon, API adapters, bridge, release scripts
apps/web/       TanStack Start documentation and marketing site
scripts/        Canonical PowerShell installer
docs/           Maintainer-facing architecture, API, and website guides
```

The install bundle is assembled by the CLI build scripts and contains `cursor-api.exe` plus the required `bridge/` runtime files. The release ZIP is published through GitHub Releases; the website installer downloads that bundle.
