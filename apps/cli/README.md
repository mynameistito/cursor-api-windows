# @cursor-api-windows/cli

Windows CLI for a local **OpenAI-compatible API** backed by Cursor Composer.

Install and usage docs live in the [repository README](../../README.md).

## Layout

| Path            | Purpose                                                         |
| --------------- | --------------------------------------------------------------- |
| `src/cli.ts`    | Commander entrypoint                                            |
| `src/daemon.ts` | Background supervisor (PID file, start/stop)                    |
| `src/server.ts` | In-process OpenAI-compatible HTTP server                        |
| `src/bridge.ts` | Spawns bundled Node SDK bridge                                  |
| `src/api/`      | Request/response translation layer                              |
| `bridge/`       | Bundled `@cursor/sdk` runtime (`node.exe` staged at build time) |
| `scripts/`      | Build, release, and install helpers                             |

## Development

From the **repository root**:

```powershell
bun install
bun run stage:bridge
bun run dev:cli key set
bun run dev:cli start
```

From this directory:

```powershell
bun run dev
bun run typecheck
bun run test
bun run check
bun run knip
bun run build
```

## Build output

```powershell
bun run build
# => dist/cursor-api/cursor-api.exe + dist/cursor-api/bridge/
```

## Changesets

User-facing CLI changes need a changeset at the repo root:

```powershell
bun run changeset-add patch "Describe the user-facing change"
```

Changelog: [CHANGELOG.md](./CHANGELOG.md)
