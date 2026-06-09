# cq

One flake, two products:

1. **ledger-suite** — markdown-backed *ledgers*: an MCP server plus terminal
   and browser frontends for browsing and editing them.
2. **LLM coding-agent harness** — a portable home-manager module
   (`homeManagerModules.dev-llm`) that configures Claude Code, Codex and Pi,
   the bubblewrap `yolo` sandbox, a shared MCP registry, and the prompt/skill
   asset bundles they share.

The two are independent: consume the ledger products on their own, the harness
module on its own, or both.

## Repository layout

```
flake.nix                     # all outputs (packages, apps, devShell, module, llmAssets)
nix/
  pkg/
    cq-ledgers/               # the Bun/TypeScript ledger workspace (run `bun` here)
      packages/{ledger,ledger-live,ledger-mcp,ledger-tui,ledger-web}
      package.json bun.lock tsconfig*.json …
      examples/sample-ledger/ # ready-made dataset
    cq-assets/                # ledger's contributed LLM assets (assets.nix, commands/, agents/)
    yolo/                     # bubblewrap sandbox wrapper (+ internal llm-sandbox.sh)
    llm-skills/               # SKILL.md set + meta.yaml validation
    llm-contexts/             # general-context.md + pi-context.md
    claude-code/ codex/       # vendored agent CLIs (pinned releases)
    pi-coding-agent/ pi-extensions/
    reattach-llm/
  hm/                         # home-manager modules: dev-llm.nix, programs-pi.nix
  lib/                        # mk-agent-harness.nix (harness module factory)
docs/                         # this repo's own dogfooding ledger
```

---

# ledger-suite

A *ledger* is an ordered set of milestones; each milestone holds typed *items*
(tasks, defects, hypotheses, questions, decisions, goals, …). Everything is
stored as human-readable Markdown under a `docs/` tree, so the data is
diffable and git-friendly. Milestones form a dependency DAG via their
`dependsOn` / `blockedBy` references.

## Packages

| Package | What it is |
|---|---|
| `@cq/ledger` | The library: parser, `FsLedgerStore`, schema/registry, FTS index, and the MCP tool definitions. |
| `@cq/ledger-mcp` | Standalone MCP server exposing the 18-tool ledger surface over **stdio** or **Streamable HTTP**. |
| `@cq/ledger-tui` | Ink terminal UI — a pure MCP client. Runs against a remote `ledger-mcp --http` (`--mcp-url`) or, by default, with the MCP server **embedded in-process** (`--cwd`). |
| `@cq/ledger-web` | Browser explorer/editor + milestone **DAG view** — a pure MCP client served as a static bundle. Reverse-proxies to a remote `ledger-mcp` (`--mcp-url`) or, by default, **embeds the MCP server in-process** (`--cwd`). |

The two frontends never read the ledger files directly — they always speak the
MCP protocol. Embedded mode does not change that invariant: it merely
**co-locates** the MCP server in the frontend's own process (an in-memory
transport for the TUI; a co-hosted `/mcp` + `/ws` for the web server), so a
single command needs no separately-running server.

## Tool surface (18)

`enumerate_ledgers`, `create_ledger`, `fetch_ledger`, `fetch_ledger_archive`,
`create_item`, `fetch_item`, `update_item`, `search_items`, `fts_search`,
`create_milestone`, `update_milestone`, `fetch_milestone`,
`list_milestone_items`, `archive_milestone`, `snapshot`, `reopen_item`,
`unarchive_item`, `read_log`.

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

A ready-made dataset lives in
[`nix/pkg/cq-ledgers/examples/sample-ledger`](nix/pkg/cq-ledgers/examples/sample-ledger)
— point `--cwd` at it to explore immediately. See its README for the exact
commands.

## Storage layout

A ledger root is any directory; the store keeps state under `<root>/docs/`:

```
docs/
  ledgers.yaml            # registry: ledger name → schema
  milestones.md           # the milestones ledger
  tasks.md  defects.md  … # one file per ledger
  archive/                # archived milestone groups + items
```

---

# LLM coding-agent harness

`homeManagerModules.dev-llm` is a portable home-manager module — curried over
this flake's own `inputs` and `self` — that sets up the Claude Code / Codex /
Pi coding agents, the bubblewrap `yolo` sandbox, a shared `programs.mcp`
registry (codegraph + ledger), and the merged prompt/skill/command/agent asset
bundles. Any local-model (ollama) provider config is deliberately **left to the
consumer**.

