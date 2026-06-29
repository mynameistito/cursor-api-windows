# cursor-api-windows

CLI-first Windows build of a local **OpenAI-compatible API** backed by **Cursor Composer**.
No GUI — install from PowerShell, run `cursor-api` in the terminal, point any OpenAI client at
`http://127.0.0.1:6903/v1`.

|                  |                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------- |
| Docs             | [cursor-api-windows.mynameistito.com](https://cursor-api-windows.mynameistito.com)    |
| Repo             | [mynameistito/cursor-api-windows](https://github.com/mynameistito/cursor-api-windows) |
| Default base URL | `http://127.0.0.1:6903/v1`                                                            |
| Models           | `composer-2.5`, `composer-2.5-fast`                                                   |
| Stack            | TypeScript + Bun (compiled CLI) + bundled Node bridge                                 |

> **Credits:** Derived from [standardagents/composer-api](https://github.com/standardagents/composer-api) (MIT).
> See [CREDITS.md](CREDITS.md) for full attribution.

---

## Install (PowerShell)

Fresh install:

```powershell
irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex
```

Full install steps and client setup: [cursor-api-windows.mynameistito.com/docs](https://cursor-api-windows.mynameistito.com/docs).

Upgrade an existing install:

```powershell
irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex
```

From a clone of this repo:

```powershell
cd cursor-api-windows
.\scripts\install.ps1
```

---

## Quick start

```powershell
cursor-api key set
cursor-api start
cursor-api status
cursor-api health
cursor-api url
```

Point any OpenAI-compatible client at the printed URL with model `composer-2.5`.

---

## Commands

```text
cursor-api key set|status|delete
cursor-api start|stop|restart|status
cursor-api logs [-f] [-n 80]
cursor-api health
cursor-api port show|set <port>
cursor-api url
cursor-api update check          # check GitHub for new releases
cursor-api update                # download and install latest
cursor-api update --force        # reinstall current/latest bundle
cursor-api configure list
cursor-api configure agent <id>  # opencode supported in v0.1
```

`cursor-api status` also reports whether an update is available.

---

## Updates

| Method               | Command                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| From the CLI         | `cursor-api update check` then `cursor-api update`                                                      |
| PowerShell installer | `irm https://cursor-api-windows.mynameistito.com/install.ps1 \| iex`                                    |
| Manual               | Download the latest `.zip` from [Releases](https://github.com/mynameistito/cursor-api-windows/releases) |

Updates stop the background server, replace files in the install directory, and preserve your
settings in `%APPDATA%\cursor-api\`.

---

## Development

Monorepo: **Turborepo** + Bun workspaces.

| App  | Path        | README                                   |
| ---- | ----------- | ---------------------------------------- |
| CLI  | `apps/cli/` | [apps/cli/README.md](apps/cli/README.md) |
| Site | `apps/web/` | [apps/web/README.md](apps/web/README.md) |

```powershell
git clone https://github.com/mynameistito/cursor-api-windows.git
cd cursor-api-windows
bun install
bun run stage:bridge

bun run dev:cli key set
bun run dev:cli start
bun run typecheck
bun run build:cli
bun run dev:web    # TanStack site on http://localhost:3000
```

### Releases and changelog

Releases are managed with [Changesets](https://github.com/changesets/changesets):

1. Add a changeset when your PR includes user-facing CLI changes: `bun run changeset` (or `bun run changeset-add patch "summary"` for agents)
2. Merge to `main` — the **Release** workflow opens a `chore: version packages` PR when changesets are pending
3. Merge that version PR — `apps/cli/package.json` and `apps/cli/CHANGELOG.md` are updated on `main`, then the Windows zip is built and uploaded to [GitHub Releases](https://github.com/mynameistito/cursor-api-windows/releases)

Only `@cursor-api-windows/cli` is released to GitHub. `@cursor-api-windows/web` is versioned in the monorepo but not published.

This project is not published to npm (`private: true`). CLI releases are GitHub-only.

`.github/workflows/release.yml` runs changesets on Ubuntu and builds the Windows bundle on `windows-latest`. CI runs typecheck, test, lint, knip, and builds for both apps on pull requests and pushes to `main`.

---

## Where things are stored

| Item                | Location                                        |
| ------------------- | ----------------------------------------------- |
| Install             | `%LOCALAPPDATA%\Programs\cursor-api\` (default) |
| Settings            | `%APPDATA%\cursor-api\settings.json`            |
| API key (encrypted) | `%APPDATA%\cursor-api\api-key.enc`              |
| PID / state         | `%APPDATA%\cursor-api\run\`                     |
| Logs                | `%APPDATA%\cursor-api\logs\`                    |

Independent from the [API for Cursor](https://github.com/standardagents/composer-api) GUI app.

---

## Architecture

```text
cursor-api.exe (Bun-compiled CLI)
  ├─ HTTP server (in-process, src/server.ts + src/api/)
  └─ bridge/ (child process)
       node.exe + cursor-sdk-local-agent-bridge.mjs + @cursor/sdk
```

The bridge cannot be compiled into a single file (`sqlite3` native addon + Node HTTP/2).
The install bundle always includes `bridge/` next to `cursor-api.exe`.

---

## License

MIT — see [LICENSE](LICENSE). Upstream attribution in [CREDITS.md](CREDITS.md).
