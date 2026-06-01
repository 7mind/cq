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
| `@cq/ledger-tui` | Ink terminal UI — a pure MCP client. Runs against a remote `ledger-mcp --http` (`--mcp-url`) or, by default, with the MCP server **embedded in-process** (`--cwd`). |
| `@cq/ledger-web` | Browser explorer/editor + milestone **DAG view** — a pure MCP client served as a static bundle. Reverse-proxies to a remote `ledger-mcp` (`--mcp-url`) or, by default, **embeds the MCP server in-process** (`--cwd`). |

The two frontends never read the ledger files directly — they always speak the
MCP protocol. Embedded mode does not change that invariant: it merely
**co-locates** the MCP server in the frontend's own process (an in-memory
transport for the TUI; a co-hosted `/mcp` + `/ws` for the web server), so a
single command needs no separately-running server.

## Tool surface (14)

`enumerate_ledgers`, `create_ledger`, `fetch_ledger`, `fetch_ledger_archive`,
`create_item`, `fetch_item`, `update_item`, `search_items`, `fts_search`,
`create_milestone`, `update_milestone`, `fetch_milestone`,
`list_milestone_items`, `archive_milestone`.

## Quick start (Nix)

**Embedded (one command, no separate server)** — the frontend runs the MCP
server in-process against a ledger root (its `docs/` tree):

```sh
# Terminal UI, embedded:
nix run .#ledger-tui -- --cwd /abs/path/to/ledger-root

# Browser UI, embedded (serves a static bundle; open the printed URL):
nix run .#ledger-web -- --cwd /abs/path/to/ledger-root --port 5180
```

The embedded root resolves as `--cwd` > `$LEDGER_ROOT` > the process CWD.

**Remote (shared server)** — run one `ledger-mcp --http` and point the
frontends at it (e.g. several UIs against one ledger, or a remote host):

```sh
# 1. Start the MCP server over HTTP against a ledger root.
nix run .#ledger-mcp -- --cwd /abs/path/to/ledger-root --http 7777

# 2a. Terminal UI:
nix run .#ledger-tui -- --mcp-url http://127.0.0.1:7777/mcp

# 2b. Browser UI:
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
