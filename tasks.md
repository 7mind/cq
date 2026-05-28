# cq — active task ledger

**Cycle:** outer-9 / defect-closure on D-GC-1 (Codex ledger MCP via external stdio binary) + D-GC-N1 (Codex approvalPolicy popup row).
**Goal:** Ship `packages/cq-mcp` stdio MCP binary that exposes the 12 `mcp__cq__*` ledger tools; wire `CodexBridge` to spawn it per session through `CodexOptions.config.mcp_servers.cq`. Expose Codex `approvalPolicy` (4-value enum) as a second gear-popup row when platform=codex; persist on session row via migration #7; plumb through `ChatStart`; forward in `ThreadOptions.approvalPolicy`.
**Baseline (verified worktree f5d02d7):** `bun test` → 672 pass / 0 fail / 0 error / 2418 expect() across 84 files. `tsc -b` clean. `bun run e2e` (per outer-8 ledger): 18 passed / 1 skipped.
**Defects:** [`./defects.md`](./defects.md).

## Active — outer-9 (defect-closure: D-GC-1 + D-GC-N1)

Sequence (one commit per PR; tags `cq-mcp-N`, `gc1-N`, `gcn1-N`):

- [x] **cq-mcp-1+2+3** — new `@cq/cq-mcp` workspace + `src/main.ts` stdio binary + `test/main.test.ts` end-to-end via the MCP `Client`. Pinned `@modelcontextprotocol/sdk@1.29.0`. Bin linked at `packages/server/node_modules/.bin/cq-mcp` after adding `@cq/cq-mcp` to server's deps. Schemas mirror `packages/ledger/src/mcp/ledgerTools.ts`; `ask_user_question` deliberately not exposed (deferred — needs WS bridging). Commit `7e3f693`. `bun run check`: 675/0.
- [ ] **gc1-1** — `CodexBridge` (and `BridgeOpts` facade) gain a resolved `cqMcpBinPath` (resolution order: `node_modules/.bin/cq-mcp` relative to the server cwd; else `bun run <repo>/packages/cq-mcp/src/main.ts` fallback). In `handleChatStart`, build `Codex` (constructor) with `config: { mcp_servers: { cq: { command, args: ["--cwd", this.cwd] } } }` for fresh sessions; per-session re-construction is acceptable since the prior session is shut down before. → verify: new `packages/server/test/codexBridge-mcp.test.ts` asserts the codexFactory receives a `CodexOptions` whose `.config.mcp_servers.cq.command` resolves to the cq-mcp bin and args include `--cwd <cwd>`.
- [ ] **gc1-2** — README.md prerequisite note: a Codex-ledger session requires `bun install` to have run so `cq-mcp` is linked under `node_modules/.bin`. Add a follow-up TODO row D-CQMCP-NIX for Nix-closure verification (Nix build out of scope this cycle). Add a follow-up TODO row D-CQMCP-E2E for "exercise cq-mcp via codex-roundtrip e2e once OPENAI_API_KEY is available." Close D-GC-1 in `defects.md` with artifact citations.
- [ ] **gcn1-1** — Migration #7: `ALTER TABLE session ADD COLUMN approval_policy TEXT NULL`. `SessionRow` (TS) and `HistoryRow`/`HistoryRowFull` (Zod) gain `approvalPolicy?: string | null`. Both adapters honor it (insert/select). → verify: persist round-trip test extended.
- [ ] **gcn1-2** — `ChatStart` Zod gains `approvalPolicy: z.enum([…4 values…]).optional()`. Facade rejects Claude-platform with non-null approvalPolicy as `chat.error{code:'approval-policy-on-claude'}`. `CodexBridge.handleChatStart` forwards `frame.approvalPolicy` → `threadOptions.approvalPolicy` and persists onto the session row. → verify: `codexBridge.test.ts` extended; `bridge.test.ts` adds the refusal case.
- [ ] **gcn1-3** — `SettingsPopup.tsx` renders an "Approval policy" select row when `platform === "codex"`. Options = the 4 SDK values; default = `on-request`. localStorage key `cq.codex.approvalPolicy`. ChatTab forwards onto `ChatStart`. → verify: `settingsPopup.test.ts` covers presence-when-codex / absence-when-claude / change + LS round-trip; close D-GC-N1.

