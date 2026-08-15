---
description: Advance every CQ flow to quiescence, then report whether the run drained or stopped on user input.
argument-hint:
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:advance-run-guard}}
Effect-boundary authority follows this shared contract:

{{cq:fragment:workset-effect-discipline}}

## Catalogue
```yaml
inputs:
  - "no arguments; current ledger state"
outputs:
  - "root-caused defects seeded into fix goals"
  - "all actionable investigate, plan, research, and implement work advanced to quiescence"
  - "one run-level handoff and a drained/blocked/mixed report"
ioSchema:
  - "authoritative readiness comes from ledger::derive_predicates"
  - "cycle order: investigate -> seed -> plan -> research -> implement -> investigate re-check"
  - "no fixed iteration cap; stop only after a full no-progress cycle"
```

You are the whole-ledger sequencer. Run the four flow commands INLINE in this
session; do not dispatch their agents yourself or duplicate their internal
logic. Subcommands suppress standalone handoffs while chained here. Ledger state,
not prose output, determines the next action.

## Authoritative state

At run start and after every stage that may mutate the ledger, call:

```
ledger::derive_predicates()
```

It returns:

```json
{
  "pInvestigate": { "value": true, "items": ["<defect-id>"] },
  "pSeed": { "value": true, "items": ["<defect-id>"] },
  "pPlan": { "value": true, "items": ["<goal-id>"] },
  "pResearch": { "value": true, "items": ["<research-id>"] },
  "pImplement": { "value": true, "items": ["<task-id>"] },
  "pOperatorAction": { "value": true, "items": ["<task-id>"] },
  "openQuestionGate": { "value": false, "items": [] },
  "belowFloor": { "value": false, "items": [] },
  "planBusy": { "value": false, "items": [] },
  "goalDrift": { "value": false, "items": [] }
}
```

Trust these derived values. Use `snapshot()` or focused item reads only for
narrative needed by the selected action. Never reimplement readiness by scanning
entire ledgers or parsing a child command's report.

## Cycle

Repeat the following order. Re-read predicates after each numbered stage.

1. **Investigate.** For every id currently returned by `pInvestigate.items`,
   run `CQ::investigate/advance <defect-id>` INLINE. Continue past one parked
   defect; another defect may remain actionable.

2. **Seed fixes.** For `pSeed.items`, fetch the full root-caused defects and
   process deterministic chunks of at most five. For each chunk:

   - create one coordination milestone;
   - create one `goals` item in `planning`, with a title/description covering
     every defect, `sourceRefs` containing each `defects:<id>`, and enough
     root-cause/fix context for planning;
   - append `goals:<new-goal>` to each defect's `ledgerRefs`, preserving existing
     refs.

   A root-caused defect already owned by a goal must not seed another. Defects
   below the configured severity floor remain visible through `belowFloor` but
   do not seed automatically.

3. **Plan.** If `pPlan.value`, run `CQ::plan/advance` INLINE once; that command
   advances every unlocked planning goal and owns auto-investigation of defects
   filed during plan review.

4. **Research.** For every id currently returned by `pResearch.items`, run
   `CQ::research/advance <research-id>` INLINE.

5. **Implement.** If `pImplement.value` or `pOperatorAction.value`, run
   `CQ::implement/advance` INLINE once. It owns worker dispatch/review/merge for
   ordinary tasks and the parent-only operator-action lifecycle for
   `pOperatorAction.items`; an operator action never dispatches a worker.

6. **Re-check investigation.** Re-read predicates and run newly actionable
   defects before deciding whether the cycle made progress. Planning,
   research, and implementation can expose new defects.

After any ledger mutation, begin another cycle. Do not impose an iteration,
time, or token cap.

## Legitimate stops

A full cycle may stop only when it made no ledger progress and one of these
conditions holds:

- all six actionable predicates are false (`drained`);
- every remaining actionable branch waits on open requirements questions
  (`answers-required`);
- progress requires an operation CQ cannot perform, such as missing credentials,
  unavailable infrastructure, deployment, or an external manual action
  (`user-action-required`);
- both question-gated and external-action-gated branches remain (`mixed`);
- predicates remain actionable but a complete cycle produces no legal mutation
  and no legitimate user gate (`illness-detected`).

Do not ask for confirmation between stages. Fix-versus-wontfix, whether a
confirmed defect should be fixed, cost, blast radius, public API impact, and
scope size are not requirements questions. Running this command authorizes
continued in-scope repair. Ask only when the answer changes required behavior or
provides otherwise-unavailable external information or authority.

`belowFloor`, `planBusy`, research parking, and `goalDrift` are diagnostic
companions, not reasons by themselves to claim the run drained. Report them when
they explain inactive work.

## End-of-run maintenance

After quiescence:

1. For each active non-goal milestone whose referenced items are all terminal,
   mark it `done` and archive it. Never auto-close goals.
2. Inspect implementation worktrees. Remove only a task worktree when
   `decideWorktreeSweep` returns `remove`: the tip is an ancestor of the
   integration base, `git cherry <base> <tip>` reports every commit as
   patch-equivalent (all `-` lines → `patchEquivalentToLanded`), or the
   associated task is `done`/`abandoned`. Preserve any worktree carrying novel
   commits (`git cherry` `+` lines), report it, then prune stale worktree
   metadata. Never infer safety from a branch name alone.
3. Make no git commit or push for ledger mutations; the configured ledger
   backend owns persistence.

## Handoff and report

Write exactly one `handoffs` item for the whole run:

- `status`: `drained`, `answers-required`, `user-action-required`, `mixed`, or
  `illness-detected`;
- `flow`: `advance`;
- `summary`: stages run, durable ids/statuses changed, and final predicate state;
- `blockingQuestions`: open question ids when applicable;
- `handoffReasons`: external actions or illness evidence when applicable;
- `ledgerRefs`: the affected defects, goals, researches, and tasks.

Then report:

- the terminal category;
- changes grouped by investigate, seed, plan, research, and implement;
- required user answers/actions, if any;
- below-floor, parked, drifted, or preserved-worktree diagnostics;
- the handoff id.

Before returning, perform the surface-specific run-guard cleanup stated above.
