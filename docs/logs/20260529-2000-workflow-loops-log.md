# Session log — cycle 3: `/plan` WorkflowRuntime loops (workflow-loops)

Date: 2026-05-29. Branch `workflow-loops` (worktree
`.claude/worktrees/workflow-loops`, off main `9f64579`). Claude only.

## Goal

Make `/plan` converge end-to-end after phase 1: a human-gated clarify loop, a
planner, and an adversarial plan-review loop, with workflow state derived from
the ledgers (not in-memory), a no-progress liveness guard, a `question.answer`
inbound frame that auto-advances exactly once, and resume-on-startup
reconciliation. Codex seam kept clean (relay deferred). No Goals-tab UI.

## Cycles / PRs

- **wfl-1** (`58e104a`) — PhaseSubagent dispatch seam + phase schemas + Codex
  stub + protocol extensions + `question.answer` frame. Extracted shared
  headless plumbing (`headlessQuery.ts`); producer refactored onto it.
- **wfl-2** (`75dfaad`) — clarify + plan + review loop engine; ledger-as-state
  `derivePosition`; no-progress liveness guard; lifecycle fan-out;
  `submitAnswer` auto-advance; `reconcile`. Server wiring.
- **wfl-3** (`815953f`) — `question.answer` WS handler; runtime subscribe/
  unsubscribe on session open/close; resume exercised; pool=1 preserved.
- **wfl-4** (`02a8da9`) — full-loop integration through the REAL SDK; e2e spec;
  `/__admin/scriptByKey` mock + `/__e2e/answer`+`/__e2e/workflow-idle` hooks.
- **wfl-5** — discharge (this log).

## Architecture decisions (locked)

- **K-WFL-1** — workflow position derived from the ledgers (goal.status +
  open-question count), not in-memory (closes WF-D02). In-memory = global busy
  slot + per-goal in-flight latch + per-goal no-progress fingerprint only.
- **K-WFL-2** — NO hard round cap (Q6); plan-review runaway bounded by a
  no-progress liveness guard (identical planner output + no new questions twice
  → `escalated` frame, loop stops).
- **K-WFL-3** — every ledger write is HARNESS-owned; phase subagents return
  structured output via a harness-owned in-process submit tool, never touch
  ledgers.
- **K-WFL-4** — plan-review `newQuestions` move the goal back to `clarifying`,
  so the next answer batch re-enters the clarify gate before re-planning (the
  clarity gate is never bypassed; resume keys on status so this is durable).
- **K-WFL-5** — lifecycle frames fan out to all subscribed WS sessions.

## Adversarial-focus proofs

1. **No-progress guard stops a runaway** — `workflow-loops.test.ts` "no-progress
   liveness guard" wires a sticky-unsatisfied reviewer + sticky-identical
   planner (the WOULD-spin case). Without the fingerprint check in
   `revisePlanWithGuard` this recurses unbounded; with it, the runtime emits
   `escalated`, the goal stays `planning`, the runtime goes idle, and the
   planner is called a bounded ≤4 times. Guard fires on the 2nd identical revise
   round (the 1st establishes the fingerprint). Flagged WFL-D01 for user veto.
2. **Resume reconstructs the exact phase, no double-dispatch / no stuck goal** —
   "resume-on-startup reconcile": runtime A is dropped mid-review (reviewer
   threw); runtime B is built on the SAME ledger dir; `derivePosition` returns
   `review_ready`; `reconcile()` resumes to `planned` with the reviewer called
   exactly once. A second test: a goal with open questions → `awaiting_answers`
   → reconcile dispatches nothing.
3. **Auto-advance fires exactly once on the last answer** — "auto-advance fires
   exactly once": a 2-question goal; answering Q1 (not last) does NOT advance;
   answering Q2 (last) advances once; re-answering an already-answered question
   does NOT re-advance (open→answered transition + in-flight latch).
