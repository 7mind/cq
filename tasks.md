# cq — active task ledger

**Cycle:** outer-1 / inner M4 (M3 archived; PR-39 next).
**Goal:** build cq — TypeScript Web UI for the Claude Agent SDK on Bun + React + WebSocket per [`./prompt.md`](./prompt.md). Discharge condition: all five milestones `[x]` and archived; `bun test` clean; `bun run start --cwd <real-dir>` launches; sample prompt round-trips Chat tab + History tab drill-down.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _(3 open: `PR-18-D01` deferred to PR-51; `PR-20-D01` deferred (real SDK binary); `PR-31-D01` deferred to PR-51. 1 resolved: `PR-19-D01`.)_

## Cross-cutting locks (non-negotiable, project-wide)

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any` outside justified library boundaries.
- Bun 1.3.13 (flake-pinned). React 19.2.6 fn+hooks only. `@anthropic-ai/claude-agent-sdk@0.3.150` (zod 4 peer).
- WebSocket-only application data. No HTTP endpoints for app data. No auth. No telemetry.
- One concurrent editor per ledger group; worktree-per-editor for parallel cycles; one ledger entry = one commit; sequential never-reused PR ids.
- Resilient-WS-UI Part-3 checklist coverage is complete (M1 closed; see archive).

## Milestones — stubs

- [x] **M0 — Bring-up** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)) — 5 PRs.
- [x] **M1 — WebSocket spine** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)) — 14 PRs.
- [x] **M2 — Agent SDK / Chat MVP** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)) — 9 PRs.
- [x] **M3 — Chat full fidelity** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)) — 12 PRs.
- [x] **M4 — Persistence + History tab** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)) — DDL, adapters, bridge writes, list/detail/timing/export/delete, resume-from-history. *PRs PR-39 … PR-47 (9).*
- [ ] **M5 — Polish & harden** — graceful shutdown, error toasts, a11y, E2E suite, README, type/lint clean, stop-condition verify. *PRs PR-48 … PR-54 (7).*

Total PR count: 56 (PR-01 … PR-54 + PR-09a + PR-22b; PR-22a replaces old PR-22). 45 of 56 closed (374 tests passing).

## M4 — Persistence + History tab (current milestone)

Goal: SQLite + JSONL persistence layer; live writes from the bridge; History tab with list view (sortable/filterable/FTS), detail view (reuses Chat renderer), timing strip, export, delete; resume-from-history end-to-end.

- [x] **PR-39** — Persistence layer: DDL + migrations + open; `Persistence.ts` interface; FTS triggers. Test: `persist-open.test.ts`. Deps: PR-04.
- [x] **PR-40** — `SqlitePersistence` + `InMemoryPersistence` (dual-tests); CRUD + paginate + filter + FTS; JSONL event-log writer; FTS-update assertion (F-13). Test: `persist-crud.test.ts`. Deps: PR-39.
- [x] **PR-41** — Bridge writes to persistence (live): chat.start → insert session+invocation; events → JSONL; task_started → child invocation; `history.update` live. Test: `bridge-persist.test.ts`. Deps: PR-26, PR-40.
- [x] **PR-42** — Web `HistoryTab` list view (sortable, filterable, FTS search). Test: `history-list.test.ts`. Deps: PR-40.
- [x] **PR-43** — Resume-from-history (`resumeFromInvocationId` → SDK `resume:`; transcript replayed via `history.get?replay=true`). Test: `resume.test.ts`. Deps: PR-40, PR-42.
- [x] **PR-44** — Web `Detail` view (reuses Chat renderer; `Stream` gains `mode='live'|'replay'`). Test: `history-detail.test.ts`. Deps: PR-42 + many M3 cards.
- [x] **PR-45** — Web `Timing` strip (SVG horizontal time axis with tool-call rectangles). Test: `timing.test.ts`. Deps: PR-44.
- [x] **PR-46** — Export: copy-as-markdown + download-as-json. Test: `export.test.ts`. Deps: PR-44.
- [x] **PR-47** — Delete invocation / delete session (`history.delete` wire frame + cascade + JSONL cleanup + confirm). Test: `history-delete.test.ts`. Deps: PR-40.

**Dispatch order.** Serial through PR-41 (persistence stack), then mostly serial through history/. PR-43 sits between PR-42 and PR-44.

## In-progress / recent

- M4 close → orchestrator archives → M5 starts at PR-48.

## Recent completions (this cycle's worth)

- [x] **M3 closed + archived** to `docs/archive/tasks-M3.md`. 12 PRs (PR-27 … PR-38). 333 tests across 49 files; 0 fail. New defect: `PR-31-D01`.
- [x] **M2 closed + archived** to `docs/archive/tasks-M2.md`. 9 PRs; 251 tests.
- [x] **M1 closed + archived** to `docs/archive/tasks-M1.md`. 14 PRs; 210 tests; full Part-3 R2-R13 + V1-V10.
- [x] **M0 closed + archived** to `docs/archive/tasks-M0.md`. 5 PRs; 113 tests.

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
- M3 → [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)
