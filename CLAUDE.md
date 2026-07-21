# ledger-suite — project instructions

Markdown-backed ledgers: an MCP server (`@cq/ledger-mcp`) plus a terminal
(`@cq/ledger-tui`) and web (`@cq/ledger-web`) client, over the `@cq/ledger`
library. Bun + TypeScript workspace; products are packaged with Nix.

The Bun workspace lives under `nix/pkg/cq-ledgers/` (run the `bun` commands
below from there); the contributed LLM assets live under `nix/pkg/cq-assets/`.
The repo root holds only the flake plus the migrated coding-agent harness
under `nix/` (see `nix/hm/dev-llm.nix`, `nix/pkg/{yolo,codex,claude-code,…}`).

## Build / test / check

- `bun test` — full suite (run from `nix/pkg/cq-ledgers/`).
- `bun run typecheck` (`tsc -b`) and `bun run lint` (`eslint .`).
- `bun run check` — all three. Run it before declaring work done.
- Nix products (from the repo root): `nix build .#cq`.
- After changing dependencies / `bun.lock`: refresh the FOD hash in
  `flake.nix` — set `outputHash` to 52 `A`s, `nix build .#node-modules`, paste
  the `got:` hash back.

## Conventions (this repo)

- Surgical changes; match surrounding style; no unrelated refactors.
- Reproduce a defect (failing test or documented repro) before fixing it.
- Frontends are pure MCP clients — they never read the ledger files directly.
  This holds in *embedded* mode too (TUI/web with no `--mcp-url`): the frontend
  co-locates the MCP server in its own process (in-memory transport for the TUI,
  co-hosted `/mcp` + `/ws` for the web) and still talks to it over MCP — it does
  not read the ledger store directly.
- `--cwd` for `cq mcp` must be absolute (or relative, resolved vs CWD);
  it defaults to the process CWD.
- Tests: `ink-testing-library` for the TUI, happy-dom for the web; controlled
  *text* inputs don't fire onChange under happy-dom, so use uncontrolled
  inputs (refs) — selects are fine controlled.

## Track work in the ledger (dogfooding)

This repo is wired (`.mcp.json`) to its own ledger via the `ledger` MCP server.
Use it — the `mcp__ledger__*` tools — as the source of truth for multi-step
work, instead of inline TODOs or scratch files.

- **Before starting**: `fts_search` (or `fetch_ledger`) for the topic; if an
  item already exists, work against it — don't duplicate.
- **Starting multi-step work**: `create_milestone`, then `create_item` under it
  in the right ledger:
  - `tasks` — units of work (status: planned → wip → done)
  - `defects` — bugs (severity required; open → wip → resolved)
  - `hypothesis` — things to confirm; `decisions` — locked choices;
    `questions` — open questions for the user.
  - `researches` — research questions (question required; open → wip → {concluded | inconclusive | abandoned}; idPrefix RS).
- **While working**: keep `update_item` status current; record a non-obvious
  choice as a `decisions` item and a bug as a `defects` item.
- **Dependencies**: express milestone ordering via `dependsOn` / `blockedBy`
  (advisory); same fields exist on items for cross-references. The `dependsOn`/`blockedBy`
  fields now accept the `<ledger>:<id>` grammar (e.g., `tasks:T523`, `researches:RS42`) as
  canonical form; bare ids (e.g., `T523`, `RS42`) are accepted as input shorthand and
  canonicalized on write. Cross-ledger gating is real: a task blocked on a research is
  unready until that research is `concluded`. Dangling refs are rejected only for a
  NEWLY-ADDED entry that canonicalizes to a known ledger whose target id does not exist
  (`DanglingRefError`); an unknown ledger name or unregistered alpha prefix passes
  through verbatim as advisory free-text, and pre-existing entries always survive
  verbatim. The `ledgerRefs` field enables hypothesis reuse: a `researches:<RS>` ref
  surfaces its findings across items.
- **On completion**: set items terminal, then `archive_milestone` once every
  item under the milestone is terminal.
- **Detail goes in fields** (markdown is supported), not the headline. Don't
  hand-edit the store (the out-of-tree bun:sqlite `ledger.db`) — go through the
  tools so counters/schema stay valid.
- **Provenance**: on every `create_item` / `update_item`, pass `author` (your
  model class, e.g. `opus-4.8[1m]`) and `session` (`$CLAUDE_CODE_SESSION_ID`)
  so the ledger records who wrote each item.
- Don't `create_ledger` unless asked; the canonical set is enough.

### Flows and research-driven investigation

The ledger-suite harness runs four cooperating **flows**: *investigate*, *plan*, *research*,
and *implement*, chained by the `/cq:advance` sequencer (which runs them to quiescence).
Plan-flow owns a defect-to-fix path; investigate-flow roots causes; research-flow answers
empirical research questions; implement-flow executes task DAGs. Each flow is driven by
`/cq:*:advance` and dispatches domain-specific subagents. `/cq:research` +
`/cq:research:advance` drive a `researches` item over a hypothesis tree of candidate
answers using two subagent roles: the read-only `research-explorer` (evidence gathering)
and the execution-capable `research-experimenter` (runs probes on a `probeRequest`). On a
confirmed answer the command writes the research's `findings`/`conclusion`/`recommendation`
fields (pure narrative, in-ledger) and — per Q269's no-working-tree-write discipline —
routes the FULL cited synthesis as a SEPARATE markdown artifact through `cq log put` to
`.cq/logs/<ts>-research-<RS>.md`, recorded in the item's `sessionLogs`. A research that
concludes (`concluded` status) gates its dependent tasks via the satisfies-dependency rule
(only `concluded` satisfies a `researches:RS` dependency).

The question-vs-research triage rule (Q267): triage each unknown by WHO can answer it. An
EMPIRICALLY answerable unknown (verifiable by experiment — benchmarks, API behavior,
feasibility) becomes a `researches` item, NOT a user question; a PREFERENCE or requirements
decision only the user can make stays a `questions` item.

### Session and raw-log artifacts

Ledger workflows (plan, investigate, implement, research) capture raw subagent transcripts
as log artifacts in the out-of-tree `xdg` primary store:

- **Artifact formats**: Claude native Agent subagents (plan/investigate/implement)
  write strict JSONL (`logs/raw/<timestamp>-<id>.jsonl`); pi shellout subagents
  (`pi:*`) write verbatim stdout as markdown (`logs/raw/<timestamp>-pi-<alias>.md`).
- **Write path**: ALL logs route through `cq log put` (never a direct `Write`).
  The CLI handles redaction (best-effort / lossy per Q223) + strict JSONL
  validation, then writes into the primary's out-of-tree logs area —
  `$XDG_STATE_HOME/cq/projects/<projectKey>/logs/` per the xdg layout (read back
  via the `read_log` MCP capability).
- **Not committed to git by default (G67)**: under the `xdg` backend the logs
  live out of tree, NOT in the working tree — nothing is committed to git unless
  the optional human-readable backup is enabled (`[ledger].backup = "in-tree"` or
  `"orphan-branch"`; default `"none"`), which `cq backup` / the debounced
  exporter mirror into a `.cq/`-layout dump (logs included) that `cq restore`
  can re-import. THIS repo runs `backup = "none"` (decision K109): logs are
  out-of-tree only. There is no retention policy — they live indefinitely as
  out-of-tree files.
- **Viewing**: raw JSONL logs are viewable in the web UI's conversation viewer
  (structured, collapsible turns) via the paired raw-log toggle. Markdown logs
  render as plain text in the summary view.

> The server also advertises baseline usage `instructions` on connect — this
> section is the repo-specific policy on top of that.
