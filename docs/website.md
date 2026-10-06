# Website guide

The `apps/web` workspace is the documentation and marketing website for the Windows CLI. It is a static-facing web application deployed on Cloudflare Workers; it does not host the local Composer API described on the site.

## Pages and user-facing documentation

The file-based routes currently include:

| Route | Source | Role |
| --- | --- | --- |
| `/` | `src/routes/index.tsx` | Product landing page, quick-start commands, features, and supported-client overview. |
| `/docs` | `src/routes/docs.tsx` | Detailed user guide: defaults, install/setup, client configuration, request examples, endpoint list, runtime, troubleshooting, CLI commands, storage, and credits. |

`/docs` is the canonical detailed documentation for end users. Keep its examples consistent with CLI behavior and the [local API reference](api.md). The root shell in `src/routes/__root.tsx` supplies shared metadata, header/footer, theme initialization, stylesheet, and development-only router devtools.

## Frontend structure

- **Framework:** TanStack Start and TanStack Router, React, Vite, and Tailwind CSS v4.
- **Cloudflare integration:** `@cloudflare/vite-plugin` for the SSR Vite environment; Wrangler config sets the Worker entry, compatibility date, `nodejs_compat`, observability, and custom domain.
- **Routes:** `src/routes/` contains file-based route components. `src/routeTree.gen.ts` is generated metadata; do not edit it manually.
- **Shared UI:** `src/components/` contains the site header/footer, theme control, and UI primitives.
- **Styles:** `src/styles.css` defines the shared design tokens, light/dark styling, and responsive presentation.
- **Static assets:** `public/` contains public assets such as the installer script, icons, manifest, robots file, and social preview image.

The docs page includes copy-to-clipboard controls, client setup cards, responsive side navigation, and a light/dark/system theme control. Preserve keyboard-accessible controls and responsive behavior when editing these components.

## Local development

From the repository root:

```powershell
bun install
bun run dev:web
```

The site is served at `http://localhost:3000`. From `apps/web`, available scripts include:

```powershell
bun run dev
bun run generate-routes
bun run typecheck
bun run test
bun run check
bun run build
bun run preview
```

After adding, removing, or renaming a route, run `bun run generate-routes`; do not hand-edit `src/routeTree.gen.ts`. Root Turborepo tasks handle route generation as part of configured tasks. Vitest is configured for TypeScript/TSX tests in `src/` and currently allows a run with no test files.

## Build and deploy

From the repository root:

```powershell
bun run build:web
bun run cf-typegen:web
bun run deploy:web
```

`deploy:web` builds the site and invokes `wrangler deploy`. Equivalent app-level scripts are `bun run build`, `bun run cf-typegen`, and `bun run deploy` in `apps/web`. The checked-in GitHub Actions workflows build/test the app but do not automatically deploy it to Cloudflare; deployment is explicit.

There are no app-specific runtime environment variables currently configured. Canonical URLs and the default product/API values used in page copy are maintained in route source. Review the public install asset (`apps/web/public/install.ps1`) separately from the Worker deployment process: it is the PowerShell installer served to CLI users.

## Website changes

For a user-visible website change, update the relevant route/component, run the route generator if route files changed, then run the narrowest relevant checks (at minimum `bun run typecheck` and `bun run check` from the app or root). Website versions use Changesets in the monorepo, but the web package is not published as an npm package or CLI release artifact. See the root [README](../README.md) for repository-wide release details.
