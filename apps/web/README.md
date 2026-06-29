# @cursor-api-windows/web

Documentation and marketing site for [cursor-api for Windows](https://github.com/mynameistito/cursor-api-windows).

Built with [TanStack Start](https://tanstack.com/start), React, and Tailwind CSS.

## Development

From the **repository root**:

```powershell
bun install
bun run dev:web
```

Site runs at [http://localhost:3000](http://localhost:3000).

From this directory:

```powershell
bun run dev
bun run typecheck
bun run build
bun run preview
```

## Routes

File-based routes in `src/routes/`:

| Route    | File                   |
| -------- | ---------------------- |
| `/`      | `src/routes/index.tsx` |
| `/about` | `src/routes/about.tsx` |

After adding or renaming routes:

```powershell
bun run generate-routes
```

`src/routeTree.gen.ts` is generated — do not edit by hand.

## Changesets

Site changes use the web package name:

```powershell
bun run changeset-add web minor "Add download page"
```

Changelog: [CHANGELOG.md](./CHANGELOG.md). The web package is versioned in the monorepo but not published to npm or GitHub Releases.
