# Project documentation

Use the [online user guide](https://cursor-api-windows.mynameistito.com/docs) to install and use `cursor-api`. This folder documents how the repository and its software are put together; it complements rather than copies the client setup guide.

## Choose a guide

- [Architecture](architecture.md) — processes, request flow, configuration, and local data.
- [Local API reference](api.md) — routes, authentication, compatibility, and limitations.
- [Website guide](website.md) — website pages, frontend structure, local development, and deployment.

## Documentation ownership

The website's `/docs` route is the canonical end-user guide for install commands, supported client setup, request examples, troubleshooting, and CLI usage. Its source is `apps/web/src/routes/docs.tsx`. Update that route when user-facing defaults or procedures change, and update the relevant page here when implementation details change. Keep examples aligned with the CLI and API source; do not document private service origins or internal backend endpoints.

Repository overview and first steps live in the root [README](../README.md). Workspace-specific commands are in `apps/cli/README.md` and `apps/web/README.md`.