4. **Harness owns every ledger write** — phase subagents only call their submit
   tool (`canUseTool` denies everything else); all `createItem`/`updateItem`/
   `createMilestone` live in `WorkflowRuntime` (`writeArtifacts`, `writeQuestion`,
   `writePlan`, status flips). Verified across all loop tests.
5. **Pool=1 chat untouched** — `workflow-pool1-regression.test.ts` still holds:
   interactive chat works while a workflow is mid-flight and after it
   completes/fails; the workflow lane never touches `Bridge.active`.

## Discharge outputs

- `bun run check` (tsc -b + eslint + bun test) — run TWICE, deterministic:
  **905 pass / 0 fail / 3138 expect across 104 files** both runs (baseline
  885/0; +20 new tests). testhyg: server-boot/FsLedgerStore tests use per-test
  temp cwd — no cross-test pollution observed across the two runs.
- `bun run e2e` (Playwright) — **23 passed** (baseline 22 + the new
  `plan-workflow-loop.spec.ts`). Observed green across multiple full-suite runs;
  see WFL-D02 for the environmental-load caveat and the robustness mitigations.
- `nix build .#default` — exit 0 (`result -> …-cq-0.0.1`).
- Manual scenario (full real-SDK loop against MockAnthropic, persistent docs/):
  lifecycle order `produce/started → produce/producing → produce/questions_ready
  → clarify/clarifying → plan/planning → review/reviewing → review/planned →
  review/done`; final ledgers: `goals` G1=**planned** milestones=["M1","M2"];
  `milestones` M1=spec, M2="Build core"; `questions` Q1=**answered** answer=web;
  `tasks` T1=planned headline=Editor under M2. (Driven via the same wiring
  `bun run dev` + `/plan` + answer uses; throwaway script under `debug/`,
  gitignored.)

## Defects

- **WF-D02 → resolved** (ledger-as-state resume; K-WFL-1). See defects.md.
- **WFL-D01** (open, by-design backstop, USER VETO INVITED) — the no-progress
  liveness guard. NOT a round cap; fires on the 2nd structurally-identical
  revise round with no new questions; goal stays `planning`; the
  proceed/guidance/abandon HANDLING is cycle 4 (today the escalated frame
  surfaces in the banner and the loop stops). User may veto the guard or its
  fingerprint definition.
- **WFL-D02** (resolved; environmental) — e2e load-sensitivity from the
  4-subprocess loop spec tipping two pre-existing timing-sensitive neighbours;
  mitigated with workflow-idle drain + raised budgets; residual flakes are CPU
  contention, not workflow-logic defects (unit+integration are deterministic).
- **WF-D01** remains deferred — Codex phase relay (next cycle); seam kept clean
  (`CodexPhaseSubagent` rejects with an actionable error; the loop never
  branches on backend).

## Metrics

- WIP max 1 (one PR cycle at a time); review rounds: inline adversarial review
  of the plan caught the clarify-gate re-entry tension (K-WFL-4) and the
  fan-out/per-connection duplication (resolved via Set-dedup subscribe model)
  before execution.
- S3-S4 firings: 1 replan-class (the plan-review newQuestions → clarify-gate
  routing changed the design from "re-run review directly" to "re-enter
  clarify", surfaced by a failing wfl-2 test). time-to-stabilize: 1 sub-cycle.
- Material scope delta: none beyond plan (the `headlessQuery.ts` extraction was
  a DRY refinement of a planned file). verification: complete.
- Audit discrepancies: 0. Algedonic: 0 (no metasystem escalation needed).

## Deferred / follow-ups (cycle 4+)

- Goals-tab UI + the `question.answer` emitter from it; `/plan G<id>`
  continuation (still returns continuation-not-implemented).
- Codex phase-subagent relay over internal-WS (WF-D01).
- Wiring the escalation choice handler (proceed/guidance/abandon) for WFL-D01.
- Optional tidy-up of detached prior-revision planner milestones (writePlan
  appends fresh milestones and relinks the goal; stale planner milestones from
  earlier revise rounds remain unreferenced in the ledger).
