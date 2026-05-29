# Plan — cycle 3: make `/plan` converge end-to-end (clarify → plan → review → planned)

**Branch:** `workflow-loops` (worktree `.claude/worktrees/workflow-loops`, off main `9f64579`).
**Backend:** Claude only (Codex seam kept clean; relay is cycle 4+).
**Authoritative design:** `docs/drafts/20260529-1710-questions-plan-workflow.md`.

## Goal (one sentence)

Drive the rest of the `/plan` WorkflowRuntime after phase-1: a human-gated
clarify loop, a planner, and an adversarial plan-review loop, with the
workflow's position derived from the ledgers (not in-memory), a no-progress
liveness guard on the review loop, a `question.answer` inbound frame that
auto-advances exactly once, and resume-on-startup reconciliation.

## Architecture decisions (S5/S4)

### D1 — PhaseSubagent dispatch seam (Codex-ready)
Generalize the `ClaudeProducer` `submit_*`-tool mechanism into a reusable
`PhaseSubagent<I,O>` interface: `dispatch(req: { prompt; signal?; model? }) → Promise<O>`,
where `O` is Zod-validated by a harness-owned in-process MCP submit tool. The
Claude impl (`ClaudePhaseSubagent`) is parameterized by `{ toolName, schema,
buildPrompt }` — it is the producer's `query()` + single in-process tool, lifted
to a generic. Producer becomes one instance of this seam (NOT refactored away
this cycle — keep it; the loop phases use new instances). Codex variant is a
documented stub that rejects (mirrors `CodexProducer`); the loop never branches
on backend — it calls `selectPhaseSubagent(platform, phase)`.

Rationale: the brief requires "abstract the phase-dispatch behind a
`PhaseSubagent`/dispatch interface so the Codex relay variant slots in without
reworking the loop logic." One generic, four phase configs (producer +
clarify-reviewer + planner + plan-reviewer).

### D2 — Workflow state derived from ledgers (closes WF-D02)
No in-memory phase state. The runtime computes a goal's `WorkflowPosition` from:
- goal.status (`clarifying` | `planning` | `planned` | terminal)
- whether the goal's questions are all answered (open count for the goal's
  question rows)
The position is a pure function `derivePosition(store, goalId)`. The only
in-memory state remains: the `active` busy-slot (one concurrent phase dispatch)
and a per-goal "dispatch in flight" guard to prevent double-dispatch.

### D3 — Phases and ledger writes (HARNESS owns every write)
- **Clarify loop**: when the last open question for the goal flips to answered,
  dispatch clarify-reviewer with goal + all Q&A. Output:
  `{ clear, contradictions[], newQuestions[] }`. Not clear → harness writes the
  new questions under the SPEC milestone (status open), emit `questions_ready`,
  wait. Clear → advance to planner.
- **Planner**: dispatch planner with clarified scope + Q&A. Output:
  `{ milestones[{title,description}], tasks[{milestoneRef,headline,description,acceptance?}] }`.
  Harness writes: new milestone items (spec milestone stays M-first; planner
  milestones follow), task items grouped under their milestone via `milestoneRef`
  (index into the returned milestones array → resolved milestone id), all linked
  to the goal (goal.milestones = [specId, ...plannerMilestoneIds]). Goal status →
  `planning`.
- **Plan-review loop**: dispatch plan-reviewer with goal + Q&A + milestones +
  tasks. Output: `{ satisfied, findings[{severity,issue,suggestion}], newQuestions[] }`.
  - satisfied → goal status → `planned`, emit `done` lifecycle frame.
  - not satisfied + newQuestions → write them, emit `questions_ready`, wait for
    answers; on answer re-run the **clarify-reviewer** first (the new answers may
    change scope), then re-plan. Justification: questions reopen scope, so the
    cheapest correct path re-validates clarity before re-planning; this also
    means the plan-review→question path cannot bypass the clarity gate.
  - not satisfied + no newQuestions → re-dispatch the **planner** with the
    findings to revise. Loop.

### D4 — No-progress liveness guard (NOT a round cap; Q6)
On each plan-review round that returns `not satisfied AND no newQuestions`,
compare the planner's just-written milestones+tasks to the PRIOR round's
written set (structural fingerprint: ordered list of milestone titles+descs and
task headlines+descs+acceptance+milestoneRef). If the fingerprint is identical
to the previous revise-round's AND the reviewer again raised no questions →
non-progress → STOP, emit `workflow.event{status:"escalated", detail}` asking
the user {proceed-as-is / give-guidance / abandon}. The loop does not spin.
Fingerprint is stored in-memory per active goal across the review rounds of one
run; on resume it is recomputed from the last written plan, so the guard needs
≥1 fresh revise round after resume before it can fire (acceptable — resume is
rare and a fresh round is genuine progress to observe).

