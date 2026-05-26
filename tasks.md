# cq — active task ledger

**Cycle:** outer-1 / inner M0 (PR-01 closed; PR-02 next).
**Goal:** build cq — TypeScript Web UI for the Claude Agent SDK on Bun + React + WebSocket per [`./prompt.md`](./prompt.md). Discharge condition: all five milestones `[x]` and archived; `bun test` clean; `bun run start --cwd <real-dir>` launches; sample prompt round-trips Chat tab + History tab drill-down.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md).

## Cross-cutting locks (non-negotiable, project-wide)

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any` outside justified library boundaries.
- Bun 1.3.13 (flake-pinned). React 19.2.6 fn+hooks only. `@anthropic-ai/claude-agent-sdk@0.3.150` (zod 4 peer).
- WebSocket-only application data. No HTTP endpoints for app data. No auth. No telemetry.
- One concurrent editor per ledger group; worktree-per-editor for parallel cycles; one ledger entry = one commit; sequential never-reused PR ids.
- Resilient-WS-UI Part-3 checklist is the spine of M1; every item is owned by a specific PR (see plan § 6 + coverage matrix in review).
- One open escalation: §11 **Q-1** (AskUserQuestion answer-injection) — *conditional, fires only if PR-31's spike disconfirms Candidate A*. Documented in plan with a recommended fallback.

## Milestones — stubs

- [ ] **M0 — Bring-up** — workspace, protocol, smoke server, logger, dev/HMR. *PRs PR-01 … PR-05 (5).*
- [ ] **M1 — WebSocket spine** — full resilient-ws-ui Part 3 coverage. *PRs PR-06 … PR-18 (14, incl. PR-09a).*
- [ ] **M2 — Agent SDK integration (Chat MVP)** — SDK bridge, Chat shell, markdown + Shiki, basic cards, interrupt, header. *PRs PR-19 … PR-26 (9, incl. PR-22a/b).*
- [ ] **M3 — Chat full fidelity** — permission overlays, elicitation, AskUserQuestion, plan mode, thinking blocks, slash autocomplete, attachments, file-ref anchors, more tool cards, TaskList sidebar. *PRs PR-27 … PR-38 (12).*
- [ ] **M4 — Persistence + History tab** — DDL, adapters, bridge writes, list/detail/timing/export/delete, resume-from-history. *PRs PR-39 … PR-47 (9).*
- [ ] **M5 — Polish & harden** — graceful shutdown, error toasts, a11y, E2E suite, README, type/lint clean, stop-condition verify. *PRs PR-48 … PR-54 (7).*

Total PR count: 56 (PR-01 … PR-54 + PR-09a + PR-22b; PR-22a replaces old PR-22).

## M0 — Bring-up (current milestone)

Goal: skeleton repo, shared protocol package, smoke server, logger, dev/HMR. Close when all five PRs are `[x]`, `bun test` green, `bun run dev` exits cleanly on SIGINT.

- [x] **PR-01** — Workspace skeleton + tsconfig — committed `78abb0d`. Acceptance: `bun install`, `bun x tsc -b`, `bun test --pass-with-no-tests`, `bun x eslint .` all exit 0. Surprises: bun lockfile is JSON-text (`bun.lock`) in 1.3.13 not binary; TS resolved to 5.9.3 from caret 5.7.x; `tsc -b --noEmit` is TS-incompatible with composite project references — `tsc -b` is the canonical command and is what the npm script calls.
- [x] **PR-02** — Shared protocol package (Zod schemas) — committed HEAD. 76 tests pass including `ChatInput rejects oversize attachments` (F-08); discriminated unions `ClientFrame` / `ServerFrame` exported.
- [x] **PR-03** — `Bun.serve` smoke server + HTTP static assets — committed HEAD. args.test.ts (7 tests), smoke.test.ts (4 tests); tsc -b clean; eslint clean; curl + SIGINT exit 0 verified.
- [ ] **PR-04** — Structured JSON logger — plan § 6 M0/PR-04.
- [ ] **PR-05** — `bun run dev` with HMR via `Bun.serve({development:{hmr:true}})` — plan § 6 M0/PR-05 (F-12).

**Dispatch order:** strict serial PR-01 → 02 → 03 → 04 → 05. PR-02 has no PR-01 dep but the planner sequences it second to settle shared types early. PR-03/04 both depend on PR-01. PR-05 depends on PR-03 + PR-04.

## In-progress / recent

- **PR-04** — Structured JSON logger — next up.

## Recent completions (this cycle's worth)

- [x] **PR-03** — `Bun.serve` smoke server + HTTP static assets. Committed HEAD. Hand-rolled CLI parser (`--cwd --host --port --db`); `buildWeb()` via `Bun.build` on startup (option A); SIGINT/SIGTERM exit 0. 7 args unit tests + 4 smoke integration tests; tsc -b and eslint clean.
- [x] **PR-02** — Shared protocol package (Zod schemas). Committed HEAD. 76 tests; all named acceptance tests pass; `ClientFrame`/`ServerFrame` discriminated unions; `ChatInput` 5 MB cap; `isRetriable()` close-code helper.
- [x] **PR-01** — Workspace skeleton + tsconfig. Committed `78abb0d`. (See M0 stub above for surprises.)
- [x] **M0.0** — Flake dev environment (bun 1.3.13, node 22, sqlite 3.51, dev tooling). Committed `9faab3c`.
- [x] **G1/G2** — Brief read; planning subagent produced milestone plan; adversarial reviewer found 20 issues; G2c iteration applied all 20 in-place; one conditional escalation (Q-1) documented. Plan accepted. Committed `2181ae6`.

## Archive

_None yet._ First archive lands when M0 closes → `./docs/archive/tasks-M0.md`.
