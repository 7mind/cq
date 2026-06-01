---
ledger: decisions
counters:
  milestone: 0
  item: 5
archives: []
---

# decisions

## M3

### K1 — locked

- createdAt: 2026-06-01T20:13:09.941Z
- updatedAt: 2026-06-01T20:13:09.941Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- headline: "Subagent session-logs: subagent returns summary, orchestrator writes the file"
- rationale: Subagents' final message is returned to the orchestrator, so the subagent emits a 'Session summary' section (did/achieved/discovered/issues) and the orchestrator writes ./docs/logs/<timestamp>-<agent-id>.md (agent-id from the Agent tool result, timestamp stamped by the orchestrator). Keeps subagents read-only (no Write tool; the T13 denylist stays), avoids the worktree-log-merge problem (a worker writing inside its isolated worktree), and is concurrency-safe with a single writer and unique filenames.
- alternatives: "(a) Grant each subagent Write scoped to ./docs/logs/ and have it write its own log — rejected: re-introduces Write into read-only agents and needs worker logs carried across merge-back. User chose the orchestrator-writes approach."
- ledgerRefs: ["goals:G1"]

### K4 — locked

- createdAt: 2026-06-01T20:23:03.105Z
- updatedAt: 2026-06-01T20:23:03.105Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: Cross-tool model-tier vocabulary, per-host resolution, and dual worktree strategy
- rationale: |
    Foundational conventions every /implement:* asset depends on (T4).
    
    === 1. PORTABLE MODEL-TIER VOCABULARY ===
    Tasks carry a host-agnostic tier label in `tasks.suggestedModel` (schema field already exists). Three tiers ONLY:
      - `frontier` — most capable / highest reasoning. Design, architecture, ambiguous or high-blast-radius work.
      - `standard` — mid tier. Ordinary implementation, mechanical-but-nontrivial edits.
      - `fast`     — cheap / quick. Trivial mechanical edits, renames, link wiring, doc tables.
    
    === 2. PER-HOST MODEL MAP (label -> concrete model for the Agent/subagent `model` field) ===
    Claude Code (Agent tool `model` accepts: opus | sonnet | haiku | inherit | full-id):
      frontier -> "opus"   |  standard -> "sonnet"  |  fast -> "haiku"
    Codex (its own tier handles; use the host's current top/mid/fast model ids):
      frontier -> top tier (e.g. gpt-5.x high)  |  standard -> mid tier  |  fast -> fast/mini tier
    The orchestrator resolves the label to the concrete model just before dispatch.
    
    === 3. UNSET suggestedModel ===
    If a task's `suggestedModel` is empty/unset, the orchestrator defaults to its OWN model class (Claude: pass `inherit`; Codex: its own current model) AND emits a visible WARNING line naming the task id, so the plan author can backfill the hint (see T11, which makes /plan:* populate it going forward).
    
    === 4. REVIEWER CAPABILITY ('most capable') ===
    The implement-reviewer is ALWAYS dispatched at the host's most-capable model, independent of the task's tier: Claude -> `opus`; Codex -> its top tier. The conflict-resolver (T7) likewise runs at frontier. Rationale: review/merge correctness gates everything; never economize there.
    
    === 5. DUAL WORKTREE STRATEGY ===
    Claude Code: use NATIVE per-subagent isolation — dispatch the implement-worker via the Agent tool with `isolation: "worktree"` (frontmatter advertises it too). The worktree is auto-created and auto-removed-if-unchanged, but is NOT auto-merged — the orchestrator owns merge-back (T9 step 7).
    Codex: no declarative subagent-worktree mechanism exists, so the orchestrator runs MANUAL git worktree lifecycle: `git worktree add <path> -b <branch> <base>` before dispatch; pass the worktree path to the sub-agent; after the success gate, rebase + merge-back from the main checkout; `git worktree remove <path>` (and delete the branch) on completion. On unresolved conflict or bailout, leave the worktree intact for inspection.
    
    Branch naming (both hosts): `implement/<taskId>` off the current base; merge-back is sequential in DAG order with rebase-before-merge (T9 step 7, decision deferred to Q6 already resolved in the plan).
- alternatives: "(a) Reuse Claude's literal model ids (opus/sonnet/haiku) directly in `suggestedModel` — rejected: not portable to Codex, defeats the cross-tool goal. (b) A finer tier ladder (5+ tiers) — rejected: more than the Agent `model` surface can express on either host and harder for the planner to choose; three tiers map cleanly to top/mid/fast on both. (c) Native isolation on both hosts — impossible: Codex has no equivalent, hence the dual strategy."
- ledgerRefs: ["goals:G1"]

## M2

### K2 — locked

- createdAt: 2026-06-01T20:13:13.876Z
- updatedAt: 2026-06-01T22:17:52.764Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "In-process ledgers: relocate the MCP server into the UI process, don't make UIs read files"
- rationale: |
    Goal: omitting --mcp-url should let each UI work without a separate ledger-mcp process. Constraint: the repo invariant 'frontends are pure MCP clients — never read ledger files directly' (CLAUDE.md) must hold. Resolution: co-locate the MCP *server* in the same OS process as the UI, not bypass MCP.
    
    TUI (a Bun process): build FsLedgerStore(cwd)+init, buildServer(store), connect it to a Client over InMemoryTransport.createLinkedPair() (verified present in @modelcontextprotocol/sdk 1.29.0 /inMemory.js). The existing McpLedgerClient wraps that Client unchanged — no HTTP, no network, UI still speaks MCP.
    
    Web (browser UI cannot touch the FS): the ledger-web serve process hosts /mcp (Streamable HTTP) and /ws (live) itself from an embedded FsLedgerStore instead of reverse-proxying to an upstream. Browser still connects same-origin via MCP HTTP — pure client preserved.
    
    The standalone ledger-mcp binary stays (the agent's stdio server via .mcp.json still needs it).
- alternatives: "(1) Add a LocalLedgerClient that calls FsLedgerStore methods directly — rejected: violates the pure-MCP-client invariant and duplicates the tool layer's shape-mapping (fetch view, fts hit, milestone create). (2) Web embedded via loopback self-host (serveHttp on 127.0.0.1:0 + proxy to it) — pragmatic, zero refactor, but adds an in-process network hop; kept as a fallback if the handler extraction (T17) proves heavy."

## M1

### K3 — locked

- createdAt: 2026-06-01T20:20:17.613Z
- updatedAt: 2026-06-01T20:20:17.613Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (ref review R1) with empty new_questions; criticism folded into tasks T4/T5/T6/T9. Plan for /implement:* command family is approved."
- ledgerRefs: ["goals:G1"]

## M4

### K5 — locked

- createdAt: 2026-06-01T20:53:24.048Z
- updatedAt: 2026-06-01T20:53:24.048Z
- author: "opus-4.8[1m]"
- session: 94b7733c-6379-4acb-a300-7d92f856f321
- headline: "/plan:follow-up re-opens planned/building goals to planning; done/abandoned stay terminal"
- rationale: "User chose 're-open the same goal (schema change)' + 'clarify-first' for adding scope to an existing goal. Implemented by adding re-open edges `planned->planning` and `building->planning` to GOALS_SCHEMA.transitions. `done`/`abandoned` were NOT made re-openable: validateSchema enforces 'a terminal status must have no outgoing transitions' (core.ts:177), so a done->planning edge would require dropping `done` from terminalStatuses, which regresses milestone archiving (archive refuses non-terminal items) and the meaning of 'done'. Since the plan-flow and implement-flow only ever drive a goal to `planned` or `building` (both non-terminal), re-open from those covers every reachable state including G1. /plan:follow-up steps the goal planned/building -> planning -> clarifying and hands to plan-advance for a fresh clarifying round; a terminal goal is refused with a recommendation to /plan:start a fresh linked goal. docs/ledgers.yaml regenerated via regen-bootstrap so the persisted registry matches canon (no BootstrapViolationError on restart)."
- alternatives: "(a) Linked follow-up goal (no schema change) - rejected by the user (wanted the SAME goal). (b) Append scope without re-clarifying - rejected (wanted clarify-first). (c) Make `done` re-openable by removing it from terminalStatuses - rejected here: breaks the terminal-no-outgoing invariant and milestone archiving; a fresh linked goal is the right tool for a fully-finished goal."
- ledgerRefs: ["goals:G1","tasks:T25"]
