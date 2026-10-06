# cursor-api for Windows

`cursor-api` is a Windows CLI and local daemon that exposes Cursor Composer through OpenAI-compatible and Anthropic-compatible HTTP APIs. Run coding-agent clients against your own machine at `http://127.0.0.1:6903`; this project is not a hosted API service.

|  |  |
| --- | --- |
| User guide | [cursor-api-windows.mynameistito.com/docs](https://cursor-api-windows.mynameistito.com/docs) |
| Website | [cursor-api-windows.mynameistito.com](https://cursor-api-windows.mynameistito.com) |
| Releases | [GitHub Releases](https://github.com/mynameistito/cursor-api-windows/releases) |
| Default OpenAI base URL | `http://127.0.0.1:6903/v1` |
| Default models | `composer-2.5`, `composer-2.5-fast` |
| Platform | Windows x64 |

## Install and start

In PowerShell, install the latest release and save your Cursor API key:

```powershell
irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex
cursor-api key set
cursor-api start
cursor-api health
cursor-api url
```

Configure a client with the URL printed by `cursor-api url`, a model above, and `cursor-local` as the local API key when the client requires one. The local daemon binds to loopback (`127.0.0.1`); the client API key value is not your Cursor API key. For client-specific steps, request examples, troubleshooting, and the complete CLI reference, see the [online guide](https://cursor-api-windows.mynameistito.com/docs).

## CLI commands

```text
cursor-api key set [--key <key>] | key status | key delete
cursor-api start | stop | restart | status
cursor-api health
cursor-api logs [-f|--follow] [-n|--lines <count>]
cursor-api port show | port set <port>
cursor-api url
cursor-api configure list | configure agent <id>
cursor-api update check | update [--force]
```

`cursor-api configure agent opencode` is the implemented agent configurator. Other listed agent IDs are not currently wired up. `cursor-api status` also checks for a release update when GitHub is reachable.

## Documentation

- [Online user guide](https://cursor-api-windows.mynameistito.com/docs) — installation, client configuration, API examples, troubleshooting, and CLI commands.
- [Documentation index](docs/README.md) — how repository and site documentation fit together.
- [Architecture](docs/architecture.md) — CLI, daemon, bridge, and request flow.
- [Local API reference](docs/api.md) — endpoints, authentication, compatibility notes, and known limits.
- [Website guide](docs/website.md) — pages, frontend architecture, development, build, and deployment.
- [CLI package README](apps/cli/README.md) and [website package README](apps/web/README.md) — workspace-specific details.

## Development

The repository is a Turborepo monorepo using Bun workspaces. Prerequisites are Bun `>=1.2.0` (the repo pins Bun `1.3.14`) and Node.js `>=22`.

```powershell
git clone https://github.com/mynameistito/cursor-api-windows.git
cd cursor-api-windows
bun install
bun run dev:web       # Website at http://localhost:3000
bun run typecheck
bun run test
bun run check
bun run build         # Build all workspaces
```

Useful app-specific commands:

```powershell
bun run stage:bridge
bun run dev:cli       # Run the CLI in development
bun run build:cli     # Build the Windows CLI bundle
bun run dev:web       # Run the website
bun run build:web     # Build the website
bun run deploy:web    # Build and deploy the website using Wrangler
```

See [docs/website.md](docs/website.md) for route generation and website-specific checks. The web app has no automatic Cloudflare deployment workflow in the checked-in GitHub Actions configuration; `deploy:web` is an explicit deployment command.

## Releases

CLI releases are Windows bundles published to [GitHub Releases](https://github.com/mynameistito/cursor-api-windows/releases); the packages are private and are not published to npm. User-facing changes use Changesets. From the repository root, add a CLI changeset with:

```powershell
bun run changeset-add patch "Describe the user-facing change"
```

Merging pending changesets to `main` opens a version PR. Once that PR is merged, the release workflow builds and publishes the CLI bundle. The web workspace is versioned in the monorepo but is not published as a package.

## Local data

| Data                     | Default location                      |
| ------------------------ | ------------------------------------- |
| Program                  | `%LOCALAPPDATA%\Programs\cursor-api\` |
| Settings                 | `%APPDATA%\cursor-api\settings.json`  |
| Encrypted Cursor API key | `%APPDATA%\cursor-api\api-key.enc`    |
| Daemon state             | `%APPDATA%\cursor-api\run\`           |
| Logs                     | `%APPDATA%\cursor-api\logs\`          |

The key is encrypted at rest by the CLI. See [Architecture](docs/architecture.md#configuration-and-local-data) for implementation details and [the API reference](docs/api.md#authentication) for the distinction between the stored Cursor key and local client authentication.

## Credits and license

This project is derived from [standardagents/composer-api](https://github.com/standardagents/composer-api) (MIT). See [CREDITS.md](CREDITS.md) for attribution. Licensed under MIT; see [LICENSE](LICENSE).
