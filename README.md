# cursor-api-cli-windows

CLI-first Windows build of a local **OpenAI-compatible API** backed by **Cursor Composer**.
No GUI — install from PowerShell, run `cursor-api` in the terminal, point any OpenAI client at
`http://127.0.0.1:8787/v1`.

|                  |                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Repo             | [mynameistito/cursor-api-cli-windows](https://github.com/mynameistito/cursor-api-cli-windows) |
| Default base URL | `http://127.0.0.1:8787/v1`                                                                    |
| Models           | `composer-2.5`, `composer-2.5-fast`                                                           |
| Stack            | TypeScript + Bun (compiled CLI) + bundled Node bridge                                         |

> **Credits:** Derived from [standardagents/composer-api](https://github.com/standardagents/composer-api) (MIT).
> See [CREDITS.md](CREDITS.md) for full attribution.

---

## Install (PowerShell)

One-liner (downloads the latest GitHub release, adds to user PATH):

```powershell
irm https://raw.githubusercontent.com/mynameistito/cursor-api-cli-windows/main/scripts/install.ps1 | iex
```

Upgrade an existing install:

```powershell
$env:CURSOR_API_INSTALL_UPDATE = "1"
irm https://raw.githubusercontent.com/mynameistito/cursor-api-cli-windows/main/scripts/install.ps1 | iex
```

Or download and run:

```powershell
.\scripts\install.ps1 -Update
```

```powershell
git clone https://github.com/mynameistito/cursor-api-cli-windows.git
cd cursor-api-cli-windows
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

| Method               | Command                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| From the CLI         | `cursor-api update check` then `cursor-api update`                                                          |
| PowerShell installer | `irm …/install.ps1 \| iex -Update`                                                                          |
| Manual               | Download the latest `.zip` from [Releases](https://github.com/mynameistito/cursor-api-cli-windows/releases) |

Updates stop the background server, replace files in the install directory, and preserve your
settings in `%APPDATA%\cursor-api\`.

---

## Development

```powershell
git clone https://github.com/mynameistito/cursor-api-cli-windows.git
cd cursor-api-cli-windows
bun install
bun run stage:bridge

bun run dev key set
bun run dev start
bun run typecheck
bun run build
```

### Releases and changelog

Releases are managed with [Changesets](https://github.com/changesets/changesets):

1. Add a changeset when your PR includes user-facing changes: `bun run changeset` (or `bun run changeset-add patch "summary"` for agents)
2. Merge to `main` — the **Release** workflow opens a `chore: version packages` PR when changesets are pending
3. Merge that version PR — `package.json` and `CHANGELOG.md` are updated on `main`, then the Windows zip is built and uploaded to [GitHub Releases](https://github.com/mynameistito/cursor-api-cli-windows/releases)

This project is not published to npm (`private: true`). Releases are GitHub-only.

`.github/workflows/release.yml` runs changesets on Ubuntu and builds the Windows bundle on `windows-latest`. CI runs typecheck, lint, and knip on pull requests and pushes to `main`.

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
