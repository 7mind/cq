# cq — active task ledger

**Cycle:** outer-7 / gear-popup + Codex SDK platform programme.
**Goal:** Ship gear-icon settings popup + reasoning-effort + `@openai/codex-sdk` as a second platform (Claude/Codex routing via model dropdown).
**Accepted plan:** [`docs/drafts/20260528-1432-gear-and-codex-plan.md`](docs/drafts/20260528-1432-gear-and-codex-plan.md) (G2b-reviewed).
**Baseline (post-merge of main 777231e):** `bun test` → 593 pass / 18 fragile-env fail / 611 total (across 78 files). `tsc -b` clean. `eslint .` 10 pre-existing warnings.
**Defects:** [`./defects.md`](./defects.md).

## Active — outer-7 (gear-popup + Codex)

Sequence: each PR is one commit. `bun run check` clean after every PR (no new failures beyond the 18 fragile-env baseline). Tagged `gear-N` or `codex-N` or `e2e-N`.

- [ ] **gear-1** — Effort domain enum + Claude mapping table + `ChatStart.effort` Zod field. `packages/shared/src/effort.ts` (new); `packages/shared/src/protocol.ts` (extend); `packages/shared/src/index.ts` (re-export). Tests: `protocol.test.ts`, `effort.test.ts`.
- [ ] **gear-2** — Migration #6: `session.effort TEXT NOT NULL DEFAULT 'none'` AND `session.platform TEXT NOT NULL DEFAULT 'claude'` (bundled per G2b finding #1, subsumes codex-2). Both adapters; `SessionRow` + `HistoryRow` Zod updated. Tests: `persist-crud.test.ts`.
- [ ] **codex-1** — Shared `models.ts` registry + `modelToPlatform(modelId)` + `Platform` enum. Tests: `models.test.ts`.
- [ ] **codex-3** — `ChatStart.platform` Zod field + server platform-mismatch refusal. Tests: `protocol.test.ts`, `bridge.test.ts` refusal path. **Platform-mismatch acceptance test lives here.**
- [ ] **codex-4** — `BackendBridge` interface; rename `Bridge` → `ClaudeBridge` in `claudeBridge.ts`; `bridge.ts` becomes facade. Tests: existing tests still pass; new `bridgeFacade.test.ts` for routing.
- [ ] **codex-5** — `@openai/codex-sdk@0.134.0` dep + `CodexBridge` skeleton + auth-error refusal. Tests: `codexBridge.test.ts` with hand-written dummy.
- [ ] **codex-6** — `CodexBridge` event-stream translation + `resumeThread` support. Persists `thread_id` into `sdkSessionId`. Tests: extend `codexBridge.test.ts`.
- [ ] **gear-3** — Gear-icon Header refactor + `SettingsPopup.tsx` (model + permissionMode + hideSdkEvents + effort, localStorage-defaulted). Header retains cwd/title/badges/buttons. Tests: `settingsPopup.test.ts`, `header.test.ts` updated.
- [ ] **codex-7** — Popup permission-mode option set switches by platform (`sandboxMode` 3-value union for Codex; existing 5-value union for Claude). Client sends `ChatStart.platform`. Tests: `settingsPopup.test.ts` extended.
- [ ] **gear-4** — Bridge effort persistence: `session.effort` set on start; Claude SDK `thinking.budget_tokens` passed per mapping. Tests: `bridge-persist.test.ts`, `bridge.test.ts` thinking forwarded.
- [ ] **gear-5** — History "Effort" column. Tests: `history-list.test.ts`.
- [ ] **codex-8** — History "Platform" column + Resume hidden across platforms. Tests: `history-list.test.ts` extended.
- [ ] **e2e-1** — `gear-popup.spec.ts`. Existing 16 + 1.
- [ ] **e2e-2** — `cross-platform-resume.spec.ts`. +1.
- [ ] **e2e-3** — `codex-roundtrip.spec.ts` (skip-if-no-auth). +1 discovered.

Discharge: `bun run check` ≤18 fail; `bun run e2e` 16 + 2 + 1 skip; `defects.md` carries D-GC-1 and D-GC-N1.

## Cycle outer-6 — discharged

(see prior tasks.md content, archived implicitly under M5/L milestones.)

## Cycle outer-5 — discharged

- [x] **L1–L10** — `@cq/ledger` package shipped (see `docs/archive/`).
- [x] **PR-01–PR-05** — resume-from-history rework shipped.

## Milestones — historical (cq core)

- [x] **M0 — Bring-up** — archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md).
- [x] **M1 — WebSocket spine** — archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md).
- [x] **M2 — Agent SDK / Chat MVP** — archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md).
- [x] **M3 — Chat full fidelity** — archive: [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md).
- [x] **M4 — Persistence + History tab** — archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md).
- [x] **M5 — Polish & harden** — archive: [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md).
