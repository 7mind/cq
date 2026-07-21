# Harness flow state machines

The `cq:` command suite is five cooperating **flows** — *investigate*, *plan*,
*research*, *implement*, and the *advance* sequencer that chains the other four.
Each flow is a state machine whose durable state lives in the ledger (the `goals`,
`defects`, `tasks`, `hypothesis`, `questions`, `researches`, `reviews`,
`handoffs` ledgers), never in process memory: every command re-derives its state
from the ledger on each invocation, so a run is idempotent and resumable.

This document is a prose reference for humans. It is the **authoritative
description** of the flow state machines; the phase-2 Flows-tab render-data
module mirrors it by hand (the two share no source of truth — keep them in sync
manually). Every state and transition below is grounded in the command specs
under `commands/cq/` and the agent prompts under `agents/`, cross-checked
against the canonical status lifecycles in
`nix/pkg/cq-ledgers/packages/ledger/src/constants.ts`.

Two vocabularies recur and must not be confused:

- A flow's **states** are usually the `status` values of the ledger item the
  flow drives (a `goals` item for plan, a `defects` item for investigate, a
  `tasks` item for implement). The ledger schema's `transitions` map is the
  hard guard — an illegal jump throws `InvalidTransitionError`.
- A flow's **orchestration sub-states** (e.g. "waiting for the user to answer
  questions", "looping planner↔reviewer") are not ledger statuses; they are
  loop positions in the command. Where a flow stops to wait on the user, it is
  always because an `open` `questions` item gates the next ledger transition.

Each flow that can stop standalone emits exactly one terminal **handoff** record
(the `handoffs` ledger) classifying *why it stopped*: `drained`,
`answers-required`, `mixed`, or `illness-detected`. When a flow is chained under
a wrapping command it SUPPRESSES its own handoff; the outermost wrapper writes
the single authoritative handoff for the whole run.

---

## Overview — the advance sequencer and the cross-flow handoff topology

`/cq:advance` is the top-level sequencer. It drives an end-to-end run by chaining
the four per-flow advance commands to **quiescence**, then writes one run-level
handoff. It is a *command-of-commands* (decision K12: a command may chain another
command; a subagent still cannot). It runs in the main session, dispatches no
subagents of its own (every subagent is spawned by the sub-commands it chains),
and its only direct ledger calls are read-only detection queries plus the single
end-of-run handoff write.

### The five detection predicates

Before each stage `/cq:advance` runs a read-only ledger query (sourced from one
`snapshot()` call) to decide whether that stage has work:

- **P-investigate** — TRUE iff some `defect` has an ACTIONABLE status
  (`open`, `wip`, or `inconclusive`) AND is not blocked solely on an unanswered
  `open` question AND is not already owned by a planning goal. (`root-caused`
  defects are READY-TO-SEED and handled by plan's auto-investigate, so they are
  EXCLUDED here; `resolved`/`wontfix` are terminal, EXCLUDED.)
- **P-seed** — TRUE iff some `defect` has status `root-caused`, severity at or above
  the floor (critical/high), is NOT owned by any LIVE goal (clarifying/planning/planned/building,
  bidirectional linking), and is NOT gated by an open linked question. This gates the
  fix-owning gap: a root-caused defect with no plan-flow goal is a seed candidate.
- **P-plan** — TRUE iff some `goal` is in a movable planning phase: `clarifying`
  with no `open` question linked to it, or `planning` (always movable).
  (`planned`, `building`, `done`, `abandoned` are locked/terminal for planning.)
- **P-research** — TRUE iff some `researches` item has an ACTIONABLE status
  (`open`, `wip`, or `inconclusive`) AND is not blocked solely on an unanswered
  `open` question (an open `questions` item whose `ledgerRefs` name
  `researches:<RS>`); a concluded research satisfies dependent tasks via the
  satisfies-dependency rule.
- **P-implement** — TRUE iff some goal in `planned` or `building` has a
  DAG-ready non-terminal task (status non-terminal and not `blocked`; every
  `dependsOn` entry SATISFIED — each is a `<ledger>:<id>` ref (bare ids
  tolerated as a legacy shorthand) resolved against its TARGET ledger's
  declared satisfies-dependency statuses (tasks: `done`; defects: `resolved`;
  questions: `answered`; researches: `concluded`; a ledger that declares no
  satisfies-dependency set falls back to its terminal statuses), a milestone
  target satisfied when all its tasks are terminal, free-text/unresolvable
  entries and refs to an archived or absent item satisfied by default, and a
  terminal-but-non-satisfying status such as `abandoned`/`wontfix` NEVER
  satisfying; milestone `dependsOn` satisfied; no linked `open` question).

