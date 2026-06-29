# Changesets

This monorepo uses [Changesets](https://github.com/changesets/changesets) at the repository root.

| Package                   | Path        | Changelog               | Released                       |
| ------------------------- | ----------- | ----------------------- | ------------------------------ |
| `@cursor-api-windows/cli` | `apps/cli/` | `apps/cli/CHANGELOG.md` | GitHub Releases (Windows zip)  |
| `@cursor-api-windows/web` | `apps/web/` | `apps/web/CHANGELOG.md` | Not published (versioned only) |

```bash
bun run changeset                              # interactive
bun run changeset-add patch "CLI fix"          # @cursor-api-windows/cli (default)
bun run changeset-add web minor "New docs page" # @cursor-api-windows/web
bun run changeset-add both patch "Shared infra" # both packages, same bump
```