**Inner-loop discipline:** Each PR is one commit. Each PR's verification is run before its commit. `bun run check` must remain 0 between PRs except mid-`cq-mcp-1` where new package types are wired (we still gate at the next commit boundary).

**Session log:** [`docs/logs/20260528-1500-outer9-log.md`](docs/logs/20260528-1500-outer9-log.md) (written at G4).

## Cycle outer-8 (defect-fix on outer-7) — DISCHARGED

- [x] **D-OUTER7-01** — happy-dom global pollution / 18 test regressions. Root cause: `GlobalRegistrator.register()` patches process globals (`Request`, `fetch`, `Headers`, `document`, `window`) without ever calling `unregister()`; web tests leaked patched globals into server tests, breaking `Request`-using unit tests (origin) and `fetch`-using HTTP tests (smoke / dev-server / ws-origin / sdk-stub / MockAnthropicHTTP). Fix: `packages/web/test/helpers/dom.ts::registerDom()` + `afterAll(unregister)` applied across all 33 web test files; regression assertion in `packages/web/test/helpers/dom.test.ts`. Commit `1f66a9b`. `bun test`: 652/18/1 → 670/0/0.
- [x] **D-OUTER7-02** — Codex MCP-injection gap documented with API citation per brief option (b). `codexBridge.ts` JSDoc cites the exact `ThreadOptions` (dist/index.d.ts line 239) and `CodexOptions` (line 216) shapes that block in-process injection, plus the `cq-mcp` external-binary path that would close the gap. Commit `e52d651`.
- [x] **D-OUTER7-03** — deleted spurious D-GC-N0 row from `defects.md`. Commit `32d1377`.
- [x] **D-OUTER7-04** — corrected baseline numbers in this file and the outer-7 session log; this row plus the outer-7 row's discharge-metrics block now reflect the actual main baseline (611/0/0) and the actual cycle delta (+41 net new passing tests, 18 new failures + 1 error fixed in outer-8). Commit `32d1377`.

