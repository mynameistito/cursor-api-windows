# Repository Instructions

- Use Conventional Commits: `<type>: <summary>`.
- Do not commit private Cursor backend origins, endpoint paths, or service names.
- Before publishing releases, verify build artifacts do not embed secrets.

## Layout

Monorepo managed with **Turborepo** and **Bun workspaces**.

```
apps/
  cli/          — Windows CLI (`@cursor-api-windows/cli`)
  web/          — TanStack Start docs/marketing site (`@cursor-api-windows/web`)
packages/       — shared libraries (future)
```

### CLI (`apps/cli`)

- `src/cli.ts` — Commander entrypoint (`@/` imports)
- `src/daemon.ts` — background supervisor (PID file, start/stop)
- `src/server.ts` — in-process OpenAI-compatible HTTP server
- `src/bridge.ts` — spawns bundled Node SDK bridge
- `src/api/` — shared API translation layer
- `scripts/changeset-add.ts` — non-interactive Changesets helper for agents
- `../../scripts/install.ps1` — canonical Windows installer (bundled into releases; used by `irm … | iex`)

### Web (`apps/web`)

- TanStack Start + React + Tailwind
- `src/routes/` — file-based routes
- `bun run generate-routes` — regenerate `src/routeTree.gen.ts` after route changes

## Build

```powershell
bun install
bun run build:cli
# or everything:
bun run build
```

The CLI release bundle is `apps/cli/dist/cursor-api/` (`cursor-api.exe` + `bridge/`).

## Dev

```powershell
bun run dev:cli    # CLI
bun run dev:web    # site on http://localhost:3000
```

## Releases

- Add `.changeset/*.md` files for user-facing changes (CLI and/or web).
- Agents:
  - CLI: `bun run changeset-add patch "summary"`
  - Web: `bun run changeset-add web minor "summary"`
  - Both: `bun run changeset-add both patch "summary"`
- Humans: `bun run changeset` (interactive Changesets CLI).
- Merging to `main` triggers `.github/workflows/release.yml`: if pending changesets exist, the **Version packages** job opens a `chore: version packages` PR via `changesets/action`.
- Merging that version PR bumps package versions and updates per-app changelogs (`apps/cli/CHANGELOG.md`, `apps/web/CHANGELOG.md`), then pushes to `main`; the **Build Windows release** job runs `bun run ci:release` to publish the CLI GitHub release zip (`@cursor-api-windows/web` is versioned only).
- If no changesets are pending, the publish job may still run to ship an untagged version when needed.
- `apps/cli/scripts/release.ts` — release CLI (`tag`, `zip`, `upload`) for CI and local builds
- Changelog lives in `apps/cli/CHANGELOG.md`; release notes come from Changesets.
- Run `bun run knip` to check for unused exports and dependencies in the CLI.
