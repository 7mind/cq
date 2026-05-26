# cq — active task ledger

**Cycle:** outer-1 — **DISCHARGED**. G4 emitted 2026-05-26.
**Goal:** ✓ build cq per [`./prompt.md`](./prompt.md). Discharge condition met: all five milestones `[x]` and archived; `bun run check` exits 0 (tsc + eslint + 396 tests); `bun run start --cwd <real-dir>` launches; sample prompt round-trips functionally verified via PR-51 e2e (live-browser path gated on missing SDK binary — `PR-20-D01`).
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _(1 open: `PR-18-D01` — carries forward. 3 resolved: `PR-19-D01`, `PR-20-D01`, `PR-31-D01`.)_
**Final session log:** [`docs/logs/20260526-final-log.md`](docs/logs/20260526-final-log.md).

## Milestones — final

- [x] **M0 — Bring-up** — archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md). 5 PRs; 113 tests.
- [x] **M1 — WebSocket spine** — archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md). 14 PRs; full R2-R13 + V1-V10 Part-3.
- [x] **M2 — Agent SDK / Chat MVP** — archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md). 9 PRs.
- [x] **M3 — Chat full fidelity** — archive: [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md). 12 PRs.
- [x] **M4 — Persistence + History tab** — archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md). 9 PRs.
- [x] **M5 — Polish & harden** — archive: [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md). 7 PRs.

**56 PRs shipped. 396 tests passing. 0 fails, 0 skips, 0 algedonic escalations to the user.**

## Post-discharge fixes

- `fix: install real SDK binary (PR-20-D01) + verify Candidate-A spike (PR-31-D01)` — Pinned `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.150` in `packages/server/package.json`; added `resolveNativeBinaryPath()` to bridge.ts; added real-SDK test cases to `sdk-stub.test.ts`, `mcp-inheritance.test.ts`, and `ask-question.test.ts`; updated `MockAnthropicHTTP` to handle `HEAD /` probe and multi-round `scriptedResponder`; confirmed Candidate-A (synthetic tool_result injection) works against real subprocess. 399 tests pass (3 new).
- `fix: web → composite TS project + ws-resilience drives real Manager (closes PR-18-D01)` — Made `packages/web` a TypeScript composite project (`composite:true`, `declaration:true`, `declarationMap:true`, `rootDir:./src`); created `packages/web/src/index.ts` re-exporting `Manager`, `Connection`, and related types; updated `packages/server/tsconfig.json` to reference `../web` and add `@cq/web` path alias; rewrote `ws-resilience.test.ts` to drive a real `Manager` with real Bun `WebSocket` transport against the fixture server (all 3 scenarios pass). Also fixed `isRetriable` to treat 1006 (ABNORMAL_CLOSURE) as retriable so the stale-grace DEAD path schedules reconnection. 399 tests pass (0 new failures).

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
- M3 → [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)
- M4 → [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)
- M5 → [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md)
