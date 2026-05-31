# ledger-suite

Markdown-backed **ledgers** — an MCP server plus terminal and browser
frontends for browsing and editing them.

A *ledger* is an ordered set of milestones; each milestone holds typed *items*
(tasks, defects, hypotheses, questions, decisions, goals, …). Everything is
stored as human-readable Markdown under a `docs/` tree, so the data is
diffable and git-friendly. Milestones form a dependency DAG via their
`dependsOn` / `blockedBy` references.

## Packages

| Package | What it is |
|---|---|
| `@cq/ledger` | The library: parser, `FsLedgerStore`, schema/registry, FTS index, and the MCP tool definitions. |
| `@cq/ledger-mcp` | Standalone MCP server exposing the 14-tool ledger surface over **stdio** or **Streamable HTTP**. |
| `@cq/ledger-tui` | Ink terminal UI — a pure MCP client over HTTP. |
| `@cq/ledger-web` | Browser explorer/editor + milestone **DAG view** — a pure MCP client over HTTP; served as a static bundle. |

The two frontends never touch the ledger files directly; they talk to a
running `ledger-mcp` over the MCP protocol.

## Tool surface (14)

`enumerate_ledgers`, `create_ledger`, `fetch_ledger`, `fetch_ledger_archive`,
`create_item`, `fetch_item`, `update_item`, `search_items`, `fts_search`,
`create_milestone`, `update_milestone`, `fetch_milestone`,
`list_milestone_items`, `archive_milestone`.

## Quick start (Nix)

```sh
# 1. Start the MCP server over HTTP against a ledger root (its docs/ tree).
nix run .#ledger-mcp -- --cwd /abs/path/to/ledger-root --http 7777

# 2a. Terminal UI:
nix run .#ledger-tui -- --url http://127.0.0.1:7777/mcp

# 2b. Browser UI (serves a static bundle; open the printed URL):
nix run .#ledger-web -- --port 5180 --mcp-url http://127.0.0.1:7777/mcp
```

`ledger-mcp` also speaks **stdio** for clients that spawn it as a child
(Claude Code, Codex, …): `ledger-mcp --cwd /abs/path` (no `--http`).

A ready-made dataset lives in [`examples/sample-ledger`](examples/sample-ledger)
— point `--cwd` at it to explore immediately. See its README for the exact
commands.

## Development

```sh
nix develop          # bun + node + toolchain
bun install
bun test             # full suite
bun run typecheck    # tsc -b
bun run lint         # eslint
bun run check        # all three
```

### Nix

`packages.node-modules` is a fixed-output derivation that fetches all npm
dependencies. After changing dependencies (and `bun.lock`), refresh its
`outputHash` in `flake.nix`: set it to `sha256-AAAA…` (52 `A`s), run
`nix build .#node-modules`, and paste the `got:` hash back.

Outputs: `packages.{ledger-mcp,ledger-tui,ledger-web,node-modules}`,
`apps.{default,ledger-mcp,ledger-tui,ledger-web}` (default is `ledger-mcp`).

## Storage layout

A ledger root is any directory; the store keeps state under `<root>/docs/`:

```
docs/
  ledgers.yaml            # registry: ledger name → schema
  milestones.md           # the milestones ledger
  tasks.md  defects.md  … # one file per ledger
  archive/                # archived milestone groups + items
```
