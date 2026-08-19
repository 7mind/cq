# Whole-store `cq web` (G96)

`cq web --backend=xdg` serves every readable project under the local XDG store
with the existing project switcher. It is independent of `cq serve` (Postgres /
bearer auth / T733 remote cutover).

## Operating contract

- Discovery is read-only. Identity backfill is bounded to known checkouts.
- Project runtimes stay dormant until the first `/p/<key>/(mcp|ws)` request.
- Unsafe or malformed project keys are rejected before filesystem lookup.
- Freshness uses a shared PRAGMA `data_version` watcher lease per active
  project: first WebSocket acquire starts one watcher; last close/switch/stop
  releases it. Not `fs.watch` / inotify / WAL mtimes.

## G81 boundary

PostgreSQL hub watchers, `cq serve` auth, and TUI launch are unchanged.
`backend=remote` remains G81's path. This host is local XDG only.
