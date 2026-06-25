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

## Build

```powershell
bun run stage:bridge
bun run build
```

The release bundle is `dist/cursor-api/` (`cursor-api.exe` + `bridge/`).
