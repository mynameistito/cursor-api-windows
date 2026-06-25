---
"cursor-api-cli-windows": patch
---

Fix chat completions ignoring the SDK bridge when the daemon starts the bridge after module import. Read bridge env vars at request time so OpenCode and other clients route through the bridge instead of the unconfigured direct Cursor backend path.
