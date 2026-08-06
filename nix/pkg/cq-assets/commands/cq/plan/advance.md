---
description: Advance one or all unlocked goals through guarded planning, review, and defect investigation until planned or waiting.
argument-hint: [goalId]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:ledger-response-contract}}

## Catalogue

```yaml
inputs:
  - "optional goal id; empty selects every clarifying/planning goal"
  - "full goal, answered questions, current draft, latest review, planner/reviewer configuration"
outputs:
  - "guarded claim lifecycle, one current draft, one review per round, final executable manifest or a waiting state"
  - "inline investigation of actionable defects filed by the round"
  - "standalone handoff"
ioSchema:
  - "planner result: typed PlanStepResult or candidate DAG"
  - "review result: {summary,verdict,new_questions[],criticism[],defects[]}"
  - "one active fenced claim per goal and one terminal claim operation per round"
```

You orchestrate the planner-reviewer loop. Children do not own guarded plan
state. Claim before planner dispatch, keep the claim through draft/review
iterations, and end it only by pause, abandon, or finalize.

{{cq:fragment:subagent-dispatch}}

## Select goals

With an argument, target that goal. Without one, fetch all active goals and
select `clarifying` or `planning`. Never create a goal here. An empty target set
means the flow is drained; autonomous defect seeding belongs to the outer
advance command.

Advance goals independently. A waiting goal does not prevent other targets
from progressing.

## Per-goal loop

Each iteration must dispatch a child or change state. Stop after a terminal
token or two consecutive read-only passes. Terminal tokens are
`awaiting-answers`, `awaiting-research`, `completed`, and `noop`.

When `CQ::plan/follow-up` transfers an acknowledged active follow-up claim,
retain its claim id, generation, and fence token and resume at **§2. Resolve
planners and dispatch** with that claim. Do not run §1 or mint an initial claim.
Only this explicit in-memory transfer bypasses §1; every normal invocation
starts at the pre-claim gate.

### 1. Pre-claim gate and claim

Read the goal and exact goal-linked questions/research waits.

- An open question → `awaiting-answers`.
- Any waited research in `open`, `wip`, or `inconclusive` →
  `awaiting-research`.

Otherwise mint a fresh request id and secret fence token and call `claim_plan`
with `purpose: "initial"` and the observed plan generation. Keep the
acknowledged claim id, generation, and token in memory; never log the token.

Treat claim conflicts as follows:

- active claim: report the goal busy;
- active research wait: `awaiting-research`;
- stale generation: reread and retry once;
- terminal/phase conflict: report and skip;
- request reuse or fence mismatch: stop with an invariant failure.

### 2. Resolve planners and dispatch

Read `ledger::get_config("planners")` once. Honor any session override.

#### Single-planner fallback

Dispatch `plan-advance` in default mode with the goal id. It returns one
schema-valid PlanStepResult and writes nothing. Reject the whole result on any
contract failure; never apply a valid prefix.

Apply exactly one matching guarded operation using the active claim. Mint a
fresh operation id for a new intent and reuse it only when retrying the exact
same payload after a lost response. Supply `defectsToFile` as the same
operation's `reviewDefects`.

- `questions` → pause with question drafts; goal returns to `clarifying`;
  token `awaiting-answers`.
- `researches` → pause with research drafts; goal remains `planning` with
  `waitingResearches`; token `awaiting-research`.
- `draft` → publish the complete manifest; claim stays active; token
  `review-requested`.
- `finalize` → finalize the exact current draft using the named go-ahead
  review and decision; goal becomes `planned`; token `completed`.
- `awaiting` or `noop` → abandon the claim without effects; corresponding
  terminal token.

Persist optional grounding on the goal. `release_plan_claim(kind: "abandon")`
uses the public claim id/generation and no fence token; pause, publish, and
finalize require the token. On a lost/stale claim, stop instead of reclaiming
over another round.

#### Configured planner panel

Dispatch every configured planner concurrently in candidate mode through its
configured adapter. Each returns the same candidate DAG and writes nothing.
**Candidate usable-payload rule.** Fence-strip and validate stdout first. A
complete, parseable candidate counts as a usable candidate despite a non-zero
shell exit; log that exit anomaly. Require full-object validation before
accepting the candidate. Only empty, unparseable, invalid, or off-contract
candidate output abstains and is logged.

**Candidate no-timeout rule.** No wall-clock timeout is imposed. Fence-strip
and validate stdout first. A complete, parseable candidate counts as a usable
candidate despite a non-zero shell exit; log that exit anomaly. A non-zero exit
causes abstention only when no complete, parseable, fully validated candidate
exists; a stalled adapter remains an operational failure rather than a silent
abstention. If all abstain, use the single-planner fallback under the same
claim.

