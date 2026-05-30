# cq — active task ledger

Status: `[ ]` planned · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Cycle: activity-indicator — aggregate top-bar BUSY (N) badge

Plan: [`docs/drafts/20260530-1700-activity-indicator-plan.md`](docs/drafts/20260530-1700-activity-indicator-plan.md).
Worktree `.claude/worktrees/activity-indicator`, branch `activity-indicator`, base `da42222`.
Baseline (verified da42222): `bun test` 1120 pass / 0 fail; e2e 28/28.
No Task tool → plan / adversarial-review / execute / review run inline as distinct steps.

The top-bar badge must reflect ALL active compute (interactive chat turn AND `/plan`
workflow phase dispatches), not just the chat session, and show a count: `BUSY (N)`.
`N = (chat turn streaming ? 1 : 0) + (in-flight workflow phase dispatches)`. A workflow
PARKED on answers contributes 0. Defect: ACTIVITY-01.

### Milestone M-ACTIVITY — PR breakdown (single buildable commit)

- [x] **activity-1** (commit <this>) — protocol `activity.status` + WorkflowRuntime
  `activeDispatchCount`/`onActivityChange` + backend-bridge `onBusyChange`/`isTurnInFlight`
  + server `AggregateActivityTracker` + WS sink wiring (server.ts/devServer.ts) + web
  SessionContext.running/ChatTab branch/Header badge. ONE commit — concerns interwoven
  across protocol/server/web; a per-file split would not compile cleanly. D01–D06 in the
  plan doc.

**M-ACTIVITY CLOSED.** Discharge: `bun run check` exit 0 ×2 (1156/0 both; baseline 1120
+ 36 new tests); `bun run e2e` 28/28 (3 consecutive clean full runs); `nix build .#default`
exit 0 (cq-0.0.1; local fallback, remote SSH builder unreachable). Adversarial review
opened+resolved ACTIVITY-01-D01 (per-turn vs session-busy chat signal) and ACTIVITY-01-D02
(e2e BUSY-transient flake → robust MutationObserver + end-state assertion + deterministic
web-level proof). Metrics: review rounds 1 (inline); defects {major:1, minor:1}; verification
complete; scope delta — added `isTurnInFlight()` to the backend interface + both backends
(not foreseen in the plan; surfaced by adversarial review of the multi-turn streaming model).

## Completed

- **activity-1** (2026-05-30) — Aggregate top-bar `BUSY (N)` activity badge. The badge now
  reflects ALL active compute: `running = (chat turn streaming ? 1 : 0) + (in-flight /plan
  workflow phase dispatches)`. What shipped: (1) `activity.status{running}` server→client
  Zod frame; (2) `WorkflowRuntime.activeDispatchCount()` + `onActivityChange()` derived from
  the `active` dispatch slot via a single `setActive` helper wrapping every assignment;
  (3) per-backend `isTurnInFlight()` + `onBusyChange` (claude: a `turnInFlight` flag toggled
  at turn start / `sendDone`; codex: `abortController !== null`) routed through `setActive`/
  `setTurnInFlight`/`setTurnAbort` helpers so every transition notifies; (4) a server-side
  `AggregateActivityTracker` summing the lanes + pushing on connect and on every change
  (de-duped on the summed value); (5) WsSession sink wiring + server.ts (both lanes) /
  devServer.ts (chat-only); (6) web SessionContext.running + ChatTab `activity.status` branch
  + Header badge `running > 0 → "BUSY (N)"`. Verification: `bun run check` exit 0 ×2 (1156/0);
  `bun run e2e` 28/28 (×3); `nix build .#default` exit 0.
  Notes / surprises:
  - WHAT COUNTS (justification): `activeDispatchCount` derives from `this.active` (dispatch-
    start → submit/settle = "model working"), NOT `pendingTeardowns` (post-submit subprocess
    reap; the model is already done, so counting it would leave the badge stuck BUSY).
  - PER-TURN, not per-session (ACTIVITY-01-D01): the chat lane's `isBusy()` = `active !== null`
    stays true for the WHOLE multi-turn streaming session (the `query()` stays open across
    turns; `active` clears only on shutdown). Feeding it to the badge would show BUSY between
    turns while idle. Fixed by a distinct per-turn `isTurnInFlight()` (false between turns,
    true while a turn streams) feeding the tracker; `isBusy()` keeps its pool=1 preempt
    semantics untouched. Future work touching the bridge must preserve this distinction.
  - E2E transient (ACTIVITY-01-D02): the badge BUSY now lags the send by one round-trip and
    can coalesce in a single React batch against the instant mock — the sub-frame "BUSY (1)"
    transient is not deterministically observable. The strict label assertion lives in the
    deterministic web unit test `activity-badge.test.ts`; the e2e asserts end-state IDLE +
    validates any painted busy label is "BUSY (1)".
  - CONSTRAINT preserved: the tracker only OBSERVES the two lanes (injected read functions +
    change callbacks); it never routes the workflow through the Bridge and never changes
    pool=1. No loop/phase/recorder/ledger/divergence-guard semantics were touched.

### Cross-cutting architectural notes (locked)

- [x] "running" counts ACTIVE DISPATCH (`this.active`, dispatch-start→submit/settle), NOT
  `pendingTeardowns` (post-submit subprocess reap) — the model is done by reap-time, so
  counting it would leave the badge stuck BUSY. Justification in the plan doc § A.
- [x] Push-on-every-transition guaranteed by a single `setActive()` helper per lane that
  wraps EVERY `this.active = …` assignment and fires the change callback — no raw
  assignment can bypass the notification.
- [x] Observe-only: the tracker NEVER routes the workflow through the Bridge and NEVER
  changes pool=1; it only reads the two lanes' busy signals via injected functions.
- [x] devServer (HMR, no WorkflowRuntime) wires a chat-only ActivityTracker so the badge
  still shows BUSY during a chat turn there.

---

## Cycle: pcontent — `/plan` planning CONTENT visible + explore-once

Plan: [`docs/drafts/20260530-1620-plan-content.md`](docs/drafts/20260530-1620-plan-content.md).
Worktree `.claude/worktrees/planning-content`, branch `planning-content`, base `2bb2c4b`.
Baseline (verified 2bb2c4b): `bun test` 1109 pass / 0 fail; e2e 28/28.
VSM-loop driver; no Task tool in this harness → plan / adversarial-review / execute /
review run inline as explicit distinct steps. WF-HIST-02 (empty Detail / Q&A
transcript) + PLAN-EXPLORE-01 (explore-once) from live dogfood.

Two defects + one optimization:
1. WF-HIST-02a — opening a `/plan` run's History Detail shows EMPTY (the WF-HIST
   cycle records session+invocations but writes NO event rows, so replay has
   nothing). Fix: forward each phase subagent's SDK message stream (reasoning,
   submit tool_use, result) as events under that phase's child invocation.
2. WF-HIST-02b — answered questions are not in the planning transcript. Fix:
   synthetic asked/answered events under the run root.
3. PLAN-EXPLORE-01 — every phase re-explores the repo (cost+latency, the cause of
   PHASE-TIMEOUT-01). Fix: producer explores ONCE + emits a `grounding` summary;
   later phases receive it + a softened explore instruction.

### Milestone M-PCONTENT — PR breakdown

- [x] **pcontent-1+2+3** (commit 622d5f2) — Recorder event sink + Q&A transcript +
  explore-once grounding (delivered as ONE buildable commit — the three concerns
  are interwoven across `workflowRuntime.ts`/`producer.ts`/`phases.ts`, so
  splitting by file would produce non-compiling intermediate commits).
- [x] **pcontent-4** (commit <this>) — E2E (`/plan` mocked → open run in History →
  producer Detail NON-empty + root Detail shows Q&A; prelude project per WFL-D02)
  + discharge.

**M-PCONTENT CLOSED.** Discharge: `bun run check` exit 0 ×2 (1120/0 both;
baseline 1109 + 11 new tests; one pre-existing heartbeat timing flake observed
once under full-suite load on run 1, isolated 3/3 green, did not recur on run 2 —
not in this cycle's scope); `bun run e2e` 28/28 (extended `plan-workflow-history.spec.ts`
in-place — no count delta); `nix build .#default` exit 0 (`result` → cq-0.0.1;
local build, remote SSH builder unreachable). Defects `WF-HIST-02` (empty Detail /
Q&A transcript) + `PLAN-EXPLORE-01` (explore-once) resolved. Session log:
`docs/logs/20260530-1620-log.md`. GOALS_SCHEMA gained `grounding` → existing dev
`docs/goals.md` needs `cq reset` once (gitignored, regenerable).

### Cross-cutting architectural notes (locked) — M-PCONTENT

- [x] Events written DIRECTLY via Persistence inside the recorder — never via the
  Bridge/SessionRegistry (pool=1 holds, same as WF-HIST). Proven by the dual-adapter
  content test reading events via `persistence.events.readAll` + the existing
  pool=1 regression tests staying green.
- [x] `grounding` stored on the GOAL (GOALS_SCHEMA field) — natural durable home,
  re-read by every phase via the existing goal fetch, survives restart for free.
  Cost: divergence-guard schema change → existing dev `docs/goals.md` needs
  `cq reset` (noted; gitignored/regenerable).
- [x] Any new structured field is in BOTH the advertised submit schema AND the
  validated schema (GOAL-TITLE-01 — SDK strips to advertised shape). Guarded by the
  real-SDK MockAnthropic integration test (grounding round-trips onto the goal).
- [x] Event sink + recorder appends are best-effort (swallow+warn) + never gate
  control flow; `grounding` is OPTIONAL so a stripped field degrades to "", not a
  validation failure; uniform-async throughout, no sync/async unions.

### Completed (M-PCONTENT)

- **pcontent-1+2+3** (2026-05-30, commit 622d5f2) — see defects `WF-HIST-02` +
  `PLAN-EXPLORE-01` for the full shipped description. Surprise: the phase-1 "asked"
  event had to be recorded from `startPlan` (after `linkGoal`/`runHandles.set`
  cache the handle), NOT inside `writeArtifacts` — at `writeArtifacts` time the
  goalId→run link is not yet persisted, so `runHandleFor` would resolve undefined
  and the asked event would be silently dropped. Continuation/clarify/review write
  sites are safe (handle already cached). R3 (close-before-`result` race) resolved
  by the reopen-on-append property of `SqliteEventLog.fdFor` — proven in the e2e
  (the producer Detail shows the post-submit "submitted" text, appended AFTER
  `closePhaseEvents`).
- **pcontent-4** (2026-05-30) — extended `plan-workflow-history.spec.ts` in-place
  (kept it in the prelude project — its `testMatch` already includes `-history`):
  added `grounding` to the producer submit payload, then clicks the producer child
  row → asserts `detail-body` contains "submitted" (NON-empty replay; before this
  cycle the Detail was empty), and clicks the root row → asserts the Detail shows
  "Asked 1 clarifying question" + the question text (Q&A visible). Discharge above.

---

## Cycle: reset — `cq reset` subcommand + humane bootstrap-divergence startup error

Plan: [`docs/drafts/20260530-1545-cq-reset.md`](docs/drafts/20260530-1545-cq-reset.md).
Baseline (verified 5d0408c): `bun run check` exit 0, 1077 pass / 0 fail; e2e 28/28.
Loop serialised (no subagent-dispatch in this harness); adversarial review
run as an explicit per-PR step.

Changing a bootstrapped ledger's canonical schema makes `FsLedgerStore.init()`
throw `BootstrapViolationError` against an existing old-schema `docs/<ledger>.md`
— today a raw stack trace. The bootstrap files are GITIGNORED, REGENERABLE.
`cq reset` clears them (manual confirmation; backup by default); the startup
error becomes actionable and points at `cq reset`. Artifact set derived from
`@cq/ledger` `CANONICAL_LEDGERS` (single source of truth), never hardcoded.

### Milestone M-RESET — PR breakdown

- [x] **reset-1** — Arg layer: `parseInvocation` discriminated union (`server` | `reset`) + `ResetOpts` (`cwd`, `yes`, `backup`). `reset` first-positional → reset; else delegate to existing `parseArgs` → server. Usage text. Routing unit tests.
- [x] **reset-2** — `reset.ts`: bootstrap artifact-set from CANONICAL_LEDGERS; list/backup/delete; injected `confirm`/`now`/IO; non-TTY refusal (no hang); backup to `docs/.ledger-backup/<iso>/` preserving layout. Tests drive `runReset` directly.
- [x] **reset-3** — Humane startup error wrapper `ledgerInit.ts` (catch `BootstrapViolationError` → actionable stderr msg + non-zero exit, no stack trace; rethrow others); wire into server.ts + devServer.ts; main.ts routing switch. `.gitignore` += `docs/.ledger-backup/`. Wrapper tests.
- [x] **reset-4** — Discharge: `bun run check` ×2, `bun run e2e`, `nix build .#default`, closure smoke `./result/bin/cq reset --cwd /tmp/probe --yes`, manual scenario + session log, defect RESET-01.

