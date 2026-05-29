# Clarifications: /plan workflow + Goals tab + Goal ledger

**Context:** Implement a `/plan <text>` workflow that produces a Goal +
a first question batch, loops clarification subagents until scope is
clear, produces milestones + tasks, then loops a reviewer until happy —
all surfaced in a new "Goals" tab. `/plan G01 <text>` continues an
existing goal. This is the deterministic WorkflowRuntime we discussed,
now concretely specified.

**How to answer:** Write on the `Answer:` line under each question.
`(blocks v1)` marks decisions needed before the first cycle; the rest
can be answered later. Reference by ID in chat if convenient.

---

## Q1 — Sequencing: thin model-driven v1, or build the deterministic engine now? (blocks v1)

- **Thin v1 first** (recommended): cycle 1 = `goals` ledger + read-only Goals tab + `/plan` running the whole flow as ONE conductor subagent using the existing vsm-loop/review-loop/question-batch skills wired to ledger MCP tools. Validate UX + ledger shape, then replace the conductor with deterministic phase-control + caps in cycle 2+. Working `/plan` in ~1 cycle; de-risks the big build.
- **Engine now**: build the deterministic WorkflowRuntime (phase machine, schema'd phase outputs, loops, caps) from the start. More robust immediately; multi-cycle before anything is usable.

Answer: engine now

---

## Q2 — Goal ledger: 6th bootstrapped ledger? (blocks v1)

- **Yes, bootstrapped** (recommended): hardcoded `GOALS_LEDGER="goals"`, idPrefix `G`, created on init like milestones/defects/tasks/etc. Schema fields: `{ description: string-required, status, milestones: id[], tags?, sourceRefs? }`. A goal references milestones; milestones reference questions/tasks (existing model).
- Other?

Answer: bootstrapped

---

## Q3 — Goal status values? (blocks v1)

- **`clarifying | planning | planned | building | done | abandoned`** (recommended) — tracks the workflow phase the goal is in. Terminal: `done`, `abandoned`.
- Minimal `open | done | abandoned` — phase tracked elsewhere.
- Other set?

Answer: recommended

---

## Q4 — Where does the user answer questions? (blocks v1)

- **In the Goals tab, inline** (recommended): open questions render as expandable rows under their milestone; the user types answers there at their own pace (the question-batch async philosophy). NOT the mid-stream AskCard.
- Via the AskCard ask flow (modal, one batch at a time, mid-stream).
- In chat as free text, parsed back by a subagent.

Answer: in the goals tab inline. The answers should follow our questions batch philosophy and ledger structure (context/suggestion/free-form answer field)

---

## Q5 — What advances the clarify loop? (blocks v1)

After a question batch is answered, the review subagent runs to check clarity / ask more.

- **Explicit "Continue planning" button per goal** (recommended), enabled once all open questions in the current batch are answered. User controls cadence.
- Auto-advance the moment the last open question is answered.
- A scheduled/background re-check.

Answer: auto-advance until no open questions

---

## Q6 — Loop caps + escalation. (blocks v1 for the engine; advisory for thin v1)

The clarify loop and the plan-review loop need a stop so they don't churn forever.

- **Cap each loop at N rounds (recommend N=5); on hitting the cap, escalate to the user** with the current state and choices {proceed anyway / keep looping / abandon}. (recommended)
- No cap; rely on the reviewer subagent's verdict alone.
- Other N / policy?

Answer: no cap

---

## Q7 — Does `/plan` take over the chat session, or run in its own lane? (blocks v1)

cq is pool=1 (one active session). The workflow dispatches subagents.

- **Own lane, surfaced in the Goals tab** (recommended): `/plan` starts a workflow whose progress + questions live in the Goals tab; the Chat tab stays independent for normal conversation. Workflow subagents run in a dispatch lane separate from the interactive chat session.
- **Takes over the chat session**: the conversation shows each phase as it runs; the Goals tab is just a read view. Simpler dispatch (reuse the existing session), but you can't chat while a plan runs.

Answer: own lane, but we should notify main session about its lifecycle events

---

## Q8 — Backend scope for workflow subagents. (blocks v1)

- **Claude-only for v1** (recommended); Codex later. The workflow conductor/subagents dispatch Claude queries.
- Both Claude + Codex from the start (the runtime dispatches per a chosen backend).

Answer: both

---

## Q9 — Slash-command mechanism. (blocks v1)

cq has no slash commands today (all input is freeform chat).

- **Tiny command registry** (recommended): intercept `/plan` in the input handler; `/plan <text>` = new goal, `/plan G<id> <text>` = continue goal G<id>. Registry is extensible for future commands (`/build`, etc.) but `/plan` is the only one in v1.
- One-off `/plan` parse, no registry.
- Other syntax (e.g. `/plan --goal G01 …`)?

Answer: registry

---

## Q10 — Continuation semantics for `/plan G01 <text>`.

- **Append an increment** (recommended): the continuation produces NEW questions scoped to the added feature, loops clarify, then adds NEW milestone(s)/tasks to the goal. Does NOT mutate already-completed milestones; the goal grows.
- Revise in place: re-open and edit existing milestones/tasks affected by the new feature.
- Other?

Answer: as recommended

---

## Q11 — The mandatory first milestone "produce an actionable specification" — what is its deliverable?

- **The clarified scope + answered questions ARE the spec** (recommended): the spec milestone's "completion" is the converged Q&A + a written scope summary the planner consumes. Subsequent milestones are the actual build.
- The spec milestone holds explicit tasks ("write spec §1/§2/…") that a subagent fills.
- Other?

Answer: as recommended

---

## Q12 — What does "done planning" hand off to?

- **Planning ends with populated ledgers** (recommended): goal + milestones + tasks + answered questions sit ready; execution is a SEPARATE future `/build` flow (or a manual review-loop run). Out of scope for this work.
- Planning auto-rolls into execution (build the first milestone immediately).

Answer: as recommended. There will be /build command for execution

---

## Q13 — Goals-tab badge scope.

- **Total open questions across all goals** (recommended) — the badge nudges the user toward anything awaiting their input.
- Open questions for the active/selected goal only.
- Goals with any open questions (count of goals, not questions).

Answer: as recommended

---

## Q14 — Proposed cycle breakdown (for the engine path; thin-v1 collapses 1–3).

1. `goals` ledger (bootstrapped) + schema + MCP exposure.
2. `/plan` command parsing + WorkflowRuntime skeleton + phase 1 (produce goal + first questions) + persistence + dispatch lane.
3. Clarify loop + planner + plan-review loop, with caps/escalation (Q6).
4. Goals tab UI: list, questions-by-milestone, badge, answer-in-tab, `/plan G01` continuation.

Confirm or adjust the breakdown.

Answer: confirmed

---
