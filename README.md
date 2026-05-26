# cq

A TypeScript web UI for the Claude Agent SDK. Runs on Bun with React and
communicates exclusively over WebSocket. Provides a Chat tab for live
interaction with the agent and a History tab for reviewing past sessions.
See [`prompt.md`](./prompt.md) for the full product specification and
[`docs/drafts/20260526-0037-cq-plan.md`](./docs/drafts/20260526-0037-cq-plan.md)
for the technical plan.

## Run commands

```sh
# Production: serves the pre-built static bundle from packages/web/dist
bun run start

# Development: Bun.serve with HMR enabled — edits to packages/web/src apply
# in the open browser tab without a full page reload
bun run dev
```

Both commands bind to `127.0.0.1:5173` by default. Pass `--port <N>` to
override, e.g. `bun run packages/server/src/main.ts -- --port 8080`.

## Known limitations (v1)

- **Attachment cap**: 5 MB per file, enforced by the shared Zod schema.
- **Syntax highlighting**: Shiki allow-list of 12 languages (M2 scope).
- **Background-tab heartbeat throttling**: browsers throttle `setInterval`
  for inactive tabs; the WS heartbeat compensates with `setImmediate` defer
  (M1/PR-07).
- **No authentication**: `cq` is designed for local/trusted-network use only.
  Do not expose port 5173 to the public internet.

## Status

M0 (Bring-up) closed. M1 (WebSocket spine) in progress.
