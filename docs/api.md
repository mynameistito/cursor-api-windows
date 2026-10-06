# Local API reference

The CLI exposes a local HTTP API for clients that can use OpenAI-compatible or Anthropic-compatible endpoints. The default OpenAI base URL is `http://127.0.0.1:6903/v1`. Use `cursor-api url` to print the configured URL after changing the port.

This is a compatibility layer for Cursor Composer, not a complete implementation of either upstream API specification. For install and client setup examples, see the [online guide](https://cursor-api-windows.mynameistito.com/docs).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Local health check. |
| `GET` | `/v1/models` | List the Composer models exposed by the server. |
| `GET` | `/v1/models/{id}` | Retrieve model information. |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions-compatible request; supports streamed output. |
| `POST` | `/v1/responses` | OpenAI Responses-compatible request; supports streamed output. |
| `GET`, `HEAD`, `DELETE` | `/v1/responses/{id}` | Best-effort operations on a response created by this server process. |
| `POST` | `/v1/messages` | Anthropic Messages-compatible request; supports streamed output. |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible token-count estimate. |

The Anthropic adapter currently maps requested model names to `composer-2.5`. The two primary model names exposed for OpenAI-compatible clients are `composer-2.5` and `composer-2.5-fast`.

## Authentication

The server accepts a local request key in either `x-api-key` or `Authorization: Bearer <key>`. Agent clients commonly use the literal `cursor-local` as a placeholder; when passed by the managed daemon, this resolves to the saved Cursor API key. A non-placeholder key is treated as the supplied key. Configure your client according to its API format and do not send the Cursor API key to untrusted local programs.

The Cursor API key itself is saved with `cursor-api key set` and encrypted at rest in `%APPDATA%\cursor-api\api-key.enc`. The local listener binds to `127.0.0.1`, not all network interfaces.

## Compatibility and limitations

- This project implements selected endpoints and fields rather than full OpenAI or Anthropic API parity. Unsupported or invalid request options return an error.
- OpenAI Chat Completions rejects `n` values other than `1`, logprobs, non-text output modalities, and audio output. Legacy function-calling fields are not supported; use the supported tools format.
- Background Responses requests are not supported. Response retrieval/deletion uses a best-effort in-memory store with a limit of 512 entries and does not survive daemon restarts.
- Anthropic model names are currently ignored and mapped to `composer-2.5`. Token counts are estimates based on character counts (approximately one token per four characters), not Cursor-reported usage.
- Unsupported image sources may be replaced with text. Image URLs must use HTTP or HTTPS, and individual Cursor images are limited to 1 MiB.
- HTTP request bodies are limited to 25 MiB.
- SDK sessions/tool calls are best-effort; session cache entries expire after six hours. Do not rely on persistent conversation history across restarts.
- If the SDK bridge does not start, the server may use a direct fallback path with different capabilities.

These constraints are implementation details and may change. Verify current adapter behavior in `apps/cli/src/server.ts`, `apps/cli/src/api/openai.ts`, and `apps/cli/src/anthropic.ts` when changing API support.