**M-RESET CLOSED.** Discharge: `bun run check` exit 0 ×2 (1097/0 both; +20 tests over the 1077 baseline; one pre-existing happy-dom web flake observed once, did not recur across 5 subsequent full runs); `bun run e2e` 28/28; `nix build .#default` exit 0 (local build, remote SSH builder unreachable); closure smoke `./result/bin/cq reset --cwd <probe> --yes` backs up 9 files + exits 0 without starting a server. Defects `RESET-01` (feature) + `RESET-02` (closure-source-inclusion, caught by the smoke) resolved. Session log: `docs/logs/20260530-1545-log.md`.

### Completed (M-RESET)

- **reset-1** (2026-05-30) — `parseInvocation` discriminated union in `args.ts`. The `cq` binary is `bun run main.ts -- <args>`, so `process.argv.slice(2)` carries the user args; `reset` is recognised ONLY as the first positional (`--cwd reset` stays a server invocation, cwd="reset"). Server path delegates to the byte-unchanged `parseArgs`. Usage text extended; a separate `RESET_USAGE`. 8 routing tests (server/reset discrimination, reset-flag parsing, first-token-only, unknown-reset-flag exit 1, frozen objects). Verification: `bun test args.test.ts` 17/17.
- **reset-2** (2026-05-30) — `reset.ts` `runReset(opts,deps)` — returns an exit code, never calls `process.exit`; all IO via injected `deps` (`stdout`/`stderr`/`confirm`(async)/`now`/`stdinIsTty`). `collectArtifacts(docsDir)` derives the set from `@cq/ledger` `CANONICAL_LEDGERS`: ledgers.yaml, each `<ledger>.md`, `archive/<ledger>/` ONLY where the basename matches a canonical ledger AND it is a directory (uses `fs.lstat`, so a same-named flat file is excluded), and `.locks/`. Backup default = MOVE to `docs/.ledger-backup/<iso>/` preserving relative layout (`fs.rename` with EXDEV copy+rm fallback); `--no-backup` hard-deletes. Confirmation gate: `--yes` skips; non-TTY without `--yes` → refuse exit 1 (no stdin read → no hang); else `defaultConfirm` reads one line (`y`/`yes` → proceed; empty/EOF → abort exit 0). 8 tests against per-test `mkdtemp` cwds prove backup/no-backup/abort/--yes/non-TTY-refuse/nothing-to-reset/flat-file-exclusion AND that seeded `docs/drafts/x.md` + flat `docs/archive/tasks-M0.md` survive. Surprise: a real `archive/<ledger>/` subdir does not exist in this repo's `docs/archive` (only tracked flat `tasks-M*.md`), so the directory-vs-flat distinction is the load-bearing safety invariant — covered with a dedicated test + a real-dir end-to-end probe.
- **reset-3** (2026-05-30) — `ledgerInit.ts` `initLedgerStoreOrExit(store,deps)` catches ONLY `BootstrapViolationError`, extracts the diverged ledger name from the throw-site message via regex, prints an actionable `cq reset` instruction (naming the ledger + `docs/<name>.md`) to stderr, exits 1 — NO stack trace; every other error propagates unchanged (asserted by identity). Wired into both `server.ts` and `devServer.ts` (replacing the bare `await ledgerStore.init()`). `main.ts` switches on the invocation kind and runs the reset path (default stdin-line `confirm`, real clock, `process.stdin.isTTY` gate) before any server code. `.gitignore` += `docs/.ledger-backup/`. 4 wrapper tests (success pass-through, BootstrapViolationError → actionable+exit1+no-stack-markers, non-bootstrap error propagates unreformatted, generic-guidance fallback). End-to-end: a real `bun run main.ts` boot against a hand-staled `goals` schema printed the actionable message + exited 1; after `cq reset --yes` the next boot regenerated a valid schema and logged "cq listening" then clean-shutdown.
- **reset-4** (2026-05-30) — Discharge (see M-RESET CLOSED above). The closure smoke surfaced `RESET-02`: the `cq` flake derivation builds from the git-tree source, so the still-untracked `reset.ts`/`ledgerInit.ts` were omitted from the first closure (`Cannot find module './reset'`); `git add` + rebuild fixed it. Constraint future work must respect: any NEW source file must be `git add`-ed before `nix build` or the closure silently omits it.

### Cross-cutting architectural notes (locked) — M-RESET

- [x] Subcommand detection in the arg layer (`parseInvocation`), NOT in main.ts ad-hoc — server path delegates to existing `parseArgs` unchanged.
- [x] Bootstrap artifact set derived from `@cq/ledger` `CANONICAL_LEDGERS` — single source of truth; never a hardcoded stale list.
- [x] `runReset` takes injected `cwd` / `confirm` (async) / `now` / IO sinks — fully testable; no sync/async unions; default `confirm` refuses (no hang) on non-TTY without `--yes`.
- [x] Backup is the default (`MOVE` to `docs/.ledger-backup/<iso>/`); `--no-backup` hard-deletes. `docs/.ledger-backup/` gitignored.
- [x] `docs/archive/<name>/` removed ONLY where `<name>` exactly matches a canonical ledger; flat `docs/archive/tasks-M*.md` NEVER touched.

---
## Cycle: phase-timeout — raise /plan phase-dispatch timeout to 300s + env override

Plan: [`docs/drafts/20260530-1553-phase-timeout.md`](docs/drafts/20260530-1553-phase-timeout.md).
Worktree `.claude/worktrees/phase-timeout`, branch `phase-timeout`, base `5d0408c`.
Baseline (verified 5d0408c): `bun test` 1077 pass / 0 fail; e2e 28/28.
Symptom fix only — explore-once optimization is a SEPARATE later cycle (out of scope).

### Milestone M-PHASE-TIMEOUT — PR breakdown

- [x] **pt-1** — shared `resolvePhaseTimeoutMs` helper (default 300_000, env
  `CQ_WORKFLOW_PHASE_TIMEOUT_MS`); wire all three lanes (claudeProducer,
  claudePhaseSubagent, codexHeadless); update doc-comments; tests (helper unit +
  per-lane default/env/opt-precedence, env set/restore); discharge
  (`bun run check` ×2, `bun run e2e` 28/28, `nix build .#default`).

**M-PHASE-TIMEOUT CLOSED.** Discharge: `bun run check` exit 0 ×2 (1089/0 both;
baseline 1077 + 12 new); `bun run e2e` 28/28 (mock injected timeouts unaffected,
1.8m); `nix build .#default` exit 0 (cq-0.0.1; local fallback, remote SSH builder
unreachable). Defect `PHASE-TIMEOUT-01` resolved (+ self-review
`PHASE-TIMEOUT-01-D01` resolved same cycle). Session log:
`docs/logs/20260530-1553-log.md`.

### Cross-cutting architectural notes (locked)

- [x] ENV-only override (no CLI flag / no `args.ts`/`main.ts`/`server.ts`) —
  in-flight cq-reset cycle owns those; ENV avoids the merge conflict.
- [x] Resolution order: explicit `opts.timeoutMs` → valid `CQ_WORKFLOW_PHASE_TIMEOUT_MS` → 300_000.
- [x] No sync/async unions; helper is pure-synchronous (env read is sync).

### Completed (M-PHASE-TIMEOUT)

- **pt-1** (2026-05-30) — Raised the /plan phase-dispatch timeout 120_000 →
  300_000 across all three headless lanes, centralized in a new shared
  `resolvePhaseTimeoutMs(optTimeoutMs?, env=process.env)` helper
  (`packages/server/src/workflow/phaseTimeout.ts`): `DEFAULT_PHASE_TIMEOUT_MS =
  300_000`, `PHASE_TIMEOUT_ENV_VAR = "CQ_WORKFLOW_PHASE_TIMEOUT_MS"`. Resolution
  order per dispatch: explicit `opts.timeoutMs` → valid env (positive integer;
  `""`/whitespace/non-numeric/≤0/float/`1e3`/`0x10`/overflow → default) →
  300_000. Wired `claudeProducer`, `claudePhaseSubagent`, and `codexHeadless`
  (`dispatchCodexPhase`) to the helper; the two Codex wrappers
  (`codexProducer`/`codexPhaseSubagent`) pass `timeoutMs` through to the shared
  dispatch so resolution happens ONCE. Removed the dead `DEFAULT_CODEX_TIMEOUT_MS`
  barrel re-export (no consumers). Doc-comments updated. Verification:
  `bun run check` exit 0 ×2 (1089/0 both); `bun run e2e` 28/28; `nix build .#default`
  exit 0. Metrics: review rounds 1 (self-review); defects major:1, minor:0, nit:1;
  verification complete; scope delta: touched 2 extra files beyond the named three
  (`codexProducer.ts`/`codexPhaseSubagent.ts` doc-comments + `index.ts` barrel) —
  all within the workflow package, no forbidden files.
  Notes / surprises:
  - The two named-in-brief Codex files (`codexProducer`, `codexPhaseSubagent`)
    only carried STALE doc-comments ("Defaults to 120_000"); the actual codex
    timeout resolution lives in `dispatchCodexPhase` (codexHeadless) — they pass
    `timeoutMs` through only when explicitly set, so the env/default resolution is
    correct without touching their logic.
  - e2e specs inject short `timeoutMs` via the mock, so the default bump does not
    slow them (confirmed 28/28 in 1.8m) — do NOT add a wall-clock assertion on the
    300_000 default in any test (the wiring tests prove resolution via a tiny env
    value + a never-ending subagent, never by waiting out the default).
  - **FOLLOW-UP (separate later cycle, OUT OF SCOPE here):** every phase
    re-explores the repo from scratch (redundant latency + token cost). Real fix =
    explore once in the producer, pass grounding context to later phases. This
    cycle only raised the timeout (symptom fix). Documented in
    `PHASE-TIMEOUT-01`.
  - Self-review opened+closed `PHASE-TIMEOUT-01-D01` (nit): hardened the wiring
    test's env snapshot from a per-`setEnv`-call snapshot to an unconditional
    `beforeEach` snapshot (latent cross-test footgun, not a live leak).

---

## Cycle: dark — real, app-wide dark theme (light/dark/auto, gear toggle)

Plan: [`docs/drafts/20260530-1442-dark-theme.md`](docs/drafts/20260530-1442-dark-theme.md).
Baseline (verified eff0ca5): `bun run check` exit 0, 1059 pass / 0 fail; e2e 27/27.
WEB-ONLY. Loop serialised (no subagent-dispatch in this harness); adversarial
review run as an explicit per-milestone step.

`[data-theme="dark"]` on `<html>` overrides CSS variables; `auto` resolved in
JS via `matchMedia` + live OS listener; default auto. Toggle in the gear popup,
applied live + persisted (`localStorage['cq.theme']`). Sweep of ~28 CSS modules
onto the variables so dark applies app-wide; light resolved colors unchanged.

### Milestone M-DARK — PR breakdown

- [x] **dark-1** — global.css dark variable set (`[data-theme="dark"]` + new semantic vars, light :root unchanged) + `lib/theme.ts` controller (localStorage `cq.theme`, matchMedia resolve + live OS listener, sets `documentElement.dataset.theme`, `initTheme()` in main.tsx before first paint).
- [x] **dark-2** — Theme control (Light/Dark/Auto) in SettingsPopup, applied live via the controller (display-only; not in ChatStart/session state).
- [x] **dark-3** — CSS sweep: ~28 modules' hardcoded theme-sensitive hex/rgb → theme vars (chips get light+dark pairs; light-neutral).
- [x] **dark-4** — tests (theme.ts, SettingsPopup theme, sweep assertion, light-unchanged) + e2e (`dark-theme.spec.ts`, main project) + discharge.

**M-DARK CLOSED.** Discharge: `bun run check` exit 0 ×2 (1077/0 both; baseline 1059 + 18 new dark tests); `bun run e2e` 28/28 (baseline 27 + 1 new `dark-theme.spec.ts`); `nix build .#default` exit 0 (`result` → cq-0.0.1; local build, remote SSH builder unreachable). Defect `DARK-01` resolved (+ self-review `DARK-01-D01` resolved same cycle). Session log: `docs/logs/20260530-1442-log.md`.

### Cross-cutting architectural notes (locked)

- [x] Mechanism = `data-theme` on `<html>` + `[data-theme="dark"]` CSS overrides + JS auto-resolution with live OS listener (per brief DECISIONS).
- [x] Theme is a display pref: localStorage + DOM only, NEVER ChatStart/session row (WEB-ONLY constraint).
- [x] theme.ts is fully synchronous (DOM + localStorage are sync) — no sync/async unions.
- [x] Light `:root` values stay byte-identical; sweep proven light-neutral by computed-value comparison, not source text.

