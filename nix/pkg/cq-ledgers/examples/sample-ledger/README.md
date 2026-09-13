# sample-ledger

A synthetic dataset for trying the ledger UIs. Its committed `docs/` tree is a
portable Markdown dump, not a live backend. Regenerate the dump with:

```sh
bun run examples/seed-sample-ledger.ts
```

It contains a small project with a milestone dependency DAG
(`M1 → M2 → M3 → M4`, plus `M2 → M4`) and items across every canonical
ledger:

| ledger | items |
|---|---|
| milestones | 5 (M-AMBIENT + M1–M4; M4 is `blocked`) |
| tasks | 9 (done / wip / planned / blocked) |
| defects | 3 |
| hypothesis | 2 |
| questions | 2 |
| decisions | 3 |
| goals | 1 |

## Try the UIs against it

Import the dump into a fresh, isolated XDG primary first. From the Bun workspace
(`nix/pkg/cq-ledgers/`), with `cq` on PATH:

```sh
CQ_SAMPLE_ROOT=$(mktemp -d /tmp/cq-sample.XXXXXX)
export XDG_STATE_HOME="$CQ_SAMPLE_ROOT/state"
cp -R examples/sample-ledger/docs "$CQ_SAMPLE_ROOT/.cq"
printf '%s\n' '[ledger]' 'backend = "xdg"' 'backup = "in-tree"' \
  'projectId = "isolated-sample"' > "$CQ_SAMPLE_ROOT/cq.toml"
cq restore --cwd "$CQ_SAMPLE_ROOT"
```

Keep that shell for the MCP server so it retains the isolated state directory.
The UIs can run in other shells; they connect over MCP. The following source
commands also run from the Bun workspace.

### With Bun (from source)

```sh
# 1. Ledger MCP server over HTTP, pointed at the sample data:
bun run packages/ledger-mcp/src/main.ts --cwd "$CQ_SAMPLE_ROOT" --http 7777

# 2a. Terminal UI (new shell):
bun run packages/ledger-tui/src/main.tsx --url http://127.0.0.1:7777/mcp

# 2b. Browser UI (new shell), then open http://127.0.0.1:5180/ :
bun run packages/ledger-web/src/serve.ts --port 5180 --mcp-url http://127.0.0.1:7777/mcp
```

`cq web` **reverse-proxies** `/mcp` to `--mcp-url`, so the browser only
talks to the page's own origin — it never contacts the MCP server directly
(no CORS, and the MCP host need not be reachable from the browser). For a
remote browser, bind the web server on a reachable address and keep
`--mcp-url` pointed at the MCP host as seen *from the web server*:

```sh
bun run packages/ledger-web/src/serve.ts --host 0.0.0.0 --port 5180 \
  --mcp-url http://127.0.0.1:7777/mcp
# then browse to http://<web-host>:5180/
```

### With Nix

After importing as above, run the packaged server from the repository root:

```sh
nix run .#cq -- mcp --cwd "$CQ_SAMPLE_ROOT" --http 7777
nix run .#cq -- tui --url http://127.0.0.1:7777/mcp
nix run .#cq -- web --port 5180 --mcp-url http://127.0.0.1:7777/mcp
```

In the **TUI**: `↑↓`/`jk` move, `Enter` opens, `/` searches, `n` creates,
`s` sets status, `Esc` goes back, `q` quits.

In the **web** console: click a ledger in the sidebar, click an item for the
detail/edit panel, use the search box, and click **graph** (top right) for the
milestone DAG — click a node to open that milestone.

### Where to see markdown

Field values render as markdown in both UIs. The richest examples:

- **tasks → T4** ("Implement the markdown parser") — its `description` has
  bold, a bullet list, a link, a fenced code block, and a blockquote.
- **goals → G1** — `description` with a heading + numbered list.
- **defects → D1** — `description` with inline `code` and **bold**.

Open the item (web: click the row; TUI: highlight it — the right pane shows
the rendered detail) to see it formatted.

> Edits write through MCP to the isolated SQLite primary. The configured backup
> updates the temporary `.cq/` dump, never the committed sample. Use a fresh
> temporary project and import again to reset the demonstration.
