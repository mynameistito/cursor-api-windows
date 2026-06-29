# cursor-api-cli-windows

## 0.1.11

### Patch Changes

- 6c5b43e: Improve installer update guidance and stop warnings

## 0.1.10

### Patch Changes

- 782e027: Restructure the repository into a Turborepo monorepo with Bun workspaces. Move the Windows CLI to `apps/cli`, add a TanStack Start documentation site at `apps/web`, and update CI, Changesets, and release tooling for multi-package versioning.

> Release history below covers the CLI package. From 0.1.10 onward the CLI lives in `apps/cli/` inside a Turborepo monorepo.

## 0.1.9

### Patch Changes

- f688a15: Fix bridge startup crash and return terminal after cursor-api start

## 0.1.8

### Patch Changes

- d194c1f: Use Bun to install the bridge runtime
- bcafbcc: Change default port from 8787 to 6903
- 297e2c0: Run CI build on Windows and parallelize checks
- bdeb192: Patch vulnerable transitive dependencies
- a3cb140: Support OpenCode opencode.jsonc config files

## 0.1.7

### Patch Changes

- 73fe418: Restart daemon on start when API key changes
- e2416cc: Fix self-update when cursor-api.exe is in use by the updater process
- 4013901: Fix stale daemon status when PID is no longer running

## 0.1.6

### Patch Changes

- 6629b6d: Single-job release workflow with immutable GitHub releases via changesets/action
- 1310777: Run changesets on Ubuntu to avoid Windows credential file leaks in release CI
- 118ff51: Restart daemon on start when port changes and return immediately after spawning

## 0.1.5

### Patch Changes

- 176810d: Remove deprecated baseUrl from tsconfig for TypeScript 6, one-shot release workflow, and switch typecheck to @typescript/native-preview (tsgo)

## 0.1.4

### Patch Changes

- Rebuild release after dependency bumps (commander 15, TypeScript 6, knip 6)
- Fix release workflow to tag and build only when no pending changesets remain
- Fix TypeScript 6 typecheck failure by silencing baseUrl deprecation until paths migration

## 0.1.3

### Patch Changes

- ed70891: Fix GitHub release upload make_latest API parameter type
- b36b1fb: Fix release workflow so version PR merges tag and build Windows artifacts in one run

## 0.1.2

### Patch Changes

- d81cc96: Fix chat completions ignoring the SDK bridge when the daemon starts the bridge after module import. Read bridge env vars at request time so OpenCode and other clients route through the bridge instead of the unconfigured direct Cursor backend path.

## 0.1.1

### Patch Changes

- 2cc294c: Add knip checks and remove unused Worker-era API code

## 0.1.0

### Initial release

- Windows CLI for a local OpenAI-compatible Cursor API backed by Cursor Composer
- Background daemon, encrypted API key storage, and OpenAI-compatible HTTP server
- GitHub release artifacts (`cursor-api-*-win-x64.zip`) and `cursor-api update`