Synthesize one manifest:

1. choose the candidate with the strongest grounding and decomposition;
2. fold in distinct milestones, tasks, acceptance criteria, and dependency
   edges from other candidates;
3. deduplicate overlaps;
4. assign stable milestone/task keys and translate title/headline references
   into typed draft references. Copy every selected candidate task's
   `ledgerRefs` into the synthesized draft task's `ledgerRefs`, merge them with
   the mandatory `goals:<goalId>` owner reference, and de-duplicate without
   moving any entry into `sourceRefs`.

Publish that complete manifest under the active claim. Empty candidate DAGs
mean clarification remains necessary: pause with concrete questions when
available, otherwise abandon and return `awaiting-answers`.

### 3. Review a published draft

Resolve `ledger::get_config("reviewers")` once and honor any session
override.

#### Single-reviewer fallback

Snapshot the highest goal-linked review id before dispatch. Dispatch
`plan-reviewer` in fallback mode; it returns a structured verdict and writes
exactly one review.

After dispatch, require exactly one new goal-linked review above the snapshot.
Validate the complete returned and persisted verdicts, including canonical
serialized defect objects, and require equality. Zero/multiple reviews,
malformed data, or any mismatch fails the round before log attachment or
defect filing.

Stamp the recovered review with the exact current draft identity:
`{goalId, claimId, generation, revision}`.

#### Configured reviewer panel

Dispatch all configured reviewers concurrently through their adapters.
**Configured reviewer wrapper rule.** Standalone non-interactive wrappers may
fast-fail with a non-zero shell exit. Fence-strip and validate stdout first. A
complete, parseable verdict counts as a vote despite a non-zero shell exit; log
that exit anomaly. Do not drop the emitted verdict solely for that exit.

Reviewers return structured verdicts and write nothing.
**Reviewer usable-verdict rule.** Fence-strip and validate stdout first. A
complete, parseable verdict counts as a vote despite a non-zero shell exit; log
that exit anomaly. Require full-object validation before accepting the verdict.
Only a returned failure without such a verdict, empty/malformed result, or
off-enum verdict abstains and is logged. If all abstain, use the single-reviewer
fallback.

Reconcile surviving reviews in configured order:

- any `revise` wins; all must return `go-ahead` for approval;
- union and source-tag `new_questions`, `criticism`, and structured `defects`;
- deduplicate only equivalent findings;
- `revise` requires at least one question or criticism.

Write exactly one aggregated review linked to the goal and stamp it with the
current draft identity.

After either review path, continue the planner loop. The next planner result
must revise, ask questions, or finalize. There is no numeric cap while the
draft changes or criticism shrinks. An identical draft and unchanged
criticism across consecutive rounds constitutes a non-converging loop.

## Auto-investigate filed defects

After a goal's planner loop stops, query the ledger—not child prose—for
goal-linked defects in `open`, `wip`, or `inconclusive`. Deduplicate them and
run `CQ::investigate/advance` inline once per defect for this planning round.
Suppress the nested handoff.

Do not let open goal-clarification questions prevent investigation. Do not
resume planning for a goal still in `clarifying`; a defect-seeded goal already
in `planning` may resume immediately.

Stop the investigate/replan axis when any condition holds:

- the defect already ran once this round;
- no new confirmed node or correct evidence appeared;
- a confirmed cause seeded or extended its fix goal;
- replanning produced no new fix task or repeated the same task set;
- two consecutive rounds produced no adjudicable evidence.

For non-converging or genuinely user-blocked cases, create an open question
linked to the affected defect and goal. A `root-caused` defect belongs to the
outer advance command's seed stage, not another investigation pass.

Research items filed by planning are also driven by the outer advance command.
This command records the wait and stops; it does not run research inline.

## Logs, report, and handoff

Persist every child summary and available raw transcript through `cq log put`,
attach logical paths to the affected item, and never log fence or capability
secrets. Before piping a transcript, require `test -s <transcript>` so empty or
whitespace-only captures are skipped rather than written.

Report each goal's current phase and next action, waited research ids, finalized
work, and each investigated defect's outcome. Never auto-close a goal.

When invoked standalone, write one append-only `handoffs` item:

- `drained`: all targets planned/terminal;
- `answers-required`: open linked questions block progress;
- `user-action-required`: a named item requires a specific external action
  only the user can perform;
- `mixed`: several stop causes coexist;
- `illness-detected`: a protocol or convergence invariant prevents progress.

Set `flow: "plan"`, relevant goal/defect refs, required
`blockingQuestions`/`handoffReasons`, and round log paths. Do not write a
handoff for ordinary context-window interruption. Never stop because of effort,
elapsed time, or remaining work size.

When invoked inline by another flow, suppress this handoff; the outermost
command owns it.
