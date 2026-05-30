# Session log — history-e2e-stable (ACTIVITY-01-D03)

Date: 2026-05-30. Worktree `.claude/worktrees/history-e2e-stable`, branch
`history-e2e-stable`, base `a7501ab`. Loop: review-loop (inline phases — no Task
tool in this runtime, per project convention). TERMINATION: **blocked on user
input** (review-loop I6 / brief hard-STOP).

## Original request

TEST-ONLY: stabilize `packages/e2e/tests/plan-workflow-history.spec.ts`, which the
brief stated "PASSES in isolation but FAILS intermittently in the full `bun run e2e`
run". Fix = bump its under-load-tight 10_000/15_000 waits to ~45_000 and add the
WFL-D02 drain teardown. Prove with ≥4 consecutive green full `bun run e2e` (28/28).
Hard constraint: if green requires a production change, STOP and report (real
regression, not a flake); do NOT bump other specs unless they tip from THIS spec's
lingering subprocess.

## What was done (the TEST-ONLY work, applied)

`packages/e2e/tests/plan-workflow-history.spec.ts`:
- Bumped 9 under-load-tight waits 10_000/15_000 → 45_000 (warm-up `waitForIdle`,
  textarea-enabled, History badge/title/producer-row visibility, Detail body +
  "submitted", root Detail visibility + the two `toContainText`). Banner stays
  90_000. Assertions UNCHANGED — only timeout budgets. No `.skip`.
- Added the WFL-D02 drain teardown (`POST /__e2e/workflow-drain` +
  `waitForIdle(45_000).catch`) at the end of the test body, mirroring
  `plan-workflow-loop`/`-goals`/`-continuation`. Verified this was the ONLY
  producer-spawning prelude spec lacking a drain.

`bun run check` → exit 0 (1156 pass / 0 fail; the React `act(...)` stderr line is a
pre-existing warning, not a failure).

## The blocker (ACTIVITY-01-D03) — why the loop halts

The brief's premise did not reproduce. Across 6 runs (1 clean baseline, 4 full runs
post-change, 1 reduced 8-spec run) **`plan-workflow-history.spec.ts` PASSED every
time** (15.8–15.9s). The full suite is red because of a DIFFERENT spec:
`header-badges.spec.ts:29`.

`header-badges.spec.ts:29` asserts `expect(statusBadge).toHaveText(/^(NEW|IDLE)$/,
{timeout:15_000})` after `cq.open()`; it fails with `Received "BUSY (1)"`. Evidence
it is a deterministic PRODUCTION defect, not a load flake nor the history spec:
- 1/1 fail on clean `a7501ab` (my change stashed) — pre-exists, independent of the
  history spec.
- 4/4 fail in consecutive full `bun run e2e` after my change.
- 1/1 fail in `playwright test header-badges --project=main` — this pulls only the 7
  prelude deps + header-badges (8 specs, NOT 28) on an UNLOADED machine; the prelude
  `/plan` specs immediately before all complete in 1.5–6.7s. With 20 fewer specs the
  failure is identical ⇒ NOT cumulative CPU starvation.
- cq-server log (session `096963df`): the auto-started warm-up turn logs
  `bridge.chat_start` + `bridge.chat_started_early`, then NO `chat_input` /
  `chat_started` / `chat_done` for ~15s. The ACTIVITY-01 aggregate (base `a7501ab`)
  latches `BUSY (1)` from `chat_started_early` (turn-in-flight init=true, per
  ACTIVITY-01-D01) on a warm-up turn whose first frame never lands → the badge never
  returns to NEW/IDLE inside the 15s window.

Root cause: a production interaction defect in the freshly-merged ACTIVITY-01 work
(warm-up handshake never delivers the warm-up turn's input, and/or the aggregate
counts a turn that produced no frame). Per the brief, fixing it requires a PRODUCTION
change ⇒ STOP. Per the brief, header-badges does NOT tip from the history spec's
lingering subprocess (it fails with the drain in place and in the 8-spec run), so the
brief forbids masking it with a timeout bump there. Filed ACTIVITY-01-D03 (status
`[!] blocked`, severity major) in defects.md.

## The exact question for the user

The full e2e suite cannot reach 28/28 without a PRODUCTION fix to the ACTIVITY-01
warm-up-turn / badge-latch behavior (`header-badges.spec.ts:29`, `BUSY (1)` never
settles). This is out of scope for the TEST-ONLY brief and is a regression in the
just-merged ACTIVITY-01 feature, not a flake in `plan-workflow-history.spec.ts`.
Decision needed: (a) authorize a production fix (recommended: do not count
`turnInFlight` from `chat_started_early` until the first real frame lands, and/or fix
the warm-up turn to deliver its input), opened as a new non-TEST-ONLY cycle; or
(b) accept the TEST-ONLY history-spec hardening (bump + drain — already applied,
history spec green 6/6) as a standalone defensive commit while header-badges is
tracked separately.

## Ledger state

- `tasks.md`: M-HIST-STABLE / hist-stable-1 → `[!]` blocked; corrected cross-cutting
  finding note.
- `defects.md`: ACTIVITY-01-D03 → `[!]` blocked (major), references WFL-D02 /
  ACTIVITY-01-D01 / D02.

## Metrics

WIP max 1; review rounds 0 (blocked before adversarial review — the repro itself
falsified the brief's premise); verification: gaps (full suite NOT green — blocked on
production defect; history spec 6/6 green; `bun run check` exit 0); audit
discrepancies 1 (brief named the wrong failing spec); algedonic escalations 1
(production regression surfaced under a TEST-ONLY brief → STOP).
