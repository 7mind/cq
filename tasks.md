# cq — active task ledger

Status: `[ ]` planned · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Milestones (high-level)

- [x] **outer-11** — D-UNIFASYNC-01 + adversarial sweep for sync/async unions.
- [x] **outer-10** — close D-CQMCP-E2E + D-CQMCP-NIX (outer-9 follow-ups).
- [x] **outer-9** — D-GC-1 (Codex ledger MCP) + D-GC-N1 (approvalPolicy).
- (older milestones in this file)

---

## Milestone outer-11 — D-UNIFASYNC sweep — DISCHARGED

- [x] **D-UNIFASYNC-01** — `CodexFactory` tightened from `Codex | Promise<Codex>` to `Promise<Codex>` per the user's `feedback-uniform-async` rule. Three test factories (`codexBridge.test.ts:120`, `codexBridge-mcp.test.ts:49,98`) updated to `async (...): Promise<Codex> => …`. Adversarial sweep across outer-7..outer-10 for 8 related smells (module-level singletons, lazy-init races, hidden globals, eager construction, dispose drain, `Promise.race` cleanup, sync I/O hot paths) — all candidates either cleared as not-a-smell with explicit citation in the session log or scoped out as pre-existing patterns. Commit `<this>`. `bun run check`: 689/0; `bun run e2e`: 20/0/0; `bun run typecheck`: exit 0.

**Discharge metrics:** `bun run check` 689/0/2459 expect() (unchanged); `bun run e2e` 20/0/0 (unchanged); `bun run typecheck` exit 0; `defects.md` D-UNIFASYNC-01 flipped `[x] resolved`.

**Session log:** [`docs/logs/20260528-1800-unifasync-log.md`](docs/logs/20260528-1800-unifasync-log.md).

---

## Milestone outer-10 — PR breakdown — DISCHARGED

Sequence (one commit per PR; tags `cqmcp-nix-N`, `cqmcp-e2e-N`).