```nix
# flake.nix
inputs.cq.url = "github:7mind/cq";

# home-manager configuration
imports = [ inputs.cq.homeManagerModules.dev-llm ];
smind.hm.dev.llm.enable = true;
```

Host/hardware facts the module cannot infer are surfaced as plain options the
consumer wires from its own system config:

| Option | Purpose |
|---|---|
| `smind.hm.dev.llm.yolo.gpu.{nvidia,amd,intel}Enable` | Expose a GPU to the `yolo` sandbox. |
| `smind.hm.dev.llm.ollamaModelsDir` | Host ollama models dir to ro-bind. |
| `smind.hm.dev.llm.podman.{socketPath,socketUri}` | Rootless-Podman socket for container access. |
| `smind.hm.dev.llm.llmSshKeyPath` | SSH key to bind into the sandbox. |
| `smind.hm.dev.llm.yolo.{extraReadOnlyPaths,extraReadWritePaths,extraPromptFragments,gpuByDefault}` | Per-host sandbox extras. |
| `smind.hm.dev.llm.{memorySections,assetBundles}` | Append memory text / asset bundles. |

Other modules can append their own `assetBundles` (same shape as
`cq.llmAssets`); the merged result is exposed read-only at
`smind.hm.dev.llm.merged.{skills,commands,agents,memoryText}` for sibling
modules to reuse.

The harness building blocks are also exposed as individual packages —
`packages.<system>.{yolo,claude-code,codex,pi-coding-agent,llm-skills,
llm-contexts,reattach-llm}` — so they can be built or consumed directly.

## How you drive it (the cq flow)

The harness gives the agent a planning loop backed by the ledger, and exposes
it through a tiny command surface — you mostly only ever type four things:
`/cq:plan`, `/cq:investigate`, `/cq:plan:follow-up`, and `/cq:advance`. The
agent does the rest; the ledger is where you and it meet.

A typical run:

1. **Stand up the sandbox.** Bring up the `yolo` bubblewrap sandbox so the
   agent runs without per-action permission prompts.
2. **Install the assets.** Bring in the MCP servers and the prompt/skill/command
   bundles — via the `homeManagerModules.dev-llm` module this is one import; that
   is what makes the `/cq:*` commands and the `ledger` MCP server available.
3. **Kick off the work.** Start the agent and give it one of:
   - `/cq:plan <task description>` — start planning a new piece of work, or
   - `/cq:investigate <defect description>` — start root-causing a defect.
4. **Answer its questions.** The agent stops and files clarifying questions into
   the ledger. Open a frontend (`ledger-web` or `ledger-tui`) and answer them
   there — your answers feed straight back into the plan.
5. **Refine the plan (optional, repeatable).** Use
   `/cq:plan:follow-up <goal id> <additional scope>` to extend or adjust the
   plan, then answer the next round of questions. Repeat steps 4–5 until you are
   satisfied with the plan.
6. **Let it run.** `/cq:advance` drives the whole flow — investigate → plan →
   implement — autonomously, pausing only when it needs something from you
   (an unanswered question or a user action). Re-run it after you unblock it.

---

## Development (ledger workspace)

The Bun workspace lives under `nix/pkg/cq-ledgers/`:

```sh
nix develop                  # bun + node + toolchain (from repo root)
cd nix/pkg/cq-ledgers
bun install
bun test                     # full suite
bun run typecheck            # tsc -b
bun run lint                 # eslint
bun run check                # all three
```

### Nix

`packages.node-modules` is a fixed-output derivation that fetches all npm
dependencies. After changing dependencies (and `bun.lock`), refresh its
`outputHash` in `flake.nix`: set it to `sha256-AAAA…` (52 `A`s), run
`nix build .#node-modules`, and paste the `got:` hash back.

Outputs:
- `packages.{ledger-mcp,ledger-tui,ledger-web,node-modules}` +
  `apps.{default,ledger-mcp,ledger-tui,ledger-web}` (default is `ledger-mcp`).
- `packages.{yolo,claude-code,codex,pi-coding-agent,llm-skills,llm-contexts,llm-context-with-env,reattach-llm}` — harness building blocks.
- `homeManagerModules.dev-llm` — the coding-agent harness module.
- `llmAssets` — the ledger's system-agnostic prompt/skill asset bundle.
