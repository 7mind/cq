# Session log — outer-5 `@cq/ledger`

**Date:** 2026-05-28
**Branch:** `worktree-agent-a9aea624edcc7b1ba`
**Worktree:** `/home/pavel/work/safe/cqe/cq1/.claude/worktrees/agent-a9aea624edcc7b1ba`

## Goal

Ship `packages/ledger`, a markdown-backed ledger library plus an in-process
SDK-MCP tool surface, end-to-end agent-callable. Per Q12 the acceptance bar
is full integration (agent in the Chat tab can call the tools), not parser-
only.

## What shipped

- New workspace `packages/ledger` with:
  - Types: `Ledger`, `Milestone`, `Item`, `LedgerSchema`, `FieldType`,
    `ArchivePointer`, typed errors.
  - Parser: `parse.ts` (unified + remark-parse + remark-frontmatter walker),
    `serialize.ts` (hand-built byte-stable markdown writer), `frontmatter.ts`.
  - Store: abstract `LedgerStore` interface; `FsLedgerStore` (production —
    per-ledger AsyncMutex + advisory `.lock` with stale-PID reclaim +
    atomic tmp+fsync+rename write-through); `InMemoryLedgerStore` (hand-
    written dummy for dual-tests).
  - Registry: `ledgers.yaml` v1 read/write + schema validation.
  - MCP: 12 tools (`enumerate_ledgers`, `fetch_ledger`,
    `fetch_ledger_archive`, `fetch_milestone`, `update_milestone`,
    `ledger_fetch`, `ledger_update`, `create_item`, `create_milestone`,
    `create_ledger`, `archive_milestone`, `search_items`).
- Server wiring: `bridge.ts` accepts a `LedgerStore` and merges its tools
  into the in-process `cq` MCP server alongside `ask_user_question`;
  `server.ts` / `devServer.ts` / `main.ts` construct `FsLedgerStore({ root:
  cwd })` at startup. The existing `mcp__cq__*` auto-allow rule in
  `canUseTool` already covers the new tool names — no `canUseTool` change.
- Tests (per the `dual-tests` + `constructive-test-taxonomy` skills):
  - **T1 (Logic/Blackbox/Atomic)**: 4 round-trip cases (representative
    fixture, idempotency, empty ledger, archive milestone).
  - **T2 (Communication/Blackbox/Atomic, dual-tests)**: 9-case abstract
    suite × 2 adapters (`InMemoryLedgerStore`, `FsLedgerStore` against tmp dir).
  - **T3 (Communication/Blackbox/Atomic)**: 50 parallel updates + 50
    parallel creates + cross-ledger parallelism (3 cases).
  - **T4 (Communication/Blackbox/Atomic)**: lockfile reclaim + live-respect
    + round-trip (3 cases).
  - **T5 (Logic/Blackbox/Atomic)**: MCP tool wire-shape + create/fetch/
    update/archive/search (5 cases).
  - **T6 (Communication/Whitebox/Sociable)**: real SDK subprocess +
    MockAnthropicHTTP + FsLedgerStore round-trip for
    `mcp__cq__enumerate_ledgers`.
  - **T7 (Behavior/Blackbox/Sociable)**: Playwright spec exercises
    `mcp__cq__create_ledger` end-to-end; asserts `docs/todos.md` and
    `docs/ledgers.yaml` on disk.

## Discharge evidence

- `bun run check`: 558 pass / 0 fail (baseline was 524 → +34 ledger tests).
- `bun run e2e`: 16/16 pass (baseline was 15 → +1 ledger-create spec).
- Total session: 11 commits, all green.

## Resolved this session

No defects opened or closed during this cycle; the L-series cycles ran
clean against their acceptance criteria. Two leaf-level refinements during
implementation (counter +1 semantics, archive error regex) were caught at
the unit-test level and corrected before commit, per the *Refinement (no
homeostat firing)* rule.

## Metrics

```markdown
Metrics:
- WIP max 1 (serial cycles); review rounds <L1..L10:1>
- S3-S4 firings <research:0, replan:0>; time-to-stabilize n/a
- Material scope delta <none>; verification <complete>
- Audit discrepancies <0>; algedonic <ordinary:0, bypass:0, depth-limit:0>; bypass false-positives <0>
```

## Open follow-ups for the orchestrator

- **Manual UI dogfood** (L10 / Q12): not run from this subagent (would
  require launching the actual Anthropic API and consuming user quota).
  The L8 + L9 integration paths exercise the full agent code path against
  MockAnthropicHTTP, which is the only end-to-end coverage runnable
  hermetically. Orchestrator may want to run `bun run dev`, open the
  browser, and prompt the agent live as a final confirmation.
- **Resume-from-history parallel task collision** (R5): we touched
  `bridge.ts` (added `ledgerStore?` to `BridgeOpts`, refactored the cq
  MCP server construction). We did **not** touch `packages/web/src/history/`,
  `ResumePicker`, `Header.tsx`, `session.title` schema, or the Haiku
  service. The parallel resume-from-history task should be able to merge
  without conflict on the files in its own scope; merge-time conflicts (if
  any) will be in `bridge.ts`'s import block and constructor body, easily
  resolved.
- **Worktree-local `docs/ledgers.yaml`** was accidentally committed in
  commit `c180e44` (an empty registry). It is harmless and the right shape
  for a fresh server run; orchestrator may want to gitignore it before
  merge if the main checkout already has a populated registry, but for now
  leaving it in place is consistent with the brief (the on-disk format
  expects it to exist).
