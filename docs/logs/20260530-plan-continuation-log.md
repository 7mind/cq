# Session log — `/plan G<id>` continuation (append-increment)

**Date:** 2026-05-30
**Branch:** `plan-continuation` off main `b1dfb10`
**Worktree:** `/home/pavel/work/safe/cqe/cq1/.claude/worktrees/plan-continuation`

## What shipped

The design-doc **Q10 continuation** for the `/plan` workflow:
`/plan G<id> <text>` now APPENDS AN INCREMENT to an existing goal — it
produces NEW questions scoped to the added feature, loops clarify, then
ADDS new milestone(s)/tasks to the goal WITHOUT disturbing its
existing/completed milestones. Works on BOTH backends (Claude + Codex)
through the existing phase-subagent seam.

Single PR commit `feat(cont-1): …` covering:

- **Routing.** `ws/session.ts` routes the already-parsed `plan_continue`
  command to a new `WorkflowRuntime.continueGoal(goalRef, text, platform,
  emit)` (replacing the not-implemented `startContinuation` stub),
  fire-and-forget like `plan_new`.
- **Gate.** `continueGoal` allows continuation only for a STABLE goal
  (`planned`/`done`). `clarifying`/`planning`/`building` → errored
  ("still being planned" / "building"); `abandoned`/unknown → errored
  with a clear reason. Pool=1 busy-slot honoured.
- **Continuation producer.** Modeled as `CONTINUE_SPEC: PhaseSpec<ProducerOutput>`
  reusing `ProducerOutputSchema` + `submitPhase:"produce"` and a distinct
  `toolName:"submit_continuation"`. It dispatches through the SAME
  `selectPhaseSubagent` seam as the loop phases, so it works on Claude
  (in-process `mcp__wf__submit_continuation`) AND Codex (cq-mcp relay)
  with NO protocol / `codexHeadless` / `WorkflowSubmitProxy` change — the
  proxy validates against the schema registered per dispatch, not a
  phase-name lookup. `buildContinuationPrompt` feeds the producer the
  existing description + milestone titles (read-only) + answered Q&A +
  the new feature text; output = extended description + new scoped
  questions.
- **Harness write (produce).** `writeIncrement` creates a NEW increment
  milestone titled `increment: <feature>`, files the new questions under
  it, APPENDS its id to `goal.milestones` (existing untouched), updates
  the goal description, sets status → `clarifying`, emits `questions_ready`.
- **Append-only planner.** `runPlanner`/`revisePlanWithGuard` route
  through `dispatchPlanner` + `persistPlan`, which detect a continuation
  via the increment-milestone title (`isContinuation`) and use
  `buildContinuationPlannerPrompt` (existing milestones as immutable
  read-only context, "emit ONLY the NEW increment") + `appendPlan`.
  `appendPlan` preserves every milestone up to and INCLUDING the
  increment milestone and replaces only this increment's own draft — so
  revise rounds do not accumulate and pre-existing (incl. `done`)
  milestones/tasks stay byte-identical. Follow-up clarify/review
  questions land under `activeQuestionMilestoneId` (the last milestone
  with questions = the increment milestone for a continuation).
- **Reconcile.** Unchanged. A continuing goal (planned→clarifying→…)
  keys on `derivePosition` (status + open-question count) like any
  clarifying goal; continuation-ness is re-derived from the ledger
  (increment-milestone title), so resume mid-continuation just works.

## How append-only + the gate were proven

**Append-only (airtight).** `workflow-continuation.test.ts` snapshots the
goal's pre-existing milestones — including one marked `done` with its
tasks — and asserts byte-identity (`expect(snapshot).toEqual(before)`):
(a) after the continuation producer appends the increment milestone;
(b) after the continuation planner appends the increment plan; (c) across
a plan-review REVISE round (which replaces the increment draft, not the
originals, and does NOT accumulate increment milestones). The Codex relay
integration test (`workflow-codex-relay-integration.test.ts`) asserts the
original Core task is byte-identical after a full continuation on
platform=codex. The mechanism guarantee: `writeIncrement`/`appendPlan`
only ever CREATE milestones/tasks and APPEND ids; they never `updateItem`
or remove an existing milestone/task. The boundary is the durable on-disk
`increment: ` title prefix — no schema change, survives restart.

**Gate.** `workflow-continuation.test.ts` (describe "continuation gate")
+ `workflow-runtime.test.ts` (unknown goal) cover: `planned` proceeds,
`done` proceeds, `clarifying`/`planning`/`building`/`abandoned`/unknown
each errored with the expected detail substring. `workflow-ws.test.ts`
asserts the routing end-to-end (unknown goal → errored; planned goal →
questions_ready with an appended increment milestone).

## Backends the continuation producer was proven on

- **Claude:** end-to-end via the REAL SDK subprocess + MockAnthropicHTTP
  (`workflow-integration.test.ts`, "continuation producer — REAL SDK")
  AND the mocked-Claude Playwright E2E (`plan-workflow-continuation.spec.ts`).
- **Codex:** fake-codex thread + REAL `WorkflowSubmitProxy` + REAL
  `WorkflowRuntime` (`workflow-codex-relay-integration.test.ts`,
  "continuation producer + append plan run on platform=codex"). A
  real-Codex run was NOT added this cycle — fake-driven accepted per the
  brief (mirrors the prior codexwf cycle).

## Manual scenario (operationalised as the E2E spec)

`plan-workflow-continuation.spec.ts` drives the literal scenario in a real
browser against the mocked backend: `/plan build a local-first notes app`
→ answer inline → `planned` (Core build milestone). Then
`/plan G<id> add end-to-end encryption for attachments` → questions_ready
→ Goals tab shows the goal `clarifying` with a NEW `increment:` milestone
+ the new scoped question while the ORIGINAL "Core build" milestone
remains → answer inline → `planned` with BOTH "Core build" and the
appended "Attachment crypto" increment milestone + its "Key envelope"
task. Green twice.

## Discharge

- `bun run check` — exit 0 TWICE; 986 pass / 0 fail (baseline 968 + 18
  net new tests). Deterministic across both runs.
- `bun run e2e` — 25/25 TWICE (24 baseline + 1 new continuation spec).
  WFL-D02 ordering, LOCK-D01 lock-wait, and the Codex relay specs all
  green (not regressed).
- `nix build .#default` — exit 0.

## Defects

- `CONT-01` — continuation shipped (the design-doc Q10 item).
- `CONT-02` — e2e cross-spec robustness: `plan-workflow-goals.spec.ts`
  selected its goal via `.first()`, which broke once the alphabetically-
  earlier continuation spec added goals to the shared cwd; fixed to
  target the LATEST goal (`.last()`), matching the `/__e2e/answer`
  convention. Playwright project regexes extended to include
  `-continuation`.

## Constraints honoured

No mutation of existing/completed milestones (append-only). No change to
clarify/plan/review loop semantics, the no-progress guard, the escalation
handler, the submit relay, or ledger-write ownership (HARNESS writes;
subagents relay/return only). No sync/async unions. Divergence guard +
lockfile-wait untouched. No schema change to the goals ledger. Goals tab
UI untouched (snapshot already carries everything; the `increment: `
title prefix self-documents the affordance). Main + other worktrees
untouched; no history rewrite.
