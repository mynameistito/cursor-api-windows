# Credits

**cursor-api-cli-windows** is an independent CLI-only project. It does not share
configuration or credentials with the GUI desktop apps.

## Upstream projects

### [standardagents/composer-api](https://github.com/standardagents/composer-api) (MIT)

The original **API for Cursor** project by **Standard Agents**. This CLI fork
reuses and adapts:

- `src/api/` — OpenAI-compatible request/response translation (`openai.ts`,
  `cursor.ts`, `cursor-sdk.ts`, `http.ts`, `sse.ts`, …)
- `scripts/cursor-sdk-local-agent-bridge.mjs` — local `@cursor/sdk` bridge
- The sidecar HTTP server design (`windows-app/sidecar/server.ts`)

Without that codebase, this project would not exist.

### [API for Cursor — Windows](https://github.com/standardagents/composer-api) (Tauri port)

The Windows desktop port (Tauri 2 + system tray) informed:

- Two-process architecture (HTTP server + Node SDK bridge)
- Bridge runtime constraints (Node required, not Bun; cannot be single-file compiled)
- Agent configuration shapes (OpenCode, Codex, VS Code, …)
- Default port `8787`, loopback bind `127.0.0.1`, local key literal `cursor-local`

This CLI repo is a **clean fork** — no Tauri, no WebView2, no tray UI.

### [@cursor/sdk](https://www.npmjs.com/package/@cursor/sdk)

Official Cursor SDK used by the bundled bridge to drive Composer agents.

### Cursor Composer models

Model names and capabilities (`composer-2.5`, `composer-2.5-fast`) are provided
by Cursor. This project is not affiliated with or endorsed by Cursor.

## This repository

- **Maintainer:** [mynameistito](https://github.com/mynameistito)
- **Repo:** [mynameistito/cursor-api-cli-windows](https://github.com/mynameistito/cursor-api-cli-windows)
- **License:** MIT — see [LICENSE](LICENSE)

If you use this software, please retain attribution to the upstream MIT projects
when redistributing derived work.