### D5 — `question.answer` frame + auto-advance exactly once
Inbound `question.answer { questionId, answer }`. Handler (HARNESS): write
`answer` into the question item, status open→answered. After the write, the
runtime checks `derivePosition`: if the goal has zero open questions AND a goal
exists in `clarifying`/`planning` with a pending wait-state, auto-advance the
relevant loop. Auto-advance fires ONCE: guarded by the per-goal in-flight latch
(set before dispatch, cleared on completion) plus the open-question-count
transition (only the answer that takes the count 1→0 triggers). Answers to a
goal that still has open questions do nothing but write.

### D6 — Lifecycle events broadcast (not per-connection)
Loop phases run async and `question.answer` may arrive on any connection; the
phase that an answer triggers must notify all clients. Add a runtime-level
event fan-out: `WorkflowRuntime` holds a `Set<WorkflowEventSink>`;
`subscribe(sink)/unsubscribe(sink)` from each WsSession on open/close. The
phase loops emit through the fan-out. The original `/plan` start still also
returns its outcome to the issuing call for the existing tests. New protocol
statuses: add `clarifying`, `planning`, `reviewing`, `planned`, `escalated`,
`done` to the `WorkflowEvent.status` enum and `clarify`, `plan`, `review` to
`phase`.

### D7 — Resume-on-startup reconcile
`WorkflowRuntime.reconcile()` called once after `store.init()` in `server.ts`.
For each goal in non-terminal status: compute position; if it needs a dispatch
(status=clarifying with all questions answered and no in-flight latch → run
clarify-reviewer; status=planning with all questions answered → run
plan-review) → dispatch. Goals waiting on open questions sit idle. Idempotent:
the in-flight latch prevents double-dispatch if reconcile races a live answer.

## Milestones / PRs (commit-per-PR `feat(wfl-N): …`)

- **wfl-1 — PhaseSubagent seam + protocol extensions.** Generic
  `ClaudePhaseSubagent`, phase schemas (clarify-review/plan/plan-review),
  Codex stub, protocol enum extensions + `QuestionAnswer` frame + Zod. Tests:
  schema validation, fake dispatch, protocol round-trip.
  - verify: `bun test` green for new unit tests; `tsc -b` clean.
- **wfl-2 — Loop engine (clarify + plan + review + no-progress guard) in
  WorkflowRuntime, ledger-as-state, fan-out sink.** All phase logic against a
  FAKE PhaseSubagent (canned outputs). Tests: clarify not-clear→Q→answer→re-run
  →clear→plan; planner linkage + status `planning`; review not-satisfied→revise
  →satisfied→`planned`; no-progress guard escalates and does not spin; lifecycle
  ordering incl. escalated + done.
  - verify: new runtime tests green; HARNESS-owns-writes asserted.
- **wfl-3 — `question.answer` WS handler + auto-advance + runtime subscribe;
  reconcile + server wiring.** Tests: answer writes+flips+auto-advances only on
  last; reconcile resumes from ledger state with no double-dispatch; pool=1
  regression still holds.
  - verify: ws tests green; pool=1 regression green; full `bun test` green.
- **wfl-4 — Integration (real Claude SDK via MockAnthropicHTTP) one full
  clarify→plan→review→planned cycle; E2E spec.** Mock keyed on submit-tool-name
  so sequential phases are deterministic. Banner text for planning/planned.
  - verify: integration test green; `bun run e2e` ≥ 23 green.
- **wfl-5 — Discharge.** `bun run check` x2, `nix build`, defects.md rows,
  WF-D02→resolved, session log, manual scenario.

## Risks / assumptions
- R1: mock stickiness defeats multi-phase E2E → mitigate by keying mock on the
  tool name present in the request `tools` array (distinct submit tool per phase).
- R2: auto-advance double-fire under concurrent answers → in-flight latch +
  count-transition guard; test the spin case explicitly.
- R3: `createItem` requires the milestone to be non-terminal/active — planner
  milestones are created fresh (active) so task linkage is valid.
- R4: fan-out must not break the existing per-connection lifecycle tests → keep
  emitting to the issuing sink for the start path AND fan out; tests subscribe.