**Discharge metrics:**
- `bun test`: **672 pass / 0 fail / 0 error / 2418 expect()** across 84 files. Up from baseline 611/0/0 by +59 net (+41 from outer-7 + 2 from outer-8's helpers/dom.test.ts regression assertions + 16 already-net from outer-7 categorised as "+59 passing tests, no new failures" pre-correction, now reconciled). The 18 new fails + 1 error introduced by outer-7 are all eliminated.
- `bun run check`: **exit 0** (tsc clean; eslint 0 errors / 22 warnings; bun test green).
- `bun run e2e` (Playwright): **18 passed / 1 skipped / 0 failed** — unchanged from outer-7.
- `defects.md`: D-OUTER7-01..04 entered + closed; D-GC-N0 deleted; D-GC-1 and D-GC-N1 remain open as deferred follow-ups (Codex MCP external binary; popup approvalPolicy row).

**Session log:** [`docs/logs/20260528-defect-fix-outer8-log.md`](docs/logs/20260528-defect-fix-outer8-log.md).

## Cycle outer-7 — discharged (with baseline correction per D-OUTER7-04)

Sequence: each PR is one commit. Tagged `gear-N` or `codex-N` or `e2e-N`.

- [x] **gear-1** — Effort domain enum + Claude mapping table + `ChatStart.effort` Zod field. Commit `149c0ba`. +10 unit tests.
- [x] **gear-2** — Migration #6: `session.effort` + `session.platform`. Both adapters; `SessionRow` + `HistoryRow` Zod updated. Commit `d35e5c2`. +3 dual-adapter cases.
- [x] **codex-1** — Shared `models.ts` registry + `modelToPlatform` + `Platform` enum. Commit `(c1)`. +10 unit tests.
- [x] **codex-2** — Bundled into gear-2 (single migration #6).
- [x] **codex-3** — `ChatStart.platform` Zod field + server platform-mismatch refusal. Commit `523bbae`. +2 bridge tests (refusal path tested at both resume and fresh-start defence-in-depth).
- [x] **codex-4** — `BackendBridge` interface; `ClaudeBridge` in `claudeBridge.ts`; `bridge.ts` is now facade. Commit `(c4)`. +7 facade tests. **Architectural commitment ships here.**
- [x] **codex-5** — `@openai/codex-sdk@0.134.0` dep + `CodexBridge` skeleton + auth-error refusal + `resumeThread`. Commit `(c5)`. +6 dummy-Codex tests.
- [x] **codex-6** — Event-stream translation folded into codex-5 (the skeleton already maps thread.started/turn.started/item.completed{agent_message}/turn.completed/turn.failed). Richer item translation (command_execution / file_change / mcp_tool_call cards) deferred to a future cycle — defect not opened because the v1 brief explicitly defers Codex MCP wiring (D-GC-1) and the existing assistant-message path covers the codex-roundtrip e2e.
- [x] **gear-3** — Gear-icon Header refactor + `SettingsPopup.tsx` (model + permissionMode + hideSdkEvents + effort, localStorage-defaulted, platform-aware permission options). Commit `(g3)`. +9 popup tests, +2 header tests. **codex-7 (platform-aware popup options) folded into gear-3 since both edit the same component.**
- [x] **codex-7** — Folded into gear-3.
- [x] **gear-4** — Bridge effort persistence + Claude SDK `thinking.budget_tokens`. Commit `d040069`. +4 tests.
- [x] **gear-5** — History "Effort" column. Bundled with codex-8 in commit `b3da578`.
- [x] **codex-8** — History "Platform" column + Resume hidden across platforms (via `localStorage.cq.model`). Bundled with gear-5 in commit `b3da578`. +3 history-list tests.
- [x] **e2e-1** — `gear-popup.spec.ts` — open/close/outside-click/Esc/localStorage round-trip.
- [x] **e2e-2** — `cross-platform-resume.spec.ts` — UI hide + programmatic WS platform-mismatch refusal.
- [x] **e2e-3** — `codex-roundtrip.spec.ts` — skips cleanly when `OPENAI_API_KEY`/`CQ_E2E_RUN_CODEX` is unset. All three in single commit (e2e).

**Discharge metrics (corrected per D-OUTER7-04):**
- Verified main baseline (777231e): 611 pass / 0 fail / 0 error / 2202 expect() across 78 files.
- Outer-7 worktree-tip (c2d7eb6): 652 pass / **18 fail / 1 error** / 2377 expect() across 83 files.
- Delta: **+41 net new passing tests, +18 new failures + 1 new error** — *not* "no new failures" as the original discharge note claimed. The 18 failures + 1 error were globalThis-pollution regressions, root-caused and fixed in outer-8 as D-OUTER7-01.
- `bun run e2e` (Playwright): **18 passed / 1 skipped / 0 failed.** Baseline was 16 / 0 / 0. Net +2 passing + 1 cleanly-skipped (`codex-roundtrip`).
- `defects.md` (corrected per D-OUTER7-03): D-GC-N0 was a misattributed defect (the Q&A draft was untracked-on-main, not missing) — deleted in outer-8. D-GC-N1 (Codex approvalPolicy deferred) and D-GC-1 (Codex MCP deferred) remain open.
- `tsc -b`: clean. `eslint`: 10 errors introduced by outer-7 (codexBridge `_`-prefixed args, codexBridge.test.ts `const self = this`), fixed in outer-8 D-OUTER7-01.

**Session log:** [`docs/logs/20260528-1432-gear-codex-log.md`](docs/logs/20260528-1432-gear-codex-log.md) (original); see also outer-8 log for the correction.

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
