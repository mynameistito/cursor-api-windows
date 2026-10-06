# `@cursor-api-windows/web`

Marketing and user documentation site for [cursor-api for Windows](https://github.com/mynameistito/cursor-api-windows). The site is built with TanStack Start, React, Vite, Tailwind CSS, and Cloudflare's Vite plugin. Its `/docs` page is the detailed end-user guide; the site does not provide the local Composer API itself.

## Development

From the repository root:

```powershell
bun install
bun run dev:web
```

The site runs at [http://localhost:3000](http://localhost:3000). From this directory, use `bun run dev`, `bun run typecheck`, `bun run check`, `bun run test`, `bun run build`, or `bun run preview`.

## Routes

File-based routes are in `src/routes/`:

| Route   | File                   |
| ------- | ---------------------- |
| `/`     | `src/routes/index.tsx` |
| `/docs` | `src/routes/docs.tsx`  |

After adding, removing, or renaming a route, run `bun run generate-routes`. `src/routeTree.gen.ts` is generated; do not edit it manually.

## Build and deploy

From the repository root, `bun run build:web` builds the website, `bun run cf-typegen:web` generates Cloudflare types, and `bun run deploy:web` builds and deploys using Wrangler. Deployment is an explicit command; the checked-in GitHub Actions workflows do not deploy the website automatically.

For page scope, architecture, development, and deployment details, see the repository [website guide](../../docs/website.md). For user installation and client setup, see the [online guide](https://cursor-api-windows.mynameistito.com/docs).

## Changesets

Site changes use the web package name:

```powershell
bun run changeset-add web minor "Add a website feature"
```

The web package is versioned in the monorepo but is not published to npm or included in CLI releases. See [CHANGELOG.md](./CHANGELOG.md).
