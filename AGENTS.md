# Repository Instructions

- Use Conventional Commits: `<type>: <summary>`.
- Do not commit private Cursor backend origins, endpoint paths, or service names.
- Before publishing releases, verify build artifacts do not embed secrets.

## Layout

- `src/cli.ts` — Commander entrypoint (`@/` imports)
- `src/daemon.ts` — background supervisor (PID file, start/stop)
- `src/server.ts` — in-process OpenAI-compatible HTTP server
- `src/bridge.ts` — spawns bundled Node SDK bridge
- `src/api/` — shared API translation layer
- `scripts/changeset-add.ts` — non-interactive Changesets helper for agents

## Build

```powershell
bun run stage:bridge
bun run build
```

The release bundle is `dist/cursor-api/` (`cursor-api.exe` + `bridge/`).

## Releases

- Add `.changeset/*.md` files for user-facing changes.
- Agents: `bun run changeset-add <patch|minor|major> "<summary>"` (writes a changeset without prompts).
- Humans: `bun run changeset` (interactive Changesets CLI).
- Merging to `main` triggers `.github/workflows/version.yml` (Changesets version PR or tag + GitHub release).
- Pushing a `v*` tag triggers `.github/workflows/release.yml` (build zip artifact).
- `scripts/upload-release.ts` uploads release zips via the GitHub REST API (`bun run release:upload`).
- Changelog lives in `CHANGELOG.md`; release notes come from Changesets.
