# cq — active task ledger

**Cycle:** outer-1 / inner M1 (M0 archived; PR-06 next).
**Goal:** build cq — TypeScript Web UI for the Claude Agent SDK on Bun + React + WebSocket per [`./prompt.md`](./prompt.md). Discharge condition: all five milestones `[x]` and archived; `bun test` clean; `bun run start --cwd <real-dir>` launches; sample prompt round-trips Chat tab + History tab drill-down.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _(none opened.)_

## Cross-cutting locks (non-negotiable, project-wide)

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any` outside justified library boundaries.
- Bun 1.3.13 (flake-pinned). React 19.2.6 fn+hooks only. `@anthropic-ai/claude-agent-sdk@0.3.150` (zod 4 peer).
- WebSocket-only application data. No HTTP endpoints for app data. No auth. No telemetry.
- One concurrent editor per ledger group; worktree-per-editor for parallel cycles; one ledger entry = one commit; sequential never-reused PR ids.
- Resilient-WS-UI Part-3 checklist is the spine of M1; every item is owned by a specific PR (see plan § 6 + coverage matrix in review).
- One open escalation: §11 **Q-1** (AskUserQuestion answer-injection) — *conditional, fires only if PR-31's spike disconfirms Candidate A*. Documented in plan with a recommended fallback.

## Milestones — stubs

- [x] **M0 — Bring-up** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)) — workspace, protocol, smoke server, logger, dev/HMR. *5 PRs.*
- [ ] **M1 — WebSocket spine** — full resilient-ws-ui Part 3 coverage. *PRs PR-06 … PR-18 (14, incl. PR-09a).*
- [ ] **M2 — Agent SDK integration (Chat MVP)** — SDK bridge, Chat shell, markdown + Shiki, basic cards, interrupt, header. *PRs PR-19 … PR-26 (9, incl. PR-22a/b).*
- [ ] **M3 — Chat full fidelity** — permission overlays, elicitation, AskUserQuestion, plan mode, thinking blocks, slash autocomplete, attachments, file-ref anchors, more tool cards, TaskList sidebar. *PRs PR-27 … PR-38 (12).*
- [ ] **M4 — Persistence + History tab** — DDL, adapters, bridge writes, list/detail/timing/export/delete, resume-from-history. *PRs PR-39 … PR-47 (9).*
- [ ] **M5 — Polish & harden** — graceful shutdown, error toasts, a11y, E2E suite, README, type/lint clean, stop-condition verify. *PRs PR-48 … PR-54 (7).*

Total PR count: 56 (PR-01 … PR-54 + PR-09a + PR-22b; PR-22a replaces old PR-22).

## M1 — WebSocket spine (current milestone)

Goal: full resilient-ws-ui Part-3 reliability + indicator coverage on both server and client. Close when all 14 PRs are `[x]`, all named tests pass, and PR-18's E2E (freeze + IP-change + server-restart) is green.

- [x] **PR-06** — Server WS endpoint + Zod inbound validation + Origin check (F-19). Tests: `ws-basic.test.ts`, `ws-origin.test.ts`. Deps: PR-02, PR-03. (44 tests, commit `c05b27a`)
- [x] **PR-07** — Server heartbeat (`hb.sping`/`hb.spong`) with setImmediate defer + nonce current+previous lookback `[ws R11]`. Test: `heartbeat.test.ts`. Deps: PR-06. (50 tests, commit HEAD, R11 ticked)
- [ ] **PR-08** — Client `Connection` class: state machine NEW/ALIVE/STALE/DEAD + per-nonce ping + connect timeout `[ws R2,R3,R4]`. Test: `connection.test.ts`. Deps: PR-02.
- [ ] **PR-09** — Client `Manager`: backoff + overlapping reconnect + close-code classify + pool cap=3 `[ws R5,R6,R7]`. Test: `manager.test.ts`. Deps: PR-08.
- [ ] **PR-09a** — Server-side seq replay buffer (last-500 / 5 MB ring per session) (F-04). Test: `replay-buffer.test.ts`. Deps: PR-06, PR-09.
- [ ] **PR-10** — Page Lifecycle wiring + defer-while-hidden Phoenix pattern `[ws R9,R10]`. Test: `lifecycle.test.ts`. Deps: PR-09.
- [ ] **PR-11** — Time-jump detector → proactive reconnect `[ws R8]`. Test: `time-jump.test.ts`. Deps: PR-09. **Serial after PR-10.**
- [ ] **PR-12** — Destroyed-flag guard + terminal-state truth `[ws R12,R13]`. Test: `destroy.test.ts`. Deps: PR-09. **Serial after PR-11.**
- [ ] **PR-13** — Indicator widget: derived state + non-color channels + CSS modules infra `[ws V1,V2,V3]`. Test: `indicator.test.ts`. Deps: PR-09, PR-10, PR-11, PR-12.
- [ ] **PR-14** — Countdown ring + 10 Hz rAF + event-driven refresh `[ws V4,V5]`. Test: `ring.test.ts`. Deps: PR-13. **Serial after PR-13.**
- [ ] **PR-15** — Tooltip with pool, RTT windows, loss %, backoff, last close `[ws V6]`. Tests: `tooltip.test.ts`, `rtt-windows.test.ts`. Deps: PR-13, PR-14. **Serial after PR-14.**
- [ ] **PR-16** — `document.title` mirror + bounded event log + never-lie labels `[ws V7,V8,V9,V10]`. Tests: `title.test.ts`, `event-log.test.ts`. Deps: PR-15. **Serial after PR-15.**
- [ ] **PR-17** — `useConnection` hook + `<ConnectionProvider>` context (F-18). Test: `app-mount.test.ts`. Deps: PR-13..PR-16, PR-06, PR-07.
- [ ] **PR-18** — E2E: freeze + IP-change simulated + server restart. Test: `e2e/ws-resilience.test.ts`. Deps: PR-06 .. PR-17.

**Dispatch order (plan § 9).** Mostly serial. Possible parallel split: PR-07 (server) vs PR-08 (client) can run concurrently in separate worktrees once PR-06 lands (disjoint write scopes: `packages/server/src/ws/` vs `packages/web/src/ws/`). PR-13 onward serialises on `Indicator.tsx` per the F-17 write-scope map.

## In-progress / recent

- **PR-08** — Client `Connection` class: state machine NEW/ALIVE/STALE/DEAD + per-nonce ping + connect timeout `[ws R2,R3,R4]`. Test: `connection.test.ts`. Deps: PR-02.

## Recent completions (this cycle's worth)

- [x] **PR-07** — Server heartbeat with setImmediate defer + nonce lookback `[ws R11]`. `ws/heartbeat.ts` (createHeartbeat factory, WeakMap per-WS state: currentNonce, previousNonce, pendingFlag, pingTimerId, pendingTimerId; setImmediate injection seam for R11 race test), `ws/session.ts` wired (open→heartbeat.start, hb.spong→heartbeat.onPong, close→heartbeat.stop). 6 new tests in `heartbeat.test.ts` (schedule, current-nonce pong, previous-nonce lookback, unknown-nonce ignored, no-pong→1011, R11 race). Compressed real timers (pingIntervalMs:100, pongTimeoutMs:50); setImmediate injection for test 6. Total server tests: **50**. `tsc -b` + `eslint` clean. Operational smoke: WS open → saw hb.sping → close 1011 exit 0. [ws P3-r-10] TICKED. Commit: HEAD.
- [x] **PR-06** — Server WS endpoint + Zod inbound validation + Origin check (F-19). `ws/session.ts` (WsSession class, `open`/`message`/`close`, `sendFrame` helper), `ws/origin.ts` (isOriginAllowed), `server.ts` + `devServer.ts` extended with `/ws` upgrade path. Origin mismatch → HTTP 403 (option A; 1008 reserved for client-side). Zod `ClientFrame.safeParse` on every frame; failure → close 4000. `hb.ping` → `hb.pong` with `echoNonce`+`serverTs`. Tests: `ws-basic.test.ts` (4 cases) + `ws-origin.test.ts` (3 cases). Total server tests: **44** (37 prior + 7 new). `tsc -b` + `eslint` clean. Operational audit: WS open + 403 on bad Origin + SIGINT all exit 0. Commit: `c05b27a`.
- [x] **M0 closed + archived** to `docs/archive/tasks-M0.md`. 5 PRs, 113 tests total (76 shared + 37 server), 0 defects, 0 algedonic escalations. Both `start` and `dev` modes audit-green.
- [x] **G1/G2** — Plan accepted (committed `2181ae6`); G2b found 20 issues; G2c patched all 20 in-place; one conditional escalation (Q-1) documented.

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
