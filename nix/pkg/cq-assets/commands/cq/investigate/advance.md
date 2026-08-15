---
description: "Advance one defect investigation round: extend its hypothesis tree, gather and validate evidence, adjudicate nodes, and hand a confirmed cause to planning."
argument-hint: <defectId>
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}
{{cq:fragment:subagent-dispatch}}
Effect-boundary authority follows this shared contract:

{{cq:fragment:workset-effect-discipline}}

## Catalogue
```yaml
inputs:
  - "one defect id and its linked hypothesis/question/research state"
outputs:
  - "validated hypothesis evidence and status changes"
  - "optional execution probes or research escalation"
  - "confirmed root cause, suggested fix, and defect-seeded planning goal"
ioSchema:
  - "one resumable evidence/adjudication round per invocation"
  - "parallel explorers only for independent roots; serial drilling within a branch"
  - "explorer/prober output: {hypothesisId,evidence[],lean,notes?,probeRequest?}"
```

You own the investigation loop for one defect. Explorers and probers gather
evidence; they never mutate the ledger or adjudicate. Re-derive state from the
ledger on every invocation. A round must dispatch a child or make a durable
mutation; otherwise stop with a handoff instead of rereading indefinitely.

## State and invariants

1. Fetch the defect with `projection: "full"`. Stop on `resolved` or `wontfix`.
2. Fetch linked hypotheses, questions, and researches with full projection.
   Reconstruct hypothesis ancestry from `parentHypothesis`; every node must
   retain `ledgerRefs: ["defects:<defect-id>"]`.
3. An unanswered linked question parks the affected branch. Fold answered text
   into the next framing.
4. A hypothesis parked on `researches:<research-id>` remains parked while that
   research is `open` or `wip`. On `concluded`, use its findings/conclusion as
   evidence; on `inconclusive` or `abandoned`, resume from the remaining
   evidence.
5. Before forming or dispatching hypotheses, move an `open` defect to `wip`.
   Never attempt the invalid direct transition from `open` to `root-caused`.
6. Resolve the frontier model once with
   `ledger::get_config("tiers")`; use the configured frontier model
   verbatim. If unavailable, inherit the current runtime model. Do not invent a
   model identifier.

## Round

### 1. Form hypotheses

If the tree has no actionable node, create a small set of mutually distinct,
falsifiable root hypotheses. Otherwise select unresolved leaves whose parents
have enough validated evidence to justify drilling. Do not duplicate an
existing statement or create children merely to keep the loop active.

Each new hypothesis includes:

- a precise statement;
- optional `parentHypothesis`;
- `ledgerRefs: ["defects:<defect-id>"]`;
- `status: "open"`.

### 2. Gather evidence

Dispatch one `investigate-explorer` per selected node. Independent roots may run
in parallel; descendants of one branch run serially because later framing
depends on earlier evidence.

The input must contain the canonical `defectId`, hypothesis id and statement,
defect/branch context, known sibling or parent findings, and focused leads. The child returns numbered
evidence with a precise citation, a three-to-five-line verbatim excerpt, a
relevance statement, and a non-binding lean.

If an explorer returns `probeRequest`, dispatch `investigate-prober` with the
same context plus `{what, why}` in an isolated throwaway worktree. The prober is
local-only: no network, no persistent main-checkout edits. Harvest its evidence,
then remove the worktree. Never execute a probe in the main checkout.

After every child returns, persist its summary through `cq log put` and its raw
transcript when available. Before piping a transcript, require `test -s
<transcript>` so empty or whitespace-only captures are skipped rather than
written. Attach the paths to the hypothesis. Never write log files directly.

### 3. Validate before writing

Reopen every cited source or rerun the cited command:

- citation and excerpt match exactly;
- the excerpt contains enough surrounding lines to establish context;
- command evidence records the exact command and observed output;
- relevance accurately says whether the item supports or contradicts;
- no cited evidence was fabricated, stale, or outside the requested scope.

Store accepted evidence with `[correct]`; retain rejected evidence only when
useful, marked `[incorrect]` with the validation reason. Never adjudicate from an
unvalidated item.

### 4. Adjudicate

For each updated node:

- `confirmed`: validated evidence establishes the statement and withstands
  relevant contradiction;
- `wrong`: validated evidence refutes it;
- `uncertain`: evidence remains mixed or insufficient;
- leave `open` only when the child could not run or return usable evidence.

When an unresolved fact can be answered empirically but not by this local
investigation, create a `researches` item instead of a user question. Link it to
the defect and hypothesis, append `researches:<research-id>` to the hypothesis,
set the node `uncertain`, and park that branch.

Create a user question only for a requirements/preference choice or information
the user alone can supply, such as unavailable credentials or an irreproducible
external event. Never ask whether to fix a confirmed fault.

### 5. Confirmed cause

When the validated tree establishes a root cause:

1. Update the defect's `rootCause` with the cited causal chain and set
   `suggestedFix` to the smallest general correction.
2. Set defect status to `root-caused`.
3. Reuse a nonterminal goal already linked through `defects:<defect-id>`;
   otherwise create a coordination milestone and a defect-seeded goal in
   `planning`, carrying the cause, correction boundary, regression expectations,
   and `sourceRefs: ["defects:<defect-id>"]`.
4. Ensure the defect and goal link in both directions.
5. Stop. Do not run the planner/reviewer loop here.

When this command runs standalone, create one open question pointing the user to
`CQ::plan/advance <goal-id>`. When chained from plan flow, omit that question;
the parent resumes planning automatically.

If the evidence rules out every viable branch without establishing a cause, set
the defect `inconclusive` with a precise account of what remains unknown.

## Stop conditions

Stop this invocation when any condition holds:

- the defect reached `root-caused`, `inconclusive`, `resolved`, or `wontfix`;
- every unresolved branch waits on an open question or active research;
- the round produced no new validated evidence and no justified child;
- the same blocked state recurs without a new lead;
- a required external capability remains unavailable.

There is no fixed depth, child-count, or time cap. The bound is progress.

## Handoff and report

When standalone, write one `handoffs` item with `flow: "investigate"`, links to
the defect, hypotheses, research, goal, and questions, and one of:

- `drained`: cause confirmed or investigation conclusively exhausted;
- `answers-required`: open requirements question;
- `user-action-required`: specific unavailable external action;
- `illness-detected`: actionable state remained but no legal progress occurred.

Suppress this handoff when chained by another CQ command.

Report the defect status, hypotheses created/adjudicated, validated evidence,
probe/research activity, the confirmed cause or remaining uncertainty, the
defect-seeded goal, and the exact next action.