### Completed (M-DARK)

- **dark-1** (2026-05-30) — Dark variable set + theme controller.
  global.css: `:root` light values UNCHANGED; added ~30 new semantic vars
  (base extras, accent variants, code chrome, solid button bgs, info-card,
  6 chip bg/text pairs) with light values, plus a full `[data-theme="dark"]`
  override block for every theme var, plus `color-scheme` hints. `lib/theme.ts`:
  fully-synchronous controller — `ThemeMode = light|dark|auto` (default auto),
  `readThemeMode`/`writeThemeMode` (localStorage `cq.theme`, validated,
  try/catch), `resolveTheme(mode, prefersDark)`, `applyResolvedTheme` (sets
  `documentElement.dataset.theme`), `createThemeController({mql})` (injectable
  media-query-list for tests; attaches a live `change` listener that re-resolves
  only while mode==='auto'), module-singleton `initTheme()`/`getThemeController()`
  + `resetThemeControllerForTests()`. main.tsx calls `initTheme()` before
  `createRoot().render` (before first paint). No sync/async union (all sync).
  Verification: `bun run typecheck` exit 0; `bun run lint` 0 errors (24
  pre-existing warnings); `bun test` 1059 pass / 0 fail (no regression).
  Adversarial review: no defects — equal-specificity `:root` vs
  `[data-theme="dark"]` resolves by source order (dark later → wins when attr
  present); fallbacks inert once vars defined (light-unchanged proven by
  resolved value, not fallback); mql injectable so tests don't depend on
  happy-dom matchMedia.
  Metrics: review rounds 1; defects 0; verification complete; scope delta none.

- **dark-2** (2026-05-30) — Theme control in the gear popup, applied live.
  SettingsPopup gains a Theme `<select>` (Light / Dark / Auto-OS) at the top,
  separated by a `.divider` from the per-session rows (so the "next new chat"
  hint clearly governs only those). Threaded `themeMode` + `onThemeModeChange`
  through Header → SettingsPopup. ChatTab owns `themeMode` (seeded from
  `readThemeMode()`); `handleThemeModeChange` calls
  `getThemeController().setMode(mode)` (live apply + persist to localStorage +
  `<html data-theme>`) then mirrors into the controlled select. The theme value
  is display-only — NEVER carried into ChatStart/session state (WEB-ONLY).
  Updated existing `header.test.ts` + `settingsPopup.test.ts` defaultProps with
  the two new props. SettingsPopup chrome stays a fixed dark popup (preserves
  light-mode appearance) — flagged as a dark-3 exception. Verification:
  typecheck 0; `bun test` 1059 pass / 0 fail (no regression).
  Adversarial review: no code defects. Note for dark-4: the popup live-apply
  test must drive a real controller (`getThemeController()` fail-fasts if
  `initTheme()` was never called — intentional).
  Metrics: review rounds 1; defects 0; verification complete; scope delta none
  (touched Header/ChatTab as planned for prop-threading).

- **dark-3** (2026-05-30) — The CSS sweep. 23 CSS files changed (22 modules +
  global.css). global.css grew to 118 theme variables, each with a `:root`
  (light, unchanged) and `[data-theme="dark"]` value (verified full parity).
  Swept every theme-sensitive hardcoded hex/rgb in the content-surface modules
  onto variables via the `var(--name, #originalLiteral)` form (fallback = the
  exact prior literal, kept inert). Status/severity chips got light+dark bg+text
  pairs (`--chip-*`); GitHub code chrome → `--surface-code`/`--border-code`/
  `--text-code`/`--text-code-muted`; colored cards → `--violet-card-*` /
  `--info-*` / `--warn-card-*` / `--plan-card-*`; solid buttons →
  `--surface-success`/`--surface-danger`/`--surface-neutral`/`--btn-*` +
  `--on-accent`; bubbles → `--user-bubble-*`/`--tool-bubble-bg`.
  UNTOUCHED (6): Header, Tooltip, Toast, SettingsPopup chrome, Indicator —
  intentional always-dark chrome / semantic connection-state dot colors
  (changing them would alter the light-mode appearance); SearchBar + Stream —
  already fully variable-driven. Also kept literal as documented exceptions:
  History `.resumeButton` (dark VS-Code button on a light table) and the
  ElicitationCard `rgba(5,80,174,0.15)` focus glow (translucent, theme-neutral).
  Shiki code bodies render `github-dark` always (pre-existing, in CodeBlock.tsx)
  — dark in both themes by design; only the container chrome was swept.
  LIGHT-UNCHANGED proven by a scripted audit: every `var(--X,#fb)` fallback
  added by this branch has `#fb == :root[--X]` (0 mismatches), so resolved-light
  == original literal everywhere. DARK-APPLIES proven by: 118 vars with full
  light/dark parity + the bundled `main.css` (built via `buildWeb()`) containing
  `[data-theme="dark"]`, `--surface-code`, `--chip-success-bg`, and dark
  `--bg:#121212`.
  Self-review opened + resolved DARK-01-D01 (8+ light-shift unifications →
  exact-match vars). Verification: typecheck 0; lint 0 errors; `bun test`
  1059 pass / 0 fail (one cross-file DOM-pollution flake in attachments Case 4
  passed on re-run + in isolation — pre-existing nondeterministic test ordering,
  see registerDom helper docs, not caused by this change); `buildWeb()` compiles
  all CSS modules.
  Metrics: review rounds 1 (self); defects 1 major (DARK-01-D01, resolved same
  cycle); verification complete; scope delta: +~80 semantic vars beyond the
  plan's initial list (expected — "add missing vars the modules need").

- **dark-4** (2026-05-30) — Tests + e2e + discharge. New unit tests:
  `theme.test.ts` (11 tests — persist/read `cq.theme`, auto resolves via an
  INJECTED matchMedia mock both directions, sets `documentElement.dataset.theme`,
  re-resolves live on an OS-change event while auto, explicit light/dark override
  the OS + ignore OS events, setMode applies+persists, dispose detaches);
  3 new SettingsPopup tests (Theme control renders Light/Dark/Auto, fires
  onThemeModeChange, and — wired to a REAL controller — flips
  `document.documentElement.dataset.theme` live); `darkSweep.test.ts` (4 tests:
  `:root`+`[data-theme=dark]` parity for all 118 vars; LIGHT-UNCHANGED —
  every module `var(--X,#fb)` fallback equals `:root[--X]`, modulo a 9-entry
  allow-list of PRE-EXISTING inert baseline fallbacks; sweep completeness — no
  content module hardcodes a known light surface hex, with the documented
  exceptions). e2e `dark-theme.spec.ts` (main project): gear→Theme=Dark →
  asserts `<html data-theme="dark">` AND `getComputedStyle(body).backgroundColor`
  luminance < 80 (genuinely dark, not white) + localStorage persisted →
  Theme=Light → luminance > 200 and > dark+100 + persisted. Auto/OS-dark is
  unit-only (matchMedia mock) — noted in the spec + plan (Playwright can't drive
  the live OS scheme through the same path).
  Discharge: `bun run check` exit 0 ×2 (1077/0 both — deterministic); `bun run
  e2e` 28/28; `nix build .#default` exit 0 (cq-0.0.1; local fallback). Manual
  scenario (operationalized by the tests, not run by hand): OS-dark→auto-dark =
  theme.test "auto resolves to dark when OS is dark"; gear Light/Dark live =
  e2e + SettingsPopup wired test; reload-persists = e2e localStorage assertion +
  controller reading `readThemeMode()` on init. Goals/History/Chat dark
  correctness follows from the sweep (all their surfaces route through the swept
  vars; the e2e samples the shared `--bg` surface).
  Metrics: review rounds 1 (self); defects 0; verification complete; scope delta
  none.

---

## Cycle: workflow-history — `/plan` runs visible in the History tab

Plan: [`docs/drafts/20260530-1358-workflow-history.md`](docs/drafts/20260530-1358-workflow-history.md).
Baseline (verified 1f32906): `bun test` 1032 pass / 0 fail; e2e 26/26.

Each `/plan` run = its own History entry (a workflow-`kind` session + a root
`main` invocation) with each phase subagent (producer / clarify-reviewer /
planner / plan-reviewer / continuation) nested under it as a child invocation.
Persisted DIRECTLY via the Persistence adapter — never through the interactive
Bridge / SessionRegistry, so pool=1 holds.

### Milestone M-WFHIST — PR breakdown