### The cycle

`/cq:advance` repeats, with no fixed iteration cap (bounded by progress, not a
counter):

1. **Investigate stage** — if P-investigate, run `/cq:investigate:advance D`
   inline for each actionable defect NOT owned by a planning goal (those are left
   for plan's auto-investigate, to avoid double-triage — Q57).
2. **Plan stage** — if P-plan, run `/cq:plan:advance` inline (no argument —
   every unlocked goal). Plan-flow OWNS auto-investigate of its goal-linked
   defects. Also advances P-seed (root-caused, unowned defects) and files
   defect-seeded goals for fix planning.
3. **Research stage** — if P-research, run `/cq:research:advance` inline.
   Research-flow drives each actionable `researches` item over a hypothesis
   tree of candidate answers, then writes the research's
   findings/conclusion/recommendation on a confirmed answer.
4. **Implement stage** — if P-implement, run `/cq:implement:advance` inline. A
   just-`planned` goal with no prior implement pass is bootstrapped and built;
   reviewers may file new `open` defects (file-and-defer).
5. **Re-check investigate** — because the implement reviewer may have filed new
   defects, re-evaluate P-investigate at the end of the cycle; if it is TRUE
   again the loop made progress and continues.

It **stops** only when progress is genuinely impossible: a full cycle in which no
stage did work and no new actionable item appeared — i.e. all five predicates
FALSE (everything DRAINED), or every still-actionable item is BLOCKED on an
unanswered `open` user question. The stop is progress-bounded, never
effort-bounded.

### Cross-flow handoff topology

The four flows hand off to one another along these edges (all mediated by ledger
state, never by parsing prose):

```
  user: /cq:investigate <defect>          user: /cq:plan <goal>
            │                                      │
            ▼                                      ▼
   ┌──────────────────┐   seed/extend     ┌──────────────────┐
   │   investigate    │  defect-seeded    │       plan        │
   │  (defects ledger)│ ────goal G───────▶│  (goals ledger)   │
   │                  │  (root-caused)    │                   │
   └──────────────────┘                   └──────────────────┘
            ▲                                      │
            │  file-and-defer                      │ goal reaches
            │  out-of-scope/pre-existing           │ `planned`
            │  defect (status: open)               │ (task DAG ready)
            │                                      ▼
   ┌──────────────────┐   file-and-defer   ┌──────────────────┐
   │  (any reviewer)  │ ───open defect────▶│     implement     │
   │  plan / implement│   (out-of-scope)   │  (tasks ledger)   │
   └──────────────────┘                    └──────────────────┘
```

The labelled handoffs are:

- **investigate → plan** (seed-goal-back-to-plan): on a confirmed root cause the
  investigate flow sets the defect `status: root-caused`, writes
  `rootCause`/`suggestedFix`, and **seeds or extends a defect-seeded plan-flow
  goal** `G` (created in `planning`, never `clarifying`, with `ledgerRefs:
  ["defects:<D>"]` and the confirmed cause embedded in its `description`). It
  then STOPS — file-and-defer, never an inline plan loop.
- **plan → investigate** (file-and-defer-defect-to-investigate): when the
  plan-flow reviewer reports an OUT-OF-SCOPE or pre-existing fault in its
  `defects[]` bucket, the planner files it as an `open` defect linked
  `goals:<G>`. The `/cq:plan:advance` command then re-derives an
  auto-investigate worklist by ledger query and runs `/cq:investigate:advance`
  on those defects itself.
- **plan → implement** (the task DAG): when a goal reaches `planned` (plan
  locked behind a `go-ahead` review and a `locked` decision), the implement flow
  picks up the goal's task DAG and drives the tasks to merge.
- **implement → investigate** (file-and-defer): the implement reviewer's
  `defects[]` bucket is filed as `open` defects linked `tasks:<id>`/`goals:<G>`.
  Implement does NOT auto-launch investigate inline (it is an execution flow);
  the next `/cq:plan:advance` auto-investigate cycle, or a direct user
  `/cq:investigate <D>`, triages them.
- **advance → all four**: the advance sequencer chains the four per-flow
  advance commands and re-derives the predicates each cycle, so the
  investigate→plan→research→implement→investigate topology runs to quiescence.

### Handoff statuses (emitted by every flow)

Every standalone flow stop maps to one `handoffs` status:

| handoff `status`   | meaning |
| ------------------ | ------- |
| `drained`          | the flow processed everything actionable to a terminal/locked state; nothing left. |
| `answers-required` | progress stopped only because actionable items are parked on unanswered `open` questions. |
| `mixed`            | some work landed AND some actionable items remain blocked on `open` questions (`handoffReasons` lists the component reasons, e.g. `[drained, answers-required]`). |
| `illness-detected` | a defect or invariant violation the flow could not get past (e.g. an ill-loop bailout, an unresolved merge conflict). |

All four `handoffs` statuses are terminal (a handoff is an immutable record of
one session's exit state). `/cq:advance`'s end-of-run report classifies the run
as DRAINED / BLOCKED-ON-QUESTIONS / MIXED, mapping to `drained` /
`answers-required` / `mixed` (error/abort → `illness-detected`).

---

## Plan flow

The plan flow turns a greenfield goal into a reviewed, fine-grained task DAG. It
is driven by a single `goals` ledger item and is bootstrapped by `/cq:plan`,
advanced by `/cq:plan:advance` (the planner↔reviewer loop), and extended by
`/cq:plan:follow-up`. The planner brain is the `plan-advance` subagent; the
adversary is the `plan-reviewer` subagent.

### States (the `goals` lifecycle)

The `goals` schema statuses are `clarifying`, `planning`, `planned`, `building`,
`done`, `abandoned`; `done` and `abandoned` are terminal.

- **clarifying** — the goal needs user input before a fine-grained plan can be
  written. The planner files `open` `questions` (linked `goals:<G>`); the goal
  cannot leave `clarifying` while any linked question is `open` (server-enforced).
- **planning** — a plan exists (work milestones + tasks) and the
  planner↔reviewer loop is running over it.
- **planned** — the plan is locked: the reviewer returned `go-ahead` and a
  `locked` `decisions` item links the goal (the server requires that decision
  before accepting `planned`). This is the handoff point to the implement flow.
- **building** — implementation is under way (set when the implement flow starts
  consuming the DAG; `planned → building` is a non-terminal transition).
- **done** — the goal is complete. **GOALS NEVER auto-close**: `building → done`
  is a legal edge but is the USER's action only (the G3-B / M16 invariant);
  neither the planner nor any orchestrator performs it.
- **abandoned** — the goal was dropped (reachable from any non-terminal phase).

The **orchestration sub-state "awaiting-answers"** is not a ledger status: it is
the loop position where `/cq:plan:advance` (or `/cq:plan`) has filed clarifying
questions and stopped, with the goal sitting in `clarifying` on `open`
questions. The user answers in the TUI/web, then re-runs `/cq:plan:advance G`.

### Transitions (labelled)

The legal `goals` transitions and their triggers:

| from → to | trigger |
| --------- | ------- |
| `clarifying → planning` | the planner has enough answered context (or the goal is defect-seeded) to write a grounded plan; it grounds itself, emits work milestones + tasks, and moves the goal to `planning`. |
| `planning → clarifying` (revise edge) | the reviewer returned `revise` with NON-EMPTY `new_questions`; the planner files each as an `open` question and moves the goal back to `clarifying` (await user answers). |
| `planning → planned` | the reviewer returned `go-ahead`; the planner first creates the `locked` `decisions` item, then locks the goal to `planned`. |
| `planned → building` | the implement flow begins consuming the task DAG (non-terminal; may be automatic). |
| `building → done` | **user only** — the user closes the goal in the TUI/web after the delivered work satisfies them. Never automatic. |
| `→ abandoned` | from any non-terminal phase (`clarifying`/`planning`/`planned`/`building`) — the goal is dropped. |
| `planned → planning` (re-open) | reserved for `/cq:plan:follow-up`: adding scope to an already-planned goal. |
| `building → planning` (re-open) | reserved for `/cq:plan:follow-up`: adding scope to a goal whose build is under way. |

Note the `revise` review does NOT itself move the goal; it is the planner's next
state step that consumes the latest review and either revises tasks in place
(`revise` with empty `new_questions`, no phase change), files questions and
steps back to `clarifying` (`revise` with `new_questions`), or locks to
`planned` (`go-ahead`).

### The planner↔reviewer loop (orchestration)

`/cq:plan:advance` loops these steps per goal until the planner returns a
terminal token:

1. **Advance the plan** — spawn the `plan-advance` planner. It performs EXACTLY
   ONE state-driven step and returns one status token:
   - `awaiting-answers` — questions are `open`; stop the loop (user must answer).
   - `review-requested` — a plan was emitted or revised; run the reviewer, then
     continue.
   - `completed` — the goal reached `planned`, or was already past planning.
   - `noop` — nothing to do.
2. **Review the plan** (only on `review-requested`) — spawn the `plan-reviewer`,
   which judges by the canonical `/cq:plan-review` rubric (Fine-grained? /
   Sequenced? / Testable? / Grounded? / Complete?) and writes ONE `reviews`
   item whose `status` IS the verdict (`go-ahead` | `revise`). The loop
   continues so the next planner step consumes it.

The planner and reviewer steps are each **pluggable**: a single-agent fallback
(the native subagent writes the ledger) or a configured multi-agent panel (the
orchestrator launches all active planners/reviewers in parallel and is the sole
writer — planners via generate-N-then-JUDGE+SYNTHESIS, reviewers via
strictest-wins + tagged-union reconciliation). The state machine is identical
either way.

### The `reviews` lifecycle (a sub-state machine)

A `reviews` item records one round's verdict. Both statuses are terminal:

- **go-ahead** — the plan is approved (drives `planning → planned`).
- **revise** — the plan needs changes; carries non-empty `new_questions` and/or
  `criticism` (the invariant: a `revise` must carry something to act on).

### Plan-flow handoffs

- **Defect-aware planning**: if the goal (or its answers) describes a fault, the
  planner models it as an `open` `defects` record PLUS one-or-more fix `tasks`
  (each `ledgerRefs: ["defects:<D>", "goals:<G>"]`, with the defect's
  `dependsOn` carrying the fix-task ids — a bidirectional link). The defect is
  never directly implemented; only its fix tasks are.
- **file-and-defer-defect-to-investigate**: a reviewer's `defects[]` bucket
  (out-of-scope/pre-existing faults) is filed by the planner as `open` defects
  linked `goals:<G>` — file-only, orthogonal to the verdict. After the per-goal
  round, `/cq:plan:advance` re-derives the auto-investigate worklist by ledger
  query (defects linked `goals:<G>` whose status is still ACTIONABLE) and runs
  `/cq:investigate:advance D` inline for each (the plan → investigate edge).
- **defect-seeded resume**: when an inline investigate pass reaches
  `root-caused` and seeds a `planning` goal `G′`, the plan command may
  auto-resume the per-goal round on `G′` in the same session (it skips
  clarification). The auto-investigate axis is bounded by concrete stop
  predicates (once-per-round; no relaunch without new confirmed evidence; stop
  on convergence; stop on a non-converging or two-dead-round cycle), not by a
  numeric cap.
- **plan → implement**: a goal in `planned` is the implement flow's entry signal.

`/cq:plan` and `/cq:plan:follow-up` bootstrap the goal (create / re-open) and
hand the first round to the planner, then write the standalone handoff. A fresh
or re-opened goal typically lands `awaiting-answers` (handoff `answers-required`).

---

## Research flow

The research flow answers an empirical research question by driving a hypothesis
tree of candidate answers, mirroring the investigate flow's shape. It is driven
by a single `researches` ledger item, advanced one research round per invocation
by `/cq:research:advance`. The loop lives in the command (subagents cannot spawn
subagents); the `research-explorer` is a read-only evidence gatherer and the
`research-experimenter` is its execution-capable sibling (runs probes in a
throwaway worktree on a `probeRequest`). Neither writes the ledger or
adjudicates — the command validates every citation and sets node status itself.
When a research concludes (`concluded` status), it satisfies dependent tasks via
the satisfies-dependency rule (only `concluded` satisfies a `researches:RS`
dependency). A research that remains `inconclusive` may be re-opened when new
evidence emerges.

### States (the `researches` lifecycle)

The `researches` schema statuses are `open`, `wip`, `concluded`, `inconclusive`,
`abandoned`; `concluded` and `abandoned` are terminal.

- **open** — intake. A freshly filed research question. From `open` the only
  edges are to `wip` or straight to `abandoned`. There is **no
  `open → concluded` edge** and no `open → inconclusive` edge.
- **wip** — active research in progress. The flow MUST move an `open` research
  to `wip` when exploration begins (so the later `concluded`/`inconclusive`
  write is legal). Evidence is gathered and synthesized while the research is
  `wip`.
- **concluded** — the research question is answered with findings and a
  recommendation. Reachable ONLY from `wip`. Only `concluded` satisfies
  dependent tasks.
- **inconclusive** — research did not converge to a definitive answer; a
  re-openable hold. Reachable ONLY from `wip`; it returns to `wip` (on new
  evidence) or is abandoned (`abandoned`).
- **abandoned** — terminal; **USER-INITIATED ONLY**. The autonomous flow never
  transitions a research to `abandoned` and never solicits that disposition; a
  non-converging research is `inconclusive`, not `abandoned`.

### Transitions (labelled)

| from → to | trigger |
| --------- | ------- |
| `open → wip` | research begins this round (exploration about to happen). Mandatory before any adjudication write. |
| `open → abandoned` | the research is dropped (user-initiated). |
| `wip → concluded` | sufficient evidence converges on a definitive answer with findings and recommendation. |
| `wip → inconclusive` | research was conducted but no clear answer emerged. |
| `wip → abandoned` | the research is dropped (user-initiated). |
| `inconclusive → wip` | new evidence emerged; re-open research. |
| `inconclusive → abandoned` | the research is abandoned (user-initiated). |

### The research round (orchestration)

One `/cq:research:advance` invocation = one round:

1. **READ state** from the ledger; if parked on an unanswered `open` question,
   skip to report. Move `open → wip` if research is about to happen.
2. **FORM hypotheses** — seed disjoint candidate answers and/or drill an
   `uncertain` branch of the tree.
3. **DISPATCH explorers** — `research-explorer` subagents gather read-only
   evidence; parallel for disjoint roots, serial while drilling a branch.
4. **VALIDATE citations + adjudicate** — re-check every citation; set each
   node's status; dispatch a `research-experimenter` into a throwaway worktree
   (harvest-then-discard) when an explorer returns a `probeRequest`.
5. **CONFIRMED answer → CONCLUDE** — set the research `concluded` and write its
   `findings`/`conclusion`/`recommendation` fields (pure narrative, in-ledger),
   then — per Q269's no-working-tree-write discipline — route the FULL cited
   synthesis (question, adjudicated tree, every `[correct]` citation with
   verbatim excerpt) as a SEPARATE markdown artifact through `cq log put` to
   `.cq/logs/<ts>-research-<RS>.md`, recorded in the item's `sessionLogs`.
6. **NEEDS user input → file an `open` question and STOP** — only for a genuine
   requirements/preference ambiguity, a decisive experiment that cannot be
   produced from the repo or the reachable web, or missing external access.
   Never a whether-to-answer / out-of-scope / magnitude disposition question.

### Research-flow handoffs

- The standalone stop maps to a handoff: `drained` (concluded, or nothing
  actionable), `answers-required` (parked on a step-6 question), `mixed`, or
  `illness-detected`. Suppressed when chained under `/cq:advance` (the wrapper
  writes the single run-level handoff).
- A concluded research satisfies its dependent tasks; a dependent task blocked
  on an inconclusive research awaits either a research re-opening (answering the
  gating `open` question) or user action.

---

## Investigate flow

The investigate flow finds and confirms the root cause of a defect, then
file-and-defers the fix to the plan flow. It is a DFS over a hypothesis tree,
driven by a single `defects` ledger item, bootstrapped by `/cq:investigate` and
advanced one research round per invocation by `/cq:investigate:advance`. The
loop lives in the command (subagents cannot spawn subagents); the
`investigate-explorer` is a read-only evidence gatherer and the
`investigate-prober` is its execution-capable sibling (runs probes in a throwaway
worktree). Neither writes the ledger or adjudicates — the command validates every
citation and sets node status itself.

### States (the `defects` lifecycle)

The `defects` schema statuses are `open`, `wip`, `root-caused`, `inconclusive`,
`resolved`, `wontfix`; `resolved` and `wontfix` are terminal.

- **open** — intake. A freshly filed defect. From `open` the only edges are to
  `wip` or straight to a terminal (`resolved`/`wontfix`). There is **no
  `open → root-caused` edge** and no `open → inconclusive` edge.
- **wip** — investigation in progress. The flow MUST move an `open` defect to
  `wip` the moment real research begins (so the later `root-caused`/`inconclusive`
  write is legal). Hypotheses are seeded/drilled while the defect is `wip`.
- **root-caused** — the queryable file-and-defer gate: a hypothesis node reached
  `confirmed`, the root cause is pinned (captured in the free-text `rootCause`
  field), and the fix is deferred to a defect-seeded goal. Reachable ONLY from
  `wip`. It can resolve, be abandoned (`wontfix`), or return to `wip`.
- **inconclusive** — investigation did not converge; a re-openable hold.
  Reachable ONLY from `wip`; it returns to `wip` (on a new lead) or is abandoned
  (`wontfix`).
- **resolved** — terminal; the defect's fix tasks all merged (closed by the
  implement flow, not by investigate).
- **wontfix** — terminal; **USER-INITIATED ONLY**. The autonomous flow never
  transitions a defect to `wontfix` and never solicits that disposition; the
  default disposition of every non-terminal defect is FIX.

### Transitions (labelled)

| from → to | trigger |
| --------- | ------- |
| `open → wip` | research begins this round (hypotheses about to be formed / explorers about to be dispatched). Mandatory before any adjudication write. |
| `open → resolved` / `open → wontfix` | direct terminal (e.g. user closes it); not an autonomous investigate path. |
| `wip → root-caused` | a hypothesis node reached `confirmed`; the root cause is pinned. Triggers the file-and-defer handoff (step 5). |
| `wip → inconclusive` | the tree was investigated but nothing was pinned and no further branch is adjudicable from available evidence. |
| `wip → resolved` / `wip → wontfix` | terminal (resolved by a fix; `wontfix` is user-initiated). |
| `root-caused → wip` | a later round re-opens the cause for more drilling. |
| `root-caused → resolved` / `root-caused → wontfix` | the fix landed, or the user abandoned it. |
| `inconclusive → wip` | a new lead emerged; re-open investigation. |
| `inconclusive → wontfix` | the user abandoned it. |

### The hypothesis tree (a sub-state machine)

The tree IS the `hypothesis` ledger; each node is a `hypothesis` item with
`parentHypothesis` encoding ancestry and `evidence[]` holding validated
citations (each prefixed `[correct]`/`[incorrect]`). The `hypothesis` statuses
are `open`, `uncertain`, `confirmed`, `wrong` (terminal: `confirmed`/`wrong`):

| from → to | trigger |
| --------- | ------- |
| `open → uncertain` | partial `[correct]` evidence; the node warrants drilling into children next round. |
| `open → confirmed` / `uncertain → confirmed` | `[correct]` evidence establishes the root cause. |
| `open → wrong` / `uncertain → wrong` | `[correct]` evidence rules the candidate out. |

Adjudication keys ONLY on `[correct]` evidence (the orchestrator re-opens every
cited `file:line` / re-fetches every URL and compares against source before
trusting it); `[incorrect]` citations are ignored.

### The research round (orchestration)

One `/cq:investigate:advance` invocation = one round:

1. **READ state** from the ledger; if parked on an unanswered `open` question,
   skip to report. Move `open → wip` if research is about to happen.
2. **FORM hypotheses** — seed disjoint roots and/or drill an `uncertain` branch.
3. **DISPATCH explorers** — parallel for disjoint roots being seeded, serial
   while drilling a single branch.
4. **VALIDATE citations + adjudicate** — re-check every citation; set each
   node's status; dispatch an `investigate-prober` into a throwaway worktree
   (harvest-then-discard) when an explorer returns a `probeRequest`.
5. **CONFIRMED → file-and-defer** — on a confirmed root cause, set the defect
   `root-caused`, write `rootCause`/`suggestedFix`, seed/extend the
   defect-seeded goal, file a tracking question, and STOP.
6. **NEEDS user input → file an `open` question and STOP** — only for a genuine
   requirements ambiguity, an unreproducible repro, or missing external access.
   Never a fix-vs-wontfix / out-of-scope / blast-radius disposition question.

### Investigate-flow handoffs

- **seed-goal-back-to-plan** (investigate → plan): the step-5 file-and-defer —
  defect `root-caused` + a defect-seeded `planning` goal. *Standalone*: the
  filed question instructs the user to run `/cq:plan:advance G`. *Auto-launched
  inside plan*: the parent plan session resumes `G` automatically.
- The standalone stop maps to a handoff: `drained` (root-caused or all leaves
  resolved), `answers-required` (parked on a step-6 question), `mixed`, or
  `illness-detected`. Suppressed when chained under a wrapping flow command.

---

## Implement flow

The implement flow executes a plan-flow roadmap: it drives `tasks` to completion
in isolated git worktrees, reviews each adversarially, fixes criticism
autonomously, and merges back in dependency order. It is driven by `tasks` ledger
items, bootstrapped by `/cq:implement:start` (scope resolution + DAG validation)
and advanced by `/cq:implement:advance`. The loop lives in the command; it drives
`implement-worker`, `implement-reviewer`, and `implement-conflict-resolver`
subagents (the latter two always at the most-capable model).

### States (the `tasks` lifecycle)

The `tasks` schema statuses are `planned`, `wip`, `done`, `blocked`,
`abandoned`; `done` and `abandoned` are terminal.

- **planned** — the task exists in the DAG and is awaiting pickup (the
  plan-flow's output).
- **wip** — a worker is implementing the task in its worktree
  (`implement/<taskId>`).
- **blocked** — the task is parked on an `open` question: either the reviewer
  returned `questions`, or the autonomous criticism loop hit an ill-loop
  bailout, or a merge-back conflict the resolver could not fix. A reversible
  hold (its worktree is left intact).
- **done** — the task's worker passed, the reconciled reviewer verdict was
  `approve`, `bun run check` was green, and the branch merged back into the
  integration target. Terminal.
- **abandoned** — the task was dropped. Terminal.

### Transitions (labelled)

| from → to | trigger |
| --------- | ------- |
| `planned → wip` | the orchestrator dispatches a worker for a DAG-ready task. |
| `wip → blocked` | the reviewer returned non-empty `questions`, or the criticism loop bailed as an ill loop, or a merge conflict could not be resolved — an `open` question is filed and the task parked. |
| `blocked → planned` | resume bookkeeping: the task's blocking `questions` are now all `answered`, so it is flipped back and re-dispatched with the answer folded in. |
| `wip → done` | the success gate passed (green check + reconciled `approve`) AND the branch rebased and merged back cleanly. Sets `resultCommit`/`completion`. |
| `planned → blocked` / `wip → blocked` | reversible hold (see above). |
| `→ done` / `→ abandoned` | terminal from any non-terminal state (`done` via the success gate; `abandoned` if dropped). |

### The pass (orchestration)

`/cq:implement:advance` repeats until no task is ready:

1. **Derive the READY-SET** — resume any `blocked` task whose questions are now
   answered (`blocked → planned`); a task is READY iff non-terminal and not
   `blocked`, every `dependsOn` entry satisfied per its target ledger's
   satisfies-dependency statuses (tasks: `done`; defects: `resolved`;
   questions: `answered`; undeclared → terminal statuses; milestone target →
   all its tasks terminal; free-text/archived/absent refs satisfy by default;
   `abandoned`/`wontfix` never satisfy), its milestone's `dependsOn`
   satisfied, and no linked `open` question.
2. **Dispatch workers** — up to N = 8 concurrently; set each `planned → wip` and
   dispatch an `implement-worker` into an isolated worktree.
3. **Review** — run the reviewer panel (single native `implement-reviewer`, or a
   configured panel reconciled strictest-wins + union) against the worktree
   diff. The reconciled verdict is `approve` ONLY when ALL surviving reviewers
   approve AND `bun run check` is green; any `disapprove` makes it `disapprove`.
   File the reviewer's `defects[]` bucket (file-and-defer — see handoffs).
4. **Autonomous criticism loop** — on `disapprove` with non-empty `criticism`
   and empty `questions`, re-dispatch the same worker in the same worktree with
   the criticism, then re-review. No fixed cap; stops (→ bailout) on an ILL LOOP
   (no file changes, criticism not shrinking, or the same check failure
   recurring).
5. **Register questions** — on reviewer `questions` or an ill-loop bailout, file
   an `open` question and set the task `blocked` (`wip → blocked`).
6. **Success gate** — a task succeeds only with green check AND reconciled
   `approve`; only succeeded tasks merge.
7. **Merge-back** — sequential, in DAG order, rebase-before-merge. On a clean
   rebase, fast-forward merge and set the task `done`. On conflict, dispatch the
   `implement-conflict-resolver`; on its `fail`, treat as a question bailout
   (park `blocked`). When a merged task fixes a defect, close that defect to
   `resolved` once ALL its fix tasks are `done` (orchestrator-owned closure).
8. **Loop** — re-derive the ready-set; continue until empty.

### The `reviews` lifecycle (one per task)

The orchestrator records exactly ONE terminal `reviews` item per task (from the
reconciled verdict): `go-ahead` (approved + green) or `revise` (otherwise). The
reviewers themselves write nothing.

### Milestone completion

A milestone auto-closes+archives iff EVERY item under it (across all ledgers,
including `defects`) is terminal, AND — if it is a coordination milestone (has a
`goals` item) — that goal is itself terminal. A filed defect does NOT gate task
merge-back but DOES gate milestone archival. **GOALS NEVER auto-close**; the
orchestrator reports a goal as ready-to-close and the user sets `building → done`.

### Implement-flow handoffs

- **plan → implement** (entry): the implement flow consumes the task DAG of a
  goal in `planned`/`building`.
- **implement → investigate** (file-and-defer): the reviewer's `defects[]` (out-
  of-scope / pre-existing faults) are filed as `open` defects linked
  `tasks:<id>`/`goals:<G>` — file-only, independent of the verdict, never
  blocking the in-scope task. Implement does NOT auto-launch investigate inline
  (Q43); the next `/cq:plan:advance` auto-investigate cycle (or a direct user
  `/cq:investigate <D>`) triages them.
- The standalone stop maps to a handoff: `drained` (ready-set drained, all
  reachable tasks merged), `answers-required` (tasks blocked on questions),
  `mixed`, or `illness-detected` (ill-loop / merge-conflict / invariant
  violation). Suppressed when chained under `/cq:advance` or
  `/cq:implement:start` (the per-archive ledger commits still fire either way).

---

## Cross-reference — ledger status lifecycles

For grounding, the canonical status lifecycles (from
`nix/pkg/cq-ledgers/packages/ledger/src/constants.ts`) each flow drives:

| ledger | statuses (terminal in **bold**) | flow that drives it |
| ------ | ------------------------------- | ------------------- |
| `goals` | clarifying → planning → planned → building → **done** / **abandoned** (planning ↔ clarifying; planned/building → planning re-open for follow-up) | plan |
| `defects` | open → wip → {root-caused \| inconclusive} → **resolved** / **wontfix** (root-caused/inconclusive ↔ wip) | investigate (non-terminal); implement (resolved via fix) |
| `tasks` | planned → wip → **done** / **abandoned** (blocked ↔ planned/wip) | implement |
| `hypothesis` | open → uncertain → **confirmed** / **wrong** | investigate (internal tree) |
| `questions` | open → **answered** / **withdrawn** | all (the user-pause gate) |
| `researches` | open → wip → {**concluded** \| inconclusive} → **abandoned** (inconclusive ↔ wip) | research |
| `reviews` | **go-ahead** / **revise** (both terminal — immutable per-round record) | plan, implement |
| `decisions` | proposed → **locked** / **superseded** | plan (the `locked` plan-approval decision gating `planned`) |
| `handoffs` | **drained** / **answers-required** / **mixed** / **illness-detected** (all terminal) | every flow's stop record |
| `milestones` | open → **done** (postponed/blocked ↔ open) | all (auto-close+archive sweep) |

Each flow's stop is **progress-bounded, never effort-bounded**: it stops only
when its own stop predicate fires (a terminal token, everything blocked on an
`open` user question, or an ill-loop bailout) — never because a run is long,
costly, or "a natural milestone" was reached.
