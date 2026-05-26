# cq — active task ledger

**Cycle:** outer-1 / inner M5 (M4 archived; PR-49 next). **FINAL MILESTONE.**
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
- [x] **M4 — Persistence + History tab** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)) — 9 PRs.
- [ ] **M5 — Polish & harden** — graceful shutdown, error toasts, a11y, E2E suite, README, type/lint clean, stop-condition verify. *PRs PR-48 … PR-54 (7).*

Total PR count: 56 (PR-01 … PR-54 + PR-09a + PR-22b). 50 of 56 closed (385 tests passing).

## M5 — Polish & harden (current milestone — FINAL)

Goal: ship. Graceful shutdown, error toasts, accessibility pass, true end-to-end suite (the brief § 7 one), README + screenshots, final `bun run check`, stop-condition verification per brief § 11.

- [x] **PR-48** — Graceful shutdown (SIGTERM/SIGINT, --shutdown-timeout-ms, 1012 close); F-05 timeout-exceeded test. Test: `shutdown.test.ts`. Deps: PR-19, PR-39.
- [x] **PR-49** — Error toasts (bounded 50-entry queue; chat.error + 4xxx close surface). Test: `toast.test.ts`. Deps: PR-22a.
- [x] **PR-50** — Accessibility pass (aria-live, focus, reduced-motion, axe). Test: `a11y.test.ts`. Deps: PR-17, PR-22a, PR-22b, PR-25, PR-42.
- [x] **PR-51** — End-to-end suite (brief § 7 mandate; should resolve `PR-18-D01` if possible by driving Manager in-process; resolves `PR-31-D01` if real-SDK becomes feasible). Test: `e2e/full.test.ts`. Deps: PR-26, PR-44, PR-48.
- [ ] **PR-52** — README + run instructions + 2 screenshots + known-limitations (F-11 attachment cap, F-09 R14, F-02 AskUserQuestion status). Deps: PR-51.
- [ ] **PR-53** — Final type-check + lint clean; `bun run check` wires tsc + eslint + test. Deps: all prior.
- [ ] **PR-54** — Final stop-condition verification per brief § 11 (server up, browser open, list-files round-trip, History drill-down); session log under `./docs/logs/`. Deps: PR-52, PR-53.

## In-progress / recent

- **PR-52** — README + screenshots — next.

## Recent completions (this cycle's worth)

- [x] **M4 closed + archived** to `docs/archive/tasks-M4.md`. 9 PRs (PR-39 … PR-47). 383 tests across 58 files; 0 fail. Persistence layer (Sqlite + InMemory adapters with dual-tests + FTS); bridge writes live; HistoryTab list/detail/timing/export/delete; resume-from-history. CASCADE + JSONL cleanup verified.

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
- M3 → [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)
- M4 → [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)