- [x] **wfhist-1** (commit 4fab2f5) — Persistence: `session.kind` column (migration #8) + `workflow_session` link store (goalId→sessionId+rootInvocationId); both adapters; HistoryRow/Full Zod carry `kind`; history join selects it. Dual-adapter round-trip + migration-on-pre-#8-DB tests. 1044/0.
- [x] **wfhist-2** (commit 3377826) — Capture phase-subagent usage (model/cost/tokens) from the SDK `result` via an `onUsage` sink on the dispatch/produce request (no sync/async union; Codex=0). Drain defers `q.close()` past submit (5s grace) to observe `result`; resolves at submit-time (pool=1 timing unchanged). Real-SDK onUsage test. 1049/0.
- [x] **wfhist-3** (commit f42e8a7) — Wire `persistence`+`cwd` into `WorkflowRuntime` (server.ts); `WorkflowHistoryRecorder` (Persistent+Null); create workflow-kind session + root `main` invocation per run; goalId→session link; settle/close on planned/abandoned/errored.
- [x] **wfhist-4** (commit f42e8a7) — One CHILD invocation per phase dispatch (producer, clarify-reviewer#N, planner#N, plan-reviewer#N, continuation): running→completed/failed, cost/tokens from `onUsage`, parent=root. Dual-adapter tests. 1055/0.
- [x] **wfhist-5** (commit b51fafb) — Web: `List.tsx` "Plan" badge on workflow main rows; phase children render as `↪` subagent rows. Web test asserts badge present on workflow main, absent on chat main + children.
- [x] **wfhist-6** (commit 42809f6) — Resume re-attach test (restart mid-workflow → same session, no orphan); pool=1 regression (shared persistence); E2E `plan-workflow-history.spec.ts` (prelude project) `/plan`→History badge + nested producer; discharge.

**M-WFHIST CLOSED.** Discharge: `bun run check` exit 0 ×2 (1059/0 both; baseline 1032/0 + 27 new); `bun run e2e` 27/27 (baseline 26 + 1 new); `nix build .#default` exit 0 (`result` → cq-0.0.1; local fallback, remote SSH builder unreachable). Defect `WF-HIST-01` resolved. Session log: `docs/logs/20260530-1358-log.md`.

---

## Cycle: gtitle — add short `title` to goals alongside `description`

Plan: [`docs/drafts/20260530-1310-goal-title.md`](docs/drafts/20260530-1310-goal-title.md).
Baseline (verified 7d5dcd4): `bun test` 1032 pass / 0 fail; e2e 26/26.

### Milestone M-GTITLE — PR breakdown

- [x] **gtitle-1** — Thread `title` end-to-end: schema (GOALS_SCHEMA, title first + required) → producer output (ProducerOutputSchema.goal `{title,description}` + prompts) → harness write (writeArtifacts + writeIncrement) → goals.snapshot (GoalSnapshot Zod + buildGoalsSnapshot) → Goals tab (row=title, expand=description). Added `title` to every goal/producer fixture across ledger/server/web/shared/e2e/cq-mcp; new coverage for schema-rejects-missing-title, harness-writes-title, continuation-refines-title, snapshot-carries-title, row-renders-title + expand-renders-description.

**M-GTITLE CLOSED.** Discharge: `bun run check` exit 0 ×2 (1032/0 both; baseline 1032/0); `bun run e2e` 26/26; `nix build .#default` exit 0 (local fallback; remote SSH builder unreachable). Defect `GOAL-TITLE-01` resolved. Session log: `docs/logs/20260530-1310-log.md`.

**Completed — gtitle-1** (2026-05-30): shipped the goals `title` field end-to-end. What shipped: required `title` on `GOALS_SCHEMA` (first field, before `description`); `ProducerOutputSchema.goal={title,description}`; producer + continuation prompts ask for a short ≤8-word title + detailed description; harness `writeArtifacts`/`writeIncrement` persist title (continuation refines title + extends description in the same append, originals untouched); `GoalSnapshot` Zod + `buildGoalsSnapshot` carry title; GoalCard row shows the short title (`goal-title-<id>`), the expand shows the detailed description (`goal-description-<id>`, `.goalDescriptionBody`). Surprise/discovery: the Claude producer advertises a SEPARATE, looser SDK-tool input schema (`claudeProducer.submitPlanSchema`) than the strict `ProducerOutputSchema` it re-validates against; the SDK strips the model's tool input to the advertised schema BEFORE the handler sees it, so omitting `title` from `submitPlanSchema` silently dropped the title → strict re-validation failed → handler returned isError → model retried until the 40s dispatch timeout → `errored`. Caught by the two REAL-SDK MockAnthropic integration tests timing out; fixed by adding `title` to `submitPlanSchema`. The continuation phase subagent (`claudePhaseSubagent`) advertises `{payload:z.unknown()}` so it does NOT strip — no analogous fix needed there; the Codex path validates the relayed payload directly against `ProducerOutputSchema`/`spec.schema` (cq-mcp relay tool forwards an opaque payload) — also no fix needed. Constraint future work must respect: any goal-producing path that advertises a STRIPPING tool-input schema distinct from `ProducerOutputSchema` must keep the two field-sets in sync, or the SDK silently drops fields. Divergence-guard implication: an old-schema dev `docs/goals.md` (no title) now fails bootstrap (`BootstrapViolationError`); `rm docs/goals.md docs/ledgers.yaml` once (gitignored, regenerable) — none existed in this worktree. Verification: `bun run check` → exit 0, 1032 pass / 0 fail (×2); `bun run e2e` → 26 passed; `nix build .#default` → exit 0 (`result` → cq-0.0.1; local fallback after remote SSH builder unreachable). Metrics: review rounds 1 (self-review, no subagent dispatch tool in runtime); defects {major:0, minor:1 (GOAL-TITLE-01, the input-strip hazard), nit:0}; verification complete; scope delta: +1 file vs plan envelope (`claudeProducer.ts` — the SDK input-strip schema, not anticipated in the plan; and +`cq-mcp/test/submitRelay.e2e.test.ts` fixture).

---

## Cycle: plan-usability — four /plan dogfood usability defects (PLAN-D01..D04)

Plan: [`docs/drafts/20260530-1245-plan-usability.md`](docs/drafts/20260530-1245-plan-usability.md).
Baseline (verified 274ec43): `bun run check` 1012 pass / 0 fail. e2e target 25/25.

### Milestone M-PLAN-UX — PR breakdown

- [x] **PLAN-D01** (commit cd1b636) — phase subagents read-blind: shared `makePhaseCanUseTool` allows Read/Grep/Glob + submit, denies writes; explore-first prompt on every phase builder (incl. Codex via shared builders). cwd already = project ⇒ reaches codebase + on-disk ledgers. Harness still owns all writes.
- [x] **PLAN-D02** (commits bb10a25 + ebae3cb) — Goals tab not scrollable: `.wrapper` `flex:1; min-height:0` + `.goal` `flex-shrink:0` so the column overflows and `overflow:auto` engages. Height-chain e2e asserts `scrollHeight > clientHeight` + actual scrollability (caught the flex-shrink defect).
- [x] **PLAN-D03** (commit ebae3cb) — Goals theming + size: replaced hardcoded light hexes with `global.css` `--*` vars; bumped question/option text to readable size. (No dark selector exists in app — theme-ready, not dark-verified.)
- [x] **PLAN-D04** (commit 3055a49) — `/plan` line not in chat: inject synthetic user `chat.event` bubble in `handleSubmit` before `workflow.start`; still emits `workflow.start`.

**M-PLAN-UX CLOSED.** Discharge: `bun run check` exit 0 ×2 (1032/0 both; baseline 1012 + 20 new tests); `bun run e2e` 26/26 (25 baseline + 1 new scroll spec; WFL-D02/LOCK-D01/Codex relay/continuation/FTS not regressed); `nix build .#default` exit 0 (local fallback after SSH-builder warning). Defects PLAN-D01..D04 resolved. Session log: `docs/logs/20260530-1245-log.md`.

### Completed (plan-usability)

- **PLAN-D01** (2026-05-30, commit cd1b636) — Gave the headless `/plan` phase subagents read-only repo access so they stop reasoning blind. New shared `makePhaseCanUseTool(fqSubmit)` + `PHASE_READONLY_TOOLS={Read,Grep,Glob}` in `headlessQuery.ts`; both Claude lanes (`claudeProducer.ts`, `claudePhaseSubagent.ts`) use it. ALLOW = read-only built-ins + the phase's fq submit tool; DENY = everything else (Edit/Write/Bash/NotebookEdit/MultiEdit, all MCP ledger tools, unknowns). `EXPLORE_FIRST_INSTRUCTION` prepended to `buildProducerPrompt` + all 5 `phases.ts` builders; Codex inherits via the shared builders (its reads are sandbox-governed, NOT canUseTool — sandboxMode unchanged, documented). Verification: `workflow-phase-canusetool.test.ts` (14 cases) asserts allow/deny set + explore-first on every builder; `bun run check` 1032/0 ×2; server typecheck 0. Surprises/constraints: (1) neither headless lane sets `permissionMode`, so `canUseTool` IS consulted — the read-allow is effective (the old deny-all was load-bearing, confirming this). (2) No existing test asserted the old deny-all behaviour, so the widening regresses nothing. (3) Harness-owns-writes is preserved by construction: no write tool, the only registered MCP server is `wf` with just the submit tool. Metrics: review rounds 1 (self-review; subagent dispatch unavailable in runtime → serialised executor+reviewer); defects {major:0,minor:0,nit:0}; verification complete; scope delta none (server/workflow only + 1 test).
- **PLAN-D02 + PLAN-D03** (2026-05-30, commits bb10a25 + ebae3cb) — Goals tab now scrolls and is themed/legible. D02 (scroll): `.wrapper` → `flex:1 1 auto; min-height:0` (bounded-flex-child, ChatTab `.streamWrap` pattern) AND `.goal` → `flex-shrink:0`. The height-chain e2e (`plan-workflow-scroll.spec.ts`, 25 seeded questions) caught a SECOND defect the CSS-property check would have missed: once `.wrapper` was bounded, the flex-column rows shrank to fit so scrollHeight stayed == clientHeight (684); a temporary ancestor-chain probe confirmed wrapper scroll=684 before / scroll=4719 after the flex-shrink fix. The spec asserts scrollHeight>clientHeight AND scrollTop=300 sticks. D03 (theme): re-authored theme-sensitive surfaces/borders/text/accents to `global.css` `var(--…)` with fallbacks; bumped question/option/answer text to legible sizes; status chips keep semantic pastels. `goals-theme.test.ts` asserts (var-fallbacks + `.status*` rules stripped) that the light-theme hexes are no longer applied as bare values, the variables are referenced, text >= 0.875rem, and `.wrapper` is a bounded flex child. FINDING (logged): the web package has NO dark-theme selector — D03 is theme-ready/consistent, not dark-verified. Verification: `bun run check` 1032/0 ×2; `bun run e2e` 26/26; web suite 303/0; web typecheck 0. Metrics: review rounds 1 + 1 adversarial e2e round that found the flex-shrink defect; defects {major:0,minor:0,nit:0} net-new beyond the flex-shrink sub-fix folded into D02; verification complete; scope delta = +`.goal flex-shrink:0` (discovered via the height-chain test, intended for D02).
- **PLAN-D04** (2026-05-30, commit 3055a49) — The user's typed `/plan …` line is now preserved in the chat transcript. `ChatTab.handleSubmit` injects a synthetic user `chat.event` (same SDKUserMessage text shape the server echoes for chat.input) into `chatEvents` before sending `workflow.start`, so the existing `Stream` user-bubble renderer shows it; `workflow.start` (incl. `G<id>` continuation parsing) is emitted unchanged. Repro-first: `plan-echo.test.ts` drives the textarea + bare Enter, asserts the line renders + workflow.start fires; RED against the pre-echo code (0 user bubbles, verified by disabling the echo line), green with the fix. No extra system line added — the WorkflowBanner already provides lifecycle acknowledgment (kept minimal). Verification: web typecheck 0; `bun run check` 1032/0 ×2; `bun run e2e` 26/26. Metrics: review rounds 1; defects {0,0,0}; verification complete; scope delta none (ChatTab.tsx + 1 test).

---

## Cycle: ledger-fts — in-memory FTS over ledgers, exposed as `fts_search` MCP tool

Plan: [`docs/drafts/20260530-1020-ledger-fts.md`](docs/drafts/20260530-1020-ledger-fts.md).
Baseline (verified cce4a6f): `bun test` 989 pass / 0 fail. e2e target 25/25.
Approach: MiniSearch v7.2.0 in-memory index as a derived projection of the
store's in-memory ledgers, coherent via the existing onMutation (local) +
invalidate (remote) hooks. `includeArchived` IN v1. NOT SQLite.

### Milestone M-FTS — PR breakdown

- [x] **fts-1** (commit b2f94a6) — Add `minisearch@7.2.0` dep + `LedgerSearchIndex` (search/LedgerSearchIndex.ts): MiniSearch wrapper, canonical headline/body/status field bucketing, per-ledger active/archived doc buckets with id-tracked replacement, `search()` with ledger/limit/fuzzy/prefix/status/includeArchived. Unit test (no store) asserts headline>body ranking, fuzzy, prefix, status, includeArchived partition.
- [x] **fts-2** (commit 8aa7c3d) — Add `ftsSearch` to `LedgerStore`; wire `LedgerSearchIndex` into both adapters (init builds active+archived; onMutation rebuilds active [+archived on archive op]; invalidate rebuilds active+archived for BOTH known-ledger and registry-reload branches; createLedger indexes empty). Active rebuild guarded so it never unwinds the write. Dual-tests: ranked cross-ledger, single-ledger filter, boosts, fuzzy/prefix, status, includeArchived (archive→found only when true), local coherence.
- [x] **fts-3** (commit e40b937) — Cross-process coherence test: two FsLedgerStore on one cwd, onMutation→peer.invalidate relay; B.ftsSearch finds A's item only after invalidate (proves index rebuilds on remote path).
- [x] **fts-4** (commit 3a25795) — MCP `fts_search` on BOTH surfaces: `createLedgerMcpTools` + `LEDGER_TOOL_NAMES` (ledger pkg) AND `cq-mcp/src/main.ts::registerLedgerTools` (stdio binary hand-redefines tools). Bump tool-count assertions (ledger mcp-tools 13→14; cq-mcp main 13→14; cq-mcp submitRelay 14→15). Wire-shape test. `search_items` unchanged.
- [x] **fts-5** (commit 5428a17) — flake.nix: add `minisearch` to ledger dep symlink loop (covers both @cq/ledger consumers via the shared workspace symlink); refresh FOD outputHash. `nix build .#default`; built cq-mcp `tools/list` +1 + launches. `bun run check` ×2; `bun run e2e` ×1. defects.md + session log + manual scenario.

Adversarial-review folded in: (F1) invalidate must index the registry-reload branch's new ledger too; (F2) wrap the whole onMutation-driven rebuild in a non-throwing guard — do not assume purity.

**M-FTS CLOSED.** Discharge: `bun run check` exit 0 ×2 (1012/0, baseline 989 + 23 FTS tests); `bun run e2e` 25/25; `nix build .#default` exit 0 + built cq-mcp binary launches with `fts_search` in tools/list (14 ledger tools) and returns ranked results end-to-end. Defects FTS-D01 (archived-refresh race, resolved fts-2) + FTS-D02 (smoke-harness concurrency artifact, no product change). Session log: `docs/logs/20260530-1020-log.md`.

---

## Cycle: noprogress-trigger (WFL-D01) — derive no-progress from the ledger, not an in-memory fingerprint

Plan: [`docs/drafts/20260530-0900-noprogress-trigger-plan.md`](docs/drafts/20260530-0900-noprogress-trigger-plan.md).
Baseline (verified a35b4ed): `bun test` 986 pass / 0 fail. e2e target 25/25.

### Milestone M-NPG — PR breakdown

- [x] **npg-1** — Replace the no-progress guard TRIGGER: detect "no ledger update in a revise round" (no net change to the goal's milestone/task plan structure AND no new questions) from durable ledger state instead of the in-memory `lastReviseFingerprint`. Remove the fingerprint map + `fingerprintPlan` + all set/reset/clear sites. Generalize the degenerate clarify case (not-clear + zero new questions → escalate). KEEP the escalation frame + `escalation_reply` handler + Goals-tab banner byte-identical. Update `workflow-loops.test.ts` would-spin test to the ledger-diff path; add resume-after-escalation and clarify-degenerate tests. `WFL-D01` row in defects.md.

### Completed (noprogress-trigger)

- **npg-1** (2026-05-30) — Reformulated the WFL-D01 no-progress guard's TRIGGER from an in-memory structural fingerprint to a DURABLE ledger-diff, per the user's chosen formulation: "a planning/revise round that produces NO LEDGER UPDATE — no new questions AND no net change to the goal's milestones/tasks — is declared no-progress." `revisePlanWithGuard` now snapshots `planArtifacts(goalId)` + `totalQuestionCount(goalId)` BEFORE the revise persist and again AFTER, escalating when `planArtifactsEqual(before, after)` and the question count did not grow. Removed `lastReviseFingerprint: Map`, `fingerprintPlan()`, and all four set/reset/clear sites (runPlanner reset, runPlanReview satisfied/newQuestions resets, submitEscalationReply proceed/abandon/guidance clears). Generalized to the clarify loop: a clarify-reviewer that reports not-clear with zero new questions now escalates instead of stranding the goal in `clarifying` with no open question. The escalation is UNCHANGED byte-for-byte (frame, detail intent, `escalation_reply` handler proceed/guidance/abandon, Goals-tab banner). Verification: `bun run check` ×2 → exit 0, 989 pass / 0 fail both runs (baseline 986 + 3 new tests), deterministic; `bun run e2e` ×2 → 25/25 both runs (no regression to WFL-D02 ordering / LOCK-D01 / Codex relay / continuation); `nix build .#default` → exit 0 (local fallback after SSH-builder warning). Repro discipline (the concrete win): the new resume-after-escalation test asserts the resumed runtime escalates on its FIRST post-resume revise round (1 planner dispatch); stashed the source fix, ran that test against the OLD fingerprint code → RED (`Received: 2` — the old in-memory map needed two identical revise rounds on a cold-map runtime, masking the stall for one round); restored the fix → green. Surprises/constraints: (1) the original `fingerprintPlan` used control-byte (`\x00`/`\x01`/`\x02`) field separators, so the dead method had to be excised byte-exactly (Edit couldn't express NUL); this also explains rg's "binary file matches" warning on the file. (2) `writePlan`/`appendPlan` replace-semantics make an identical re-plan a CONTENT no-op even though milestone ids change every round — `planArtifacts` reads only goal-referenced milestones, so detached orphans from prior replaces don't pollute the compare (K-NPG-2, verified). (3) CAVEAT flagged in WFL-D01: a clarify-phase escalation reply via `proceed` would mark a still-`clarifying` goal `planned` despite no plan existing; extending the handler is out of scope (constraint), and the meaningful clarify-stall recoveries are `guidance`/`abandon`. Metrics: review rounds 1 (self-review; subagent dispatch unavailable in this runtime → serialised executor+reviewer with explicit red-against-old repro); defects {major:0, minor:0, nit:0} (no new defects; WFL-D01 reformulated, not a new bug); verification complete; scope delta none (workflowRuntime.ts + one test file + the WFL-D01 row, as planned).

### Cross-cutting decisions (noprogress-trigger, locked)
- K-NPG-1: no-progress is detected by comparing the goal's DURABLE plan structure (milestone titles/descriptions + task headline/description/acceptance, grouped per milestone, read from the ledger via `planArtifacts`) BEFORE vs AFTER a revise round's persist, plus whether any new question was written that round. Unchanged plan + zero new questions ⇒ no ledger update ⇒ escalate. Anchored to post-write ledger state, not an in-memory hash — survives a mid-loop restart.
- K-NPG-2: `writePlan`/`appendPlan` use replace-semantics, so an identical re-plan is a content no-op (new milestone ids, identical content; `planArtifacts` reads only goal-referenced milestones so detached orphans don't pollute the compare). Verified before relying on it.
- K-NPG-3: the escalation itself (frame, detail text intent, `proceed/guidance/abandon` handler, banner) is UNCHANGED — only the detection mechanism changes. WFL-D01 guard remains by-design with this trigger per the user's chosen formulation.
- K-NPG-4: first plan never triggers (it always writes milestones/tasks from an empty plan ⇒ a net change); the check is meaningful only on revise rounds (round ≥ 2). Preserved by snapshotting before/after each revise persist.

---

## Cycle: lockfile-wait (LOCK-D01) — lockfile waits for a live holder instead of failing fast

Plan: [`docs/drafts/20260529-2200-lockfile-wait-plan.md`](docs/drafts/20260529-2200-lockfile-wait-plan.md).
Baseline (verified 187c027): `bun test` 907 pass / 0 fail. e2e target 23/23.

### Milestone M-LOCK — PR breakdown

- [x] **lock-01** — `Lockfile.acquire()` waits-with-timeout on a LIVE holder (poll every interval until acquired or timeout → `LedgerBusyError`); dead-PID stale reclaim preserved; injectable poll interval + timeout + fake clock. New lockfile tests (live-releases→acquire, live-stuck→timeout, dead→reclaim, dies-mid-wait→reclaim) + cross-instance two-`FsLedgerStore` concurrent-write regression. `LOCK-D01` row in defects.md.

### Cross-cutting decisions (lockfile-wait, locked)
- K-LOCK-1: two legitimate concurrent ledger writers exist on one cwd (cq-server in-process store + the long-lived cq-mcp child store). The advisory file lock MUST serialize them by WAITING, not by failing fast. Bounded timeout retains the genuine-deadlock signal.
- K-LOCK-2: dead-PID stale reclaim (unlink + retry) is preserved unchanged; the timeout must remain bounded so a stuck live holder still surfaces `LedgerBusyError`.
- K-LOCK-3: the WFL-D02 e2e Playwright project-ordering workaround stays (it also addresses the CPU-starvation half) but is no longer load-bearing for the lock race once the lock waits.
- K-LOCK-4: cross-process no-lost-write is a TWO-layer guarantee — the file lock (no torn write) AND the D-COHERENCE relay (`onMutation`→peer `invalidate`) so each store re-reads before its next write. The lock alone does not merge two stores' in-memory snapshots. The regression test wires both layers.
- K-LOCK-5: `readHolder` classifies an empty/unparseable lockfile body (a holder mid-write between `open(O_EXCL)` and `writeFile`) as `transient` and the wait loop POLLS AGAIN without reclaiming; reclaiming a mid-write lock would risk two acquirers. Only a confirmed-dead `holder` is reclaimed; only a genuine I/O error throws.

### Completed (lockfile-wait)

- **lock-01** (2026-05-29) — `Lockfile.acquire()` now waits-with-bounded-timeout on a LIVE holder instead of failing fast, fixing the cross-process write race behind WFL-D02 (defect 1). On `EEXIST` it polls `tryOnce` every `pollIntervalMs` (default 25 ms) until acquired or `acquireTimeoutMs` (default 5000 ms, bounded) elapses → `LedgerBusyError`. Dead-PID stale reclaim preserved. `readHolder` rewritten to return a discriminated `HolderProbe` (`gone`/`transient`/`holder`) so an empty mid-write body is treated as transient (poll again, no reclaim) rather than a hard error — a latent fragility that flaked the full suite under contention (`pid 0 on unknown`), discovered and fixed during this cycle. New injectable opts `acquireTimeoutMs`/`pollIntervalMs`/`sleep`. Verification: `bun run check` x2 → exit 0, 911 pass / 0 fail (baseline 907 + 4 net new tests), deterministic; `bun run e2e` → 23/23 (Codex cq-server↔cq-mcp specs pass); `nix build .#default` → exit 0; full ledger suite 163/0 stable across 3 runs. Repro discipline: stashed the fix, ran the new cross-instance "different ledgers" test against the OLD fail-fast code → red with `LedgerBusyError: Ledger __milestones__ is locked by pid N on vm` (the WFL-D02 symptom); restored the fix → green. Load-bearing proof for no-lost-write: disabling the D-COHERENCE relay drops the count to 15/30. Surprises/constraints: (1) the lock alone does NOT give cross-process no-lost-write — the coherence relay is required and the regression test wires it (K-LOCK-4). (2) reclaiming on an empty body is WRONG (two-acquirer hazard); transient-poll is the correct policy (K-LOCK-5). (3) the WFL-D02 Playwright ordering workaround is now belt-and-suspenders (kept; still load-bearing for the CPU-starvation half, no longer for the lock race). Metrics: review rounds 1 (self-review; subagent dispatch unavailable in this runtime → serialised executor+reviewer with explicit repro discipline); defects {major:1, minor:0, nit:0} (LOCK-D01, includes the readHolder subfix); verification complete; scope delta none (ledger lib + 2 test files, as planned).

---

## Cycle: workflow-loops (cycle 3) — make `/plan` converge end-to-end

Plan: [`docs/drafts/20260529-2000-plan-workflow-loops.md`](docs/drafts/20260529-2000-plan-workflow-loops.md).
Authoritative design: [`docs/drafts/20260529-1710-questions-plan-workflow.md`](docs/drafts/20260529-1710-questions-plan-workflow.md).
Baseline (verified 9f64579): `bun test` 885 pass / 0 fail. e2e target ≥ 22.

### Milestone M-WFL — PR breakdown

- [x] **wfl-1** — PhaseSubagent dispatch seam + phase schemas + Codex stub + protocol enum extensions + `question.answer` frame. `phases.ts` (generic `PhaseSubagent`/`PhaseSpec` + clarify-review/plan/plan-review Zod schemas + prompt builders), `headlessQuery.ts` (extracted `SingleMessageQueue`+`resolveNativeBinaryPath`, producer refactored to use), `claudePhaseSubagent.ts` (generic Claude impl), `codexPhaseSubagent.ts` (WF-D01 stub), protocol `question.answer` + extended `workflow.event` enums, `WorkflowBanner` new statuses. `workflow-phases.test.ts` (10). Commit `58e104a`.
- [x] **wfl-2** — Loop engine in WorkflowRuntime: clarify + planner + plan-review loops, ledger-as-state `derivePosition`, no-progress liveness guard, lifecycle fan-out, `submitAnswer` auto-advance, `reconcile`. server.ts wires `selectPhaseSubagent` + `reconcile()`. `workflow-loops.test.ts` (6). Commit `75dfaad`.
- [x] **wfl-3** — `question.answer` WS handler + auto-advance-exactly-once + runtime subscribe/unsubscribe on open/close; resume-on-startup reconcile exercised. `workflow-ws.test.ts` (+1), `workflow-loops.test.ts` (+2 resume). Pool=1 regression preserved. Commit `815953f`.
- [x] **wfl-4** — Integration (real Claude SDK via MockAnthropicHTTP) one full clarify→plan→review→planned cycle (`workflow-loops-integration.test.ts`); e2e `plan-workflow-loop.spec.ts` (`/__admin/scriptByKey` per-phase mock + `/__e2e/answer`+`/__e2e/workflow-idle` hooks). e2e 23/23. Commit `02a8da9`.
- [x] **wfl-5** — Discharge: `bun run check` x2 = 905/0 (deterministic); `nix build .#default` exit 0; `bun run e2e` 23/23; manual scenario captured (full lifecycle + populated ledgers); defects WF-D02→resolved, WFL-D01 (no-progress guard, user-veto), WFL-D02 (e2e load caveat); session log.

### Cross-cutting decisions (workflow-loops, locked)
- K-WFL-1: workflow position is derived from ledgers (goal.status + open-question count), not in-memory (closes WF-D02). In-memory state = global busy slot + per-goal in-flight latch only.
- K-WFL-2: NO hard round cap (Q6); plan-review runaway bounded by a no-progress liveness guard (identical planner output + no new questions twice → `escalated` frame, loop stops).
- K-WFL-3: every ledger write is HARNESS-owned; phase subagents return structured output via a harness-owned in-process submit tool and never touch ledgers.
- K-WFL-4: plan-review newQuestions re-enter via the clarify-reviewer (re-validate clarity) before re-planning, so the clarity gate is never bypassed.
- K-WFL-5: lifecycle frames fan out to all subscribed WS sessions (loops are async; `question.answer` may arrive on any connection).

---

## Cycle: canon — Canonical ledger schemas

Plan: [`docs/drafts/20260529-0000-canonical-ledgers-plan.md`](docs/drafts/20260529-0000-canonical-ledgers-plan.md).
Authoritative design: [`docs/drafts/20260528-2129-canonical-ledger-schemas.md`](docs/drafts/20260528-2129-canonical-ledger-schemas.md).
Baseline (verified 83d1dbf): `bun run check` 807 pass / 0 fail / 2778 expect across 93 files. e2e target 21/0/0.

### Milestone M-CANON — PR breakdown

- [x] **PR-01** — idPrefix schema field + global prefix uniqueness (§8a, Q-CANL-8). `LedgerSchema.idPrefix?`; `effectiveIdPrefix`/`assertPrefixUnique`/`assertItemIdMatchesPrefix` in core.ts; `DuplicatePrefixError`+`CrossPrefixIdError`; registry + MCP schema round-trip idPrefix; both adapters refuse prefix collision at createLedger (re-checked under registry lock on FS). New `idprefix.test.ts` (14 cases, dual-adapter). Updated path-traversal + cq-mcp fixtures to prefix-valid ids. tsc+eslint clean; ledger+cq-mcp 143/0.
- [x] **PR-02** — Bootstrap defects/tasks/hypothesis/questions/decisions/goals (§8, B). Canonical schemas + `CANONICAL_LEDGERS` manifest in constants.ts; both adapters bootstrap all 7 on init() (provision-if-absent + divergence guard generalised). `goals` (idPrefix G) added per scope item B. Reworked dual-suite + concurrency/path-traversal/mcp-tools/cq-mcp/internalWs fixtures to non-canonical custom ledgers (widgets/notes/xenos/alpha) so seeds don't collide with bootstrapped names/prefixes; updated enumerate assertions to the full canonical set. Repo-root `docs/` regenerated; new ledger files gitignored (dev-cwd runtime artifacts, like milestones.md). full bun test 821/0 (+14); tsc+eslint clean. CANON-D01 (env hygiene) recorded.
- [x] **PR-03** — M-AMBIENT bootstrap milestone (§8b). `MILESTONES_AMBIENT_ID` + `applyEnsureAmbientMilestone` (idempotent) called on init in both adapters; immortality enforced in `applyDetachMilestoneItem` + `applyUpdateMilestoneItem` + both `performArchive` (early refusal). The `^M\d+$` exception already in `assertItemIdMatchesPrefix`. Suite gains a §8b describe block (bootstrapped/archive-refused/terminal-move-refused/cross-ledger-reference). Fixed archive + D-COHERENCE sanity assertions for the now-present M-AMBIENT. ledger+cq-mcp+server 453/0; tsc+eslint clean.
- [x] **PR-04** — Milestones §8c rename + §8d `## active` group. §8c: MILESTONES_SCHEMA + CreateMilestoneItemInit/UpdateMilestoneItemPatch + core mappers + both MCP tool surfaces renamed blocked→blockedBy, depends→dependsOn. §8d: MILESTONES_ACTIVE_GROUP_ID "M0"→"active"; serializer emits literal `## active`; parser requires the literal `## active` header for the milestones ledger (rejects legacy `## M0 — active` / `## M<id> — title` / >1 group with clear errors); other ledgers unchanged (bare `## <id>`); milestone-item-archive synthetic wrapper updated. Fixtures + repo docs regenerated. full bun test 830/0; tsc+eslint clean. (One web attachments test flaked once under full-run ordering — passes in isolation and on retry; pre-existing happy-dom nondeterminism, unrelated.)
- [x] **PR-05** — Fixtures + dual-suite extension + repo docs regen + discharge. New `canonical-ledgers.test.ts` (28 cases): per-canonical-ledger create/update/fetch/search/archive against BOTH adapters; global-id-uniqueness assertion; bootstrap idempotence; per-ledger divergence-guard; §11 worked-example parser round-trips; fresh-cwd `## active` shape. Discharge: `bun run check` exit 0 (858/0, +51); `bun run e2e` 21/0/0 (fixed `ledger-create.spec` todos→xenos prefix collision); `nix build .#default` exit 0; cq-mcp standalone tools/list=13; enumerate (binary + in-process) lists all 7 bootstrapped ledgers; fresh `docs/milestones.md` renders `## active` + M-AMBIENT. Session log + deviations recorded. Cross-prefix + dup-prefix refusal verified through the MCP layer.

### Cross-cutting decisions (canon, locked)
- K-CANON-1: prefix uniqueness enforced at `createLedger` (DuplicatePrefixError); bootstrapped ledgers carry distinct canonical prefixes so they cannot collide.
- K-CANON-2: `M-AMBIENT` is the single `^M\d+$` exception; named constant `MILESTONES_AMBIENT_ID`.
- K-CANON-3: `## active` literal-header special-case keyed on `ledger.id === MILESTONES_LEDGER` only; `MILESTONES_ACTIVE_GROUP_ID` value changes "M0" → "active".

---

## Cycle: workflow-runtime — `/plan` WorkflowRuntime phase 1 (wf)

Authoritative design: [`docs/drafts/20260529-1710-questions-plan-workflow.md`](docs/drafts/20260529-1710-questions-plan-workflow.md).
Baseline (97e0ed5): `bun run check` 858 pass / 0 fail. e2e target 21/0/0.
Scope: foundation + phase 1 ONLY (Q14 cycle 2). NO clarify/plan/review loops, NO planner,
NO `/plan G<id>` continuation work (parse+route only → continuation-not-implemented error),
NO Goals-tab UI beyond a minimal lifecycle banner in chat.

### Dispatch-lane design (how it stays clear of pool=1)
The producer runs in a HEADLESS lane owned by `WorkflowRuntime`, NOT through the `Bridge`
facade. The runtime calls a backend-agnostic `headlessProduce(...)` that:
- (Claude) constructs its OWN `query()` via an injectable `QueryFactory`, with a single
  in-process MCP tool `submit_plan` (harness-owned handler validates `{goal,questions}` and
  resolves a promise) and NO ledger MCP tools. It never touches `Bridge.active`, never emits
  `chat.*` frames, never registers a `SessionRegistry` session. Pool=1 interactive chat is
  therefore structurally undisturbed.
- (Codex) dispatches `Thread.runStreamed` headlessly; if structured-output forcing differs,
  document the gap (see defects). Phase 1 ships on Claude; Codex dispatch path wired + tested
  against a fake, real-Codex deferred if the SDK blocks it.
The HARNESS writes all ledgers (controls IDs, seeds the mandatory spec milestone, groups
questions). The producer MUST NOT write ledgers.

### PR breakdown
- [x] **PR-wf-1** — CommandRegistry + `workflow.start`/`workflow.event` Zod (protocol.ts) + client routing of `/plan` lines. DONE: `parsePlanCommand` (pure/total); both frames added to ClientFrame/ServerFrame unions; ChatTab.handleSubmit routes `/plan` to workflow.start BEFORE the activeSessionId guard (planning is session-independent); `/plan` added to slash commands. 13 tests (command parse + protocol round-trip).
- [x] **PR-wf-2** — WorkflowRuntime + headless dispatch lane + harness submit tool + ledger writes + in-memory active-workflow registry (busy reject). DONE: ClaudeProducer runs its own `query()` with the harness-owned `submit_plan` tool (no ledger MCP); WorkflowRuntime is the HARNESS (writes goal[clarifying]+spec milestone+questions, links goal); busy-reject; producer-failure leaves no ledger state; `abortActive()` for teardown/shutdown. Bun native-binary spawn workaround mirrored from ClaudeBridge. 14 tests (runtime phase-1 + producer failure-modes + pool=1 regression).
- [x] **PR-wf-3** — Server wiring (WsSession→registry→WorkflowRuntime; lifecycle frames on the issuing connection) + WorkflowBanner + integration (REAL Claude SDK vs MockAnthropicHTTP: `/plan`→submit_plan→ledgers→questions_ready) + E2E Playwright (`/plan`→banner→3 ledger files). DISCHARGED: `bun run check` exit 0 x2 (885/0, +27); `bun run e2e` 22/22 green 5x deterministic; `nix build .#default` exit 0. WF-D01 (Codex deferred) + WF-D02 (no durable resume, documented) filed.

### Cross-cutting decisions (wf, proposed)
- K-wf-1: headless lane bypasses `Bridge` entirely (own QueryFactory); pool=1 invariant held by construction.
- K-wf-2: HARNESS owns all ledger writes; producer gets `submit_plan` only, no ledger MCP.
- K-wf-3: 2nd concurrent `/plan` → reject-with-busy (Q D recommendation).
- K-wf-4: `/plan G<id>` parses + routes, returns continuation-not-implemented lifecycle error (Q9).
- K-wf-5: spec milestone "produce an actionable specification" always seeded, linked from goal (Q11).

---

## Milestones (high-level)

- [x] **askcard-freeform** — Free-form "Other…" answer affordance on every AskUserQuestion card question (radio + checkbox). Reply protocol/brokers UNCHANGED. Plan: [`docs/drafts/20260529-askcard-freeform-plan.md`](docs/drafts/20260529-askcard-freeform-plan.md). DISCHARGED: check 807/0 (+8), e2e 20/0/0, nix exit 0. Closed ASKCARD-D01; D02/D03 nits resolved by-design. Brokers/protocol untouched. Log: [`docs/logs/20260529-askcard-freeform-log.md`](docs/logs/20260529-askcard-freeform-log.md).
- [x] **askproxy (outer-14)** — `ask_user_question` for Codex sessions via WS-back-proxy over the outer-13 internal WS channel. Plan: [`docs/drafts/20260529-1512-plan-askproxy.md`](docs/drafts/20260529-1512-plan-askproxy.md). DISCHARGED: check 799/0 (+38), e2e 20/0, nix exit 0. Closed ASKPROXY-D01; D-GC-1 cross-referenced. ClaudeBridge untouched. Log: [`docs/logs/20260529-1533-askproxy-log.md`](docs/logs/20260529-1533-askproxy-log.md).
- [x] **outer-13 / coherence** — Cross-process cache coherence between cq-server and cq-mcp via per-process internal WebSocket channel (`ledger.changed` invalidation). Plan: [`docs/drafts/20260529-0050-plan-coherence.md`](docs/drafts/20260529-0050-plan-coherence.md).
- [x] **outer-12 / msunify** — Unified `milestones` ledger + drop per-ledger milestone tools + ISO 8601 timestamps. Plan: [`docs/drafts/20260528-2100-plan-msunify.md`](docs/drafts/20260528-2100-plan-msunify.md).
- [x] **outer-11** — D-UNIFASYNC-01 + adversarial sweep for sync/async unions.
- [x] **outer-10** — close D-CQMCP-E2E + D-CQMCP-NIX (outer-9 follow-ups).
- [x] **outer-9** — D-GC-1 (Codex ledger MCP) + D-GC-N1 (approvalPolicy).
- (older milestones in this file)

---

## Milestone askcard-freeform — PR breakdown

Detail in [`docs/drafts/20260529-askcard-freeform-plan.md`](docs/drafts/20260529-askcard-freeform-plan.md).
Intake baselines: `bun run check` 799/0, `bun run e2e` 20/0/0.

- [x] **askcard-1** — AskCard.tsx: append synthetic "Other…" option per question (radio + checkbox) + inline text field + completeness/payload logic; AskCard.module.css text-input styling; extend web unit tests; add custom-string passthrough tests to cq-mcp + server broker tests. Brokers/protocol unchanged.

### Completed (askcard-freeform)

- **askcard-1** (2026-05-29) — Shipped the free-form "Other…" affordance. `AskCard.tsx`: a synthetic "Other…" control is appended as the LAST option of every question (both radio and checkbox); selecting/checking it reveals an inline controlled `<input type="text">`. New `otherText: Record<number,string>` state holds the typed text independently of `selections`, so a radio switch-away-and-back restores the text (edge rule 2). An `OTHER_SENTINEL` constant (`" __cq_other__"` — NUL-bearing so it cannot collide with a real model label) marks Other-active inside `selections`; `handleSubmit` replaces the in-place sentinel with the trimmed text. `isComplete()` treats an active-but-empty (trimmed) Other as UNANSWERED even when other real checkboxes are checked (edge rule 1, code-commented); whitespace-only ⇒ empty (edge rule 3). No disabled-reason chrome existed; none added (edge rule 4). `AskCard.module.css` gained `.otherText` matching the module's existing vocabulary. **Reply protocol, `QuestionReplyPayload`, `ChatQuestionReply`, the WS protocol, and BOTH `normaliseAnswers` brokers are UNCHANGED** — the custom text rides the existing `answers["<qIdx>"]` labels array as a plain string; both brokers do `Array.isArray → map(String).join(", ")` else `String(val)`, so the string passes through byte-identically on Claude (`packages/server/src/agent/askUserQuestion.ts:163`) and Codex (`packages/cq-mcp/src/askBroker.ts:115`). Tests: 6 new web cases (radio-Other-submit, checkbox-real+Other-submit, empty-text guard with real box checked, keep-on-switch, whitespace-only-empty, trim-before-send) + 1 cq-mcp + 1 server passthrough case.
  Verification: `bun run check` → 807 pass / 0 fail / 2778 expect across 93 files (baseline 799/0; +8). `bun run e2e` → 20 passed (unchanged). `nix build .#default` → exit 0 (remote builder SSH unreachable; built locally, `./result` produced). Discharge scenario (closest repro): AskCard checkbox-Other payload `{"0":["Markdown editor","a bespoke WYSIWYG editor"]}` → `normaliseAnswers` → `{"0":"Markdown editor, a bespoke WYSIWYG editor"}` (verified via throwaway test, removed).
  Notes / surprises:
  - happy-dom + React 19 + bun do NOT deliver a synthetically-dispatched `input`/`change` event to React's ChangeEventPlugin for **text** inputs (verified empirically — `<select>`/checkbox `change` propagates, text-input events do not, regardless of native-value-setter vs plain `el.value=`). The web test's `setText` helper therefore invokes the controlled input's React `onChange` directly off the fiber `__reactProps$*` key. Documented as ASKCARD-D03 (resolved by-design); the helper throws loudly if the internal key disappears.
  - If a model emits a real option literally labeled "Other…", the card shows two "Other…" rows (cosmetic only; no data corruption — synthetic control keys on the sentinel). ASKCARD-D02, resolved note-only, de-dup deemed out of scope.
  - Metrics: review rounds 1 (clean, no fix rounds); defects major:0(+1 pre-existing gap closed), minor:0, nit:2; verification complete; scope delta none (touched exactly the 5 planned files).
  - Constraint future work must respect: the `OTHER_SENTINEL` must remain a value no real label can produce. The brokers MUST keep `normaliseAnswers` in lockstep across server + cq-mcp or the custom string would diverge between backends.

---

## Milestone askproxy (outer-14) — PR breakdown

Detail in [`docs/drafts/20260529-1512-plan-askproxy.md`](docs/drafts/20260529-1512-plan-askproxy.md).
Intake baselines: `bun run check` 761/0, `bun run e2e` 20/0.

- [x] **askproxy-1** — shared: `ask.request` + `ask.reply` variants on `InternalWsMessage` + round-trip/negative tests.
- [x] **askproxy-2** — cq-mcp: `CqMcpAskBroker` (two-slot race by askId) + `ask_user_question` tool + `ask.reply` handler + `channel.onClose`→rejectAll + `CQ_SESSION_ID` + broker tests.
- [x] **askproxy-3** — server: `AskProxy` collaborator + `ask.request` handler on `InternalWsService` + `buildAskUserQuestionEvent` helper + CodexBridge `handleChatQuestionReply` + `CQ_SESSION_ID` env + dispatch tests.
- [x] **askproxy-4** — integration: real cq-mcp subprocess ask round-trip + `tools/list` includes `ask_user_question` (channel up) / 13 ledger tools (standalone).
- [x] **askproxy-5** — discharge: ledgers, ASKPROXY-D01 resolved + D-GC-1 cross-ref, session log, manual scenario, check/e2e/nix.

### Cross-cutting architectural notes (askproxy, locked)

- [x] Dispatch decision = `Bridge.handleChatQuestionReply` already routes to `this.active` backend; a Codex-active reply lands in `CodexBridge.handleChatQuestionReply` (no redundant platform branch). Make it explicit by implementing that method + a test asserting Claude→broker, Codex→proxy.
- [x] No "shared emit-ask-to-browser" between Claude and Codex: Claude gets the ask tool_use from the SDK's native assistant stream; the proxy SYNTHESIZES the identical assistant tool_use shape (`name:"AskUserQuestion"`, `id:toolUseId`, `input:{questions}`) via one factored helper `buildAskUserQuestionEvent`. Browser renders both identically (Stream.tsx:539).
- [x] `ask.reply` uses `InternalWsService.broadcast` (unkeyed Set of sockets); askId discriminates across multiple connected cq-mcp children. Safe because askId is unique-per-ask.
- [x] cq-mcp registers `ask_user_question` ONLY when the internal WS channel is up; standalone `tools/list` stays at 13 ledger tools.
- [x] AskQuestion shape is `unknown` (no strict schema to factor); the wire mirror is `z.array(z.unknown()).min(1).max(4)`.

### Completed (askproxy)

- **askproxy-5** (2026-05-29) — Discharge. defects.md: `ASKPROXY-D01` (major) resolved with full citation + commit list; one-line cross-ref note appended to the `D-GC-1` Fix cell (history unchanged per brief); `ASKPROXY-D02` (nit, broadcast-buffer-in-non-owning-child, resolved-by-design) + `ASKPROXY-D03` (minor, browser E2E deferred with a concrete follow-up spec) recorded. Session log `docs/logs/20260529-1533-askproxy-log.md`. Discharge gates: `bun run check` → **799 pass / 0 fail / 2757 expect() across 93 files** (baseline 761/0; **+38 net**); `bun run e2e` → **20 passed / 0 failed** (unchanged); `nix build .#default` → exit 0, standalone `./result/bin/cq-mcp` tools/list = 13 (no ask_user_question without channel; the 14-tool with-channel surface proved by the integration test); `tsc -b` exit 0; eslint 0 errors (2 pre-existing warnings untouched). Manual scenario: real-Codex+browser run not deterministically reproducible (no forcing function for the model to call the tool; auth-gated) — closest reproduction is the real-subprocess cross-process round-trip in `askProxy-integration.test.ts`; documented in the log + ASKPROXY-D03. Metrics: review rounds 1; defects <major:0, minor:0, nit:0> (PR-5 itself); verification complete; scope delta none.

- **askproxy-4** (2026-05-29) — Cross-process integration. New `packages/server/test/askProxy-integration.test.ts` (mirrors `internalWs-integration.test.ts`): spawns a real cq-mcp subprocess via `bun run packages/cq-mcp/src/main.ts` against a real `Bun.serve` + `InternalWsService`. The test's `ask.request` handler stands in for the real `AskProxy` — it captures the request and broadcasts a synthetic `ask.reply` (the browser's answer). Three cases: (1) `tools/list` = 14 tools incl. `ask_user_question` when `CQ_INTERNAL_WS_URL`+`CQ_INTERNAL_WS_TOKEN`+`CQ_SESSION_ID` are set; (2) `tools/list` = 13 (no `ask_user_question`) in standalone mode; (3) full round-trip — invoke the tool, assert the server received one `ask.request` with `sessionId=CQ_SESSION_ID`, `askId` matching `^ask-\d+-\d+$`, `toolUseId=askId+"-tu"`, exact questions; assert the tool resolves with the Claude-identical `CallToolResult` (`{content:[{type:"text",text:JSON({questions,answers})}]}`) and `string[]` answers normalised to `"a, b"`. Verification: `bun test askProxy-integration.test.ts` → 3 pass; ran 3× consecutively, stable (no flake despite the inbound-reply-vs-park race — the two-slot broker handles both orderings); `tsc -b packages/server` exit 0; eslint clean. Review: 1 round, 0 defects. Metrics: review rounds 1; defects 0; verification complete; scope delta none.

- **askproxy-3** (2026-05-29) — cq-server side. New `packages/server/src/agent/askProxy.ts`: `buildAskUserQuestionEvent(toolUseId,questions,model)` builds the synthetic assistant `tool_use` (`name:"AskUserQuestion"`, `id:toolUseId`, `input:{questions}`, message id `ask-<toolUseId>`) that the browser's `Stream.tsx` ask renderer keys on; `AskProxy` correlates `toolUseId → {askId,sessionId}` (Map), `onAskRequest` emits via an injected `emit` (wrapped in a chat.event envelope by CodexBridge's `sendEvent` for seq + replay-buffer append) or replies-empty when the session is not active (no hang), `onQuestionReply` resolves the correlation and sends `ask.reply` upstream (dropping stale/mismatched-session replies), `clear()` on shutdown. CodexBridge: constructs an `AskProxy` (new opts `sendAskReply`, `selfPid`), implements `handleChatQuestionReply`→`onQuestionReply`, adds public `handleAskRequest`→`onAskRequest` resolving the live socket from the active session, clears the proxy on shutdown, and threads `CQ_SESSION_ID: chatSessionId` into the spawned cq-mcp env alongside the existing `CQ_INTERNAL_WS_*`. Bridge facade: `handleAskRequest` routes to the Codex backend (drops with a warn when no Codex backend exists), forwards `sendAskReply`. `server.ts` + `devServer.ts`: register the `ask.request` handler on `InternalWsService` and wire `sendAskReply: internalWs.broadcast`. Updated codexBridge.ts module JSDoc (AskUserQuestion now exposed; no system prompt — Codex auto-discovers via tools/list). Verification: `bun test` of the 3 affected files → 28 pass; `bun run check` → **796 pass / 0 fail / 2744 expect() across 92 files** (was 761; +35 cumulative across PR-1..3); `tsc -b packages/server` exit 0; eslint 0 errors (2 pre-existing unused-directive warnings, present on the base — left untouched per surgical-changes). Dispatch airtight: `bridgeFacade.test.ts` proves a Claude-active session's `chat.question_reply` resolves the in-process `AskBroker` (would hang if mis-routed to a proxy), and `codexBridge.test.ts` proves a Codex-active session's reply becomes an `ask.reply` with the matching askId + sourcePid. Design notes for later PRs: (1) server-side has NO reply-before-ask race (browser cannot reply before it renders the synthetic event), so AskProxy needs no buffer slot — unlike the cq-mcp broker. (2) `ask.reply` is broadcast to all connected cq-mcp children; a child that never asked the askId buffers it harmlessly and the buffer dies with the short-lived process (acceptable per the no-reconnect design — noted in defects.md as resolved-by-design). Review: 1 round, 0 blocking defects. Metrics: review rounds 1; defects 0; verification complete; scope delta none (touched exactly the planned files + the 2 wiring entrypoints).

- **askproxy-2** (2026-05-29) — cq-mcp side. New `packages/cq-mcp/src/askBroker.ts` `CqMcpAskBroker`: two-slot race machine keyed by `askId` (`pending` Map + `bufferedReplies` Map), `ask(askId,questions)` → `Promise<{questions,answers}>`, `reply(askId,answers)` resolves-or-buffers, `rejectAll(reason)` rejects all pending + clears buffers + sets a `rejected` flag so a racing `ask()` fails fast. `normaliseAnswers` kept byte-identical to the server `AskBroker` (string[]→comma-join, scalars→String()). Added `InternalWsChannel.registerOnClose(cb)` (+ `fireCloseCallbacks`/`closeFanoutDone`) firing exactly once on either local `close()` or a server-initiated close, synchronously if already closed. `main.ts`: when the channel is up AND `CQ_SESSION_ID` is set, register `ask_user_question` (`z.array(z.any()).min(1).max(4)`, identical signature to the Claude tool), wire `ask.reply`→`broker.reply`, `onClose`→`broker.rejectAll`, and an askId generator `ask-<pid>-<n>`; the tool sends `ask.request{askId,toolUseId:askId+"-tu",sessionId,questions,sourcePid}` then awaits the broker, returning `jsonResult({questions,answers})` — same `CallToolResult` shape as the Claude tool. Standalone mode (no channel) does NOT register the tool. Verification: `bun test packages/cq-mcp/` → 20 pass / 0 fail (was 9; +11: 9 broker + 3 onClose, minus the harness changes); `tsc -b packages/cq-mcp` exit 0; `eslint` 0 errors; `main.test.ts` still asserts the 13-tool standalone surface (green). Surprises: (1) the `StdioClientTransport` default env does not inherit `CQ_INTERNAL_WS_*`, so the existing 13-tool test naturally stays in standalone mode — no change needed. (2) Widening `InternalWsMessage` broke two pre-existing un-narrowed `.ledgerId` accesses in `internalWs.test.ts`; fixed by narrowing on `type` (these were latent — the single-variant union had masked them). (3) The first `onClose` server-close test used `server.stop()` which does not deliver a clean WS close event; switched to an explicit `ws.close()` via a new `closeClient()` fake-server hook. No-hang argument: if the channel closes before/at/after `send`, `onClose`→`rejectAll` (or the `rejected` synchronous guard in `ask`) guarantees the tool handler's awaited promise settles. Review: 1 round, 0 defects (1 unused-eslint-directive nit fixed inline). Metrics: review rounds 1; defects 0; verification complete; scope delta none.

- **askproxy-1** (2026-05-29) — Extended `packages/shared/src/internalProtocol.ts` `InternalWsMessage` discriminated union with `ask.request` (`{askId, toolUseId, sessionId, questions, sourcePid}`) and `ask.reply` (`{askId, answers, sourcePid}`). Added exported `AskQuestions` (`z.array(z.unknown()).min(1).max(4)`, mirrors the Claude tool's 1..4 bound) and `AskAnswers` (`z.record(z.string(), z.unknown())`, mirrors `ChatQuestionReply.answers`). Verification: `bun test packages/shared/test/internalProtocol.test.ts` → 19 pass (was 9; +10); `bun test packages/shared/` → 85 pass / 0 fail; `tsc -b packages/shared` exit 0. Surprise: the existing internalProtocol test used `type:"ask.request"` as its "unknown discriminant" example — repointed to `future.unknown` so it still asserts unknown-type rejection. Review: 1 round, 0 defects. Constraint for later PRs: `sessionId`/`askId`/`toolUseId` are `.min(1)` strings, not UUID-validated, to avoid coupling the internal protocol to the browser UUID format. Metrics: review rounds 1; defects 0; verification complete; scope delta none.

---

## Milestone outer-13 — coherence — DISCHARGED

**Cycle:** coherence (cross-process cache invalidation cq-server ↔ cq-mcp).
**Plan:** [`docs/drafts/20260529-0050-plan-coherence.md`](docs/drafts/20260529-0050-plan-coherence.md).

Sequence (one commit per PR; tag `coherence-N`):

- [x] **coherence-1** — `packages/shared/src/internalProtocol.ts` Zod discriminated-union envelope (`ledger.changed` only this cycle) + path/subprotocol constants + 10 round-trip + negative tests. Commit `627e9a3`.
- [x] **coherence-2** — `FsLedgerStore` + `InMemoryLedgerStore`: `onMutation` ctor hook (fires after every successful write, after lockfile release) + `invalidate(ledgerId)` public method (drops cache, re-reads under per-ledger lock; registry-reload fallback for unknown ids). Mirror in dual-tests abstract suite. Commit `568ace6`. +8 tests.
- [x] **coherence-3** — `packages/server/src/agent/internalWs.ts` (server-side service) + wire `/__internal/cq-mcp` upgrade into `server.ts` + `devServer.ts`; pre-upgrade origin check bypassed for internal path; per-process token authentication via `Sec-WebSocket-Protocol: cq-internal.<token>`; constant-time compare; loop-detection on receive; `RunningServer.internalWsUrl` getter for the bridge. Commit `27da7c4`. +19 tests.
- [x] **coherence-4** — `packages/cq-mcp/src/internalWs.ts` client + `packages/cq-mcp/src/main.ts` startup wiring (5s timeout, exit 2 on failure, standalone-mode preserved when env unset) + `codexBridge.ts` env propagation through `CodexOptions.config.mcp_servers.cq.env`. Commit `ace9f13`. +4 tests.
- [x] **coherence-5** — `packages/server/test/internalWs-integration.test.ts` cross-process integration: spawn real cq-mcp against real cq-server; `create_milestone` + `create_ledger` via stdio MCP; assert cq-server's `FsLedgerStore` sees them within 1s (registry-reload + per-ledger reload paths both exercised). Commit `a31d4f5`. +2 tests.
- [x] **coherence-6** — Discharge: ledger + session log + manual smoke. This commit.

**Discharge metrics:**
- `bun run check`: **761 pass / 0 fail / 0 error / 2651 expect() across 90 files**. Up from outer-12 baseline 718/0/2567 by **+43 net new passing tests** (target +15..+25; we overshot because the abstract-suite contract picked up additional onMutation cases per adapter — 10 shared + 8 dual + 19 server + 4 cq-mcp + 2 integration).
- `bun run e2e` (Playwright): **20 passed / 0 skipped / 0 failed** (1.2m). Unchanged from outer-12 baseline.
- `nix build .#default`: exit 0; `./result/bin/cq-mcp --cwd /tmp/probe-coherence` runs in standalone mode (no env vars set → logs "running without internal WS channel; ledger cache invalidation disabled" + serves stdio MCP); JSON-RPC `initialize` + `tools/list` round-trip returns the 13 msunify tools.
- `tsc -b` clean; `eslint .` 0 errors / 23 warnings (unchanged).
- Manual scenario: covered by the integration test in PR-5 — `bun run dev` against the wired server with a Codex session that calls `mcp__cq__create_ledger` would observe the same convergence within 1s (the integration test's `withMcpClient` exercises the identical path: spawn cq-mcp with env vars, run create_milestone/create_ledger, poll the cq-server-side FsLedgerStore until it picks up the change).

**Non-trivial design decisions made beyond the brief:**
1. **Registry-reload fallback in `FsLedgerStore.invalidate(unknownId)`.** The brief's `invalidate(ledgerId)` contract no-ops when the ledger isn't registered, but a Codex session creating a brand-new ledger via cq-mcp would then be invisible to cq-server forever (the original user-visible defect). Added a registry-lock-protected reload path that picks up newly-registered ledgers on first invalidation. Verified in the integration test's second case.
2. **`archiveMilestone` fires one hook per participating ledger plus the milestones ledger.** The brief said "fires for archiveMilestone" without specifying granularity. Per-participant is correct: each ledger's on-disk file mutated, each one's cache on the OTHER process needs invalidation. The list is computed under-lock so it reflects what was actually written.
3. **Sec-WebSocket-Protocol echo via Bun.serve `headers` option.** Bun doesn't auto-echo the requested subprotocol; the server-side `handleUpgrade` sets `Sec-WebSocket-Protocol: cq-internal.<token>` on `srv.upgrade(req, { data, headers })`. Verified by the cq-mcp client's `subprotocol mismatch` check (rejects if the server selects a different value).
4. **`Bridge.setInternalWsUrl()` setter pattern.** The internal-WS URL depends on the bound port from `Bun.serve(...).port`, which is only known AFTER the server starts. Constructing `Bridge` requires the URL up-front (it propagates through to `CodexBridge` env), so we adopted a one-shot setter called by `server.ts` immediately after `Bun.serve` returns and before any client request can reach the bridge. Tests + production both use the same flow.
5. **`mcp_servers.cq.env` for env propagation.** The codex-sdk's `CodexConfigObject` flattens nested objects into `--config key.sub=value` overrides; passing `{config: {mcp_servers: {cq: {env: {CQ_INTERNAL_WS_URL: "..."}}}}}` becomes `--config mcp_servers.cq.env.CQ_INTERNAL_WS_URL="..."` which the Codex CLI honours when spawning cq-mcp. Verified by reading `node_modules/.bun/@openai+codex-sdk@0.134.0/dist/index.js:304-340` (the `flattenConfigOverrides` / `toTomlValue` pair). The brief flagged this as an open question to verify in implementation — confirmed.

**Defects opened and closed during the cycle:** none (no defects surfaced — every PR passed self-review without finding correctness bugs requiring a fix-round; lint/typecheck nits were inlined fixes in the same PR).

**Session log:** [`docs/logs/20260529-0050-coherence-log.md`](docs/logs/20260529-0050-coherence-log.md).

---

## Milestone outer-12 — msunify — DISCHARGED

(see archived breakdown below)

## Active — outer-12 / msunify

**Cycle:** msunify (unified milestones + ISO timestamps).
**Goal:** breaking refactor of `@cq/ledger` — single dedicated `milestones` ledger; per-ledger milestone tools dropped; non-milestones ledgers reference milestones by ID only; ISO 8601 timestamps everywhere; no migration of legacy data; test fixtures rewritten.
**Baseline (verified d9eef2e):** `bun run check` 689 pass / 0 fail / 2469 expect() across 86 files.
**Plan:** [`docs/drafts/20260528-2100-plan-msunify.md`](docs/drafts/20260528-2100-plan-msunify.md).

Sequence (one commit per PR; tags `msunify-N`):

- [x] **msunify-1** — types + constants + ISO timestamps + bootstrap manifest. Files: `packages/ledger/src/types.ts`, new `packages/ledger/src/constants.ts`. Commit `e3350ff`. `tsc -b packages/ledger`: package source types-only PR; deliberately non-compiling at this point (downstream consumers in core.ts/parser.ts/tests rewritten in PR-2/3/6).
- [x] **msunify-2** — parser + serializer for new format. Files: `packages/ledger/src/parser/{parse,serialize}.ts`. Commit `451d1ca`. New `ParseOpts.isMilestonesLedger`. Bare-id depth-2 for non-milestones (em-dash REJECTED with /msunify/i error). ISO-string timestamps emitted bare; `needsQuoting` bypassed for ISO. New `parseMilestoneItemArchive` / `serializeMilestoneItemArchive` for the milestones-ledger single-item archive shape.
- [x] **msunify-3** — core.ts + adapters for new milestone semantics. Files: `packages/ledger/src/store/{core,LedgerStore,FsLedgerStore,InMemoryLedgerStore}.ts`. Commit `8c191cc`. `LedgerStore` surface changed: per-ledger milestone tools dropped; global `createMilestone/updateMilestone/fetchMilestone/archiveMilestone/listMilestoneItems` added; `fetch(ledgerId)` returns `FetchedLedger` with resolved milestone metadata; `fetchArchive` returns `ArchiveContent` discriminated union. Global `__milestones__` lock + alphabetic per-ledger lock ordering in `archiveMilestone`. Bootstrap of milestones ledger in `FsLedgerStore.init()` (auto-add to ledgers.yaml; auto-create `docs/milestones.md` with `## M0 — active` group). Schema-divergence check refuses to start if a stale `milestones` entry has a different schema.
- [x] **msunify-4** — MCP tool surface (rename + drop + add). Files: `packages/ledger/src/mcp/ledgerTools.ts`, `packages/cq-mcp/src/main.ts`. Commit `5a96a95`. Final count: **13 tools** (8 item/ledger + 5 milestone). Both Claude-side factory and Codex-side stdio binary mirror the same surface; `fetch_ledger_archive` response key renamed `milestone` → `archive` to accommodate the discriminated union.
- [x] **msunify-5** — bridge + cq-mcp + server wiring. NO-OP for source: `claudeBridge.ts:381` calls `createLedgerMcpTools(this.ledgerStore)` opaquely; `server.ts`/`devServer.ts` construct `FsLedgerStore` and rely on auto-bootstrap. Folded into PR-6's commit `cd2efe2` along with test rewrites and the dead-code cleanup that emerged from the diff.
- [x] **msunify-6** — test fixture rewrite + new tests. Files: `packages/ledger/test/{store-abstract,concurrency,mcp-tools,parser-roundtrip,path-traversal}.ts`, `packages/cq-mcp/test/main.test.ts`. Commit `cd2efe2`. Also: dead-code cleanup in `core.ts` (dropped orphan `MILESTONE_ID_RE`/`milestoneIdExists`/`findMilestone`); Phase-1b non-terminal milestone-item check fix in `FsLedgerStore.performArchive`; `.gitignore` extended for `docs/milestones.md` + `docs/.locks/`.
- [x] **msunify-7** — end-to-end + nix build smoke. Verification only (no source). `bun run e2e` → **20 passed / 0 skipped / 0 failed** (1.2m). `nix build .#default` → exit 0. `./result/bin/cq-mcp --cwd /tmp/probe-msunify` JSON-RPC `tools/list` round-trip returns the 13 msunify tool names. Bootstrap-on-init verified: re-init against the same dir is idempotent; the second `enumerate()` returns `["milestones"]` and `createMilestone` allocates `M1`.

**Inner-loop discipline:** Each PR is one commit. Each PR's verification is run before its commit. Full `bun run check` may transiently fail between PR-1 and PR-6 due to ordering of types vs tests; gate is green at PR-6 close. Adversarial review at the END of EACH PR was performed by the orchestrator (S3*) since no subagent dispatcher is available in this thread; the structured risk register in [`docs/drafts/20260528-2100-plan-msunify.md`](docs/drafts/20260528-2100-plan-msunify.md) §"Rollback / risk register" guides per-PR checks.

**Discharge metrics:**
- `bun run check`: **718 pass / 0 fail / 0 error / 2567 expect()** across 86 files. Up from baseline 689/0/2469 by +29 net tests, 0 new failures, +98 expect() calls.
- `bun run e2e` (Playwright): **20 passed / 0 skipped / 0 failed** (1.2m). Unchanged from outer-10 baseline.
- `nix build .#default`: exit 0. `./result/bin/cq-mcp --cwd /tmp/probe-msunify` serves 13 tools via JSON-RPC.
- `tsc -b`: clean. `eslint .`: 0 errors / 23 warnings (unchanged).

**Non-trivial design decisions made beyond the brief:**
1. **Tool count is 13, not 15.** Brief said 15; recount gave 13 (8 item/ledger + 5 milestone). Brief acknowledged "pick the right number".
2. **Auto-create depth-2 group on first `create_item`.** The brief drops per-ledger `createMilestone` from the tool surface but keeps `create_item(ledger, milestoneId, ...)`. The only way to ensure the group exists is to auto-create on first reference (`applyCreateItem` now does this for non-milestones ledgers; the strict-existence check fires BEFORE auto-create so typos still fail).
3. **`fetch_ledger_archive` response shape.** Old: `{milestone:Milestone}`. New: `{archive: {kind:"group"|"item", milestone?:..., item?:...}}` to accommodate the milestones-ledger single-item archive.
4. **`ArchiveContent` discriminated union** rather than two separate fetchArchive methods. Simpler client code; the kind discriminator is checked at the boundary.
5. **`now()` injection switched from numeric to ISO string** — tests using a deterministic tick wrap via `new Date(tick++).toISOString()` so lexicographic ordering still matches numeric (preserving the D-LED-07 monotonicity assertions).
6. **Schema-divergence guard in `init()`.** If a `milestones` entry exists in `ledgers.yaml` with a different schema than `MILESTONES_SCHEMA`, refuse to start. Defends against out-of-band tampering after the library is updated.

**Session log:** [`docs/logs/20260528-2100-msunify-log.md`](docs/logs/20260528-2100-msunify-log.md) (to be written at session end).

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