- [x] **cqmcp-nix-1** — extend `flake.nix` to include `packages/cq-mcp` + `packages/ledger` (and `packages/e2e`) in the FOD source fileset; refresh `outputHash`; materialise per-workspace `node_modules` for ledger + cq-mcp; symlink `@cq/ledger`+`@cq/cq-mcp` into server's `node_modules` + `.bin/cq-mcp`; add `$out/bin/cq-mcp` wrapper via `makeWrapper`. Commit `b47aa42`. `nix build .#default`: exit 0; `./result/bin/cq-mcp --help`: exits 0 with `--cwd required` message; full MCP `initialize` round-trip works.
- [x] **cqmcp-nix-2** — reorder `defaultResolveCqMcpBin` so `which cq-mcp` ($PATH lookup) wins over `node_modules/.bin/cq-mcp` (Nix-installed system bin must beat dev symlink). Added `whichOnPath()` helper (POSIX semantics: iterates `process.env.PATH`, stat+executable-bit check). Commit `5bddf76`. `bun run check`: 689/0.
- [x] **cqmcp-e2e-1** — unblock the codex bridge for actual use + add `POST /__e2e/settings` admin endpoint. Default `CodexFactory` switched from sync `require("@openai/codex-sdk")` (which threw "Cannot find module" — codex-sdk is ESM-only) to async dynamic `import()`; factory return type widened to `Codex | Promise<Codex>`; single call site awaits. New admin endpoint writes `ui_settings` synchronously so specs can pre-stage server-side defaults before the page opens. Commit `fa64b6c`. `bun run check`: 689/0.
- [x] **cqmcp-e2e-2** — ungate `codex-roundtrip.spec.ts` + add `codex-mcp-roundtrip.spec.ts`. `globalSetup.ts` symlinks `${realHome}/.codex` into the hermetic HOME AND sets `CODEX_HOME=${realHome}/.codex` on the cq-server subprocess (the codex CLI refuses `codex_home` under /tmp). New `fixtures/codexAuth.ts` exposes `hasCodexAuth()` (real auth check) and `pickCodexModel()` (reads `~/.codex/config.toml`'s top-level `model = "..."`, env override `CQ_E2E_CODEX_MODEL`). Both codex specs pre-stage server-side `ui_settings` + client `localStorage` (incl. `permissionMode=codex-danger-full-access` + `approvalPolicy=never` for the MCP spec so the CLI does not gate tool calls behind approval prompts) before opening the page. afterEach resets `ui_settings.model` to claude so subsequent specs do not inherit codex routing. The MCP spec asserts on-disk effect (`${CQ_E2E_CWD}/docs/codex-e2e-ledger.md` + `ledgers.yaml` entry) — authoritative signal that `cq-mcp` was actually spawned by the codex CLI and executed the tool call inside the cq server's --cwd. afterAll cleanup of the ledger file + registry entry keeps repeated runs green. Commit `<this>`.

**Discharge metrics:**
- `bun run check`: **689 pass / 0 fail / 0 error / 2459 expect()** across 86 files. Unchanged from outer-9 baseline.
- `bun run e2e` (Playwright): **20 passed / 0 skipped / 0 failed** (1.2m). Up from outer-9 baseline 18/1/0 by +1 from the new MCP spec and +1 from ungating the previously-skipped codex-roundtrip spec.
- `nix build .#default`: exit 0; `./result/bin/cq-mcp` is a working makeWrapper bin that serves the MCP stdio protocol (verified via JSON-RPC `initialize` round-trip).
- `tsc -b` clean; `eslint .` 0 errors / 23 warnings.
- `defects.md`: D-CQMCP-NIX + D-CQMCP-E2E flipped `[x] resolved` with shipping-artifact citations.

**Surprises / constraints future work must respect:**
- `@openai/codex-sdk@0.134.0` is ESM-only — never use sync `require()` to load it.
- The codex CLI **refuses to operate when `codex_home` resolves under /tmp**. Any test that uses a tmp HOME must override via `CODEX_HOME`.
- ChatGPT-account auth (the default on this machine) **rejects most explicit `--model <id>` values**. Tests should let the CLI pick its own default from `~/.codex/config.toml` rather than hard-coding `gpt-5.1`/`gpt-5` (which work only with API-key auth).
- The codex CLI **cancels MCP tool calls in default approval/sandbox mode**. To exercise MCP tools non-interactively, set `permissionMode=codex-danger-full-access` AND `approvalPolicy=never` (or use `--dangerously-bypass-approvals-and-sandbox` directly).
- `effort=none` → codex `reasoning.effort=minimal`, which the codex API rejects in combination with the default CLI tools (`image_gen`, `web_search`). Codex specs must set `effort >= low`.
- The server-side `ui_settings.model` overrides client localStorage on every reconnect via `settings.get_result`. Tests that need a specific routing must stage server-side via `POST /__e2e/settings` (added in cqmcp-e2e-1), not just client localStorage.

**Session log:** (orchestrator-only run; commits + this completed entry are the durable record.)

---

## Active — outer-9 (defect-closure: D-GC-1 + D-GC-N1) — DISCHARGED

**Cycle:** outer-9 / defect-closure on D-GC-1 (Codex ledger MCP via external stdio binary) + D-GC-N1 (Codex approvalPolicy popup row).
**Goal:** Ship `packages/cq-mcp` stdio MCP binary that exposes the 12 `mcp__cq__*` ledger tools; wire `CodexBridge` to spawn it per session through `CodexOptions.config.mcp_servers.cq`. Expose Codex `approvalPolicy` (4-value enum) as a second gear-popup row when platform=codex; persist on session row via migration #7; plumb through `ChatStart`; forward in `ThreadOptions.approvalPolicy`.
**Baseline (verified worktree f5d02d7):** `bun test` → 672 pass / 0 fail / 0 error / 2418 expect() across 84 files. `tsc -b` clean. `bun run e2e` (per outer-8 ledger): 18 passed / 1 skipped.
**Defects:** [`./defects.md`](./defects.md).

## Active — outer-9 (defect-closure: D-GC-1 + D-GC-N1)

Sequence (one commit per PR; tags `cq-mcp-N`, `gc1-N`, `gcn1-N`):

- [x] **cq-mcp-1+2+3** — new `@cq/cq-mcp` workspace + `src/main.ts` stdio binary + `test/main.test.ts` end-to-end via the MCP `Client`. Pinned `@modelcontextprotocol/sdk@1.29.0`. Bin linked at `packages/server/node_modules/.bin/cq-mcp` after adding `@cq/cq-mcp` to server's deps. Schemas mirror `packages/ledger/src/mcp/ledgerTools.ts`; `ask_user_question` deliberately not exposed (deferred — needs WS bridging). Commit `7e3f693`. `bun run check`: 675/0.
- [x] **gc1-1** — `CodexBridge` per-session construction wires `CodexOptions.config.mcp_servers.cq = { command, args: […, "--cwd", cwd] }`. `defaultResolveCqMcpBin()` walks `node_modules/.bin/cq-mcp` with bun-source fallback. Factory signature widened to `(options?: CodexOptions) => Codex`. Test in `codexBridge-mcp.test.ts` asserts both explicit-bin and default-resolver paths. Commit `f2c5f61`. `bun run check`: 677/0.
- [x] **gc1-2** — README.md notes the `cq-mcp` bin prerequisite for Codex-ledger sessions. D-GC-1 closed in `defects.md` with shipping-artifact citations. Follow-ups filed: `D-CQMCP-NIX` (Nix closure verification) and `D-CQMCP-E2E` (codex-roundtrip MCP step when auth is available).
- [x] **gcn1-1** — Migration #7 (`approval_policy TEXT NULL`), `SessionRow` + `HistoryRow` Zod, both adapters' insert/update/JOIN, persist-crud round-trip + update + history-join tests. Commit `688037e`. `bun run check`: 683/0.
- [x] **gcn1-2** — `ChatStart.approvalPolicy` optional Zod field; facade refusal on Claude + non-null; `CodexBridge` forwards to `ThreadOptions.approvalPolicy` and persists on the session row. Tests in `codexBridge.test.ts` and `bridge.test.ts`. Commit `a8760e8`. `bun run check`: 686/0.
- [x] **gcn1-3** — `SettingsPopup` renders the platform-gated "Approval policy" row (4 SDK values, default `on-request`); `ChatTab` hydrates from `localStorage['cq.codex.approvalPolicy']`, threads through Header, spreads onto every `chat.start` via `approvalPolicyFor(model, value)`. Tests in `settingsPopup.test.ts`. D-GC-N1 closed in `defects.md`.

**Inner-loop discipline:** Each PR is one commit. Each PR's verification is run before its commit. `bun run check` must remain 0 between PRs except mid-`cq-mcp-1` where new package types are wired (we still gate at the next commit boundary).

**Discharge metrics:**
- `bun run check`: **689 pass / 0 fail / 0 error / 2459 expect()** across 86 files. Up from baseline 672/0 by +17 new tests, +2 new files (`cq-mcp/test/main.test.ts`, `server/test/codexBridge-mcp.test.ts`).
- `bun run e2e` (Playwright): **18 passed / 1 skipped / 0 failed** — unchanged from outer-8 baseline.
- `tsc -b` clean; `eslint .` 0 errors.
- `defects.md`: D-GC-1 + D-GC-N1 closed; D-CQMCP-NIX + D-CQMCP-E2E filed.

**Session log:** [`docs/logs/20260528-1500-outer9-log.md`](docs/logs/20260528-1500-outer9-log.md).

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
