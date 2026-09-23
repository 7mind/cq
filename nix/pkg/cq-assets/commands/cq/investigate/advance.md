---
description: "Advance an admitted investigation cohort: validate shared evidence and adjudicate each member's hypothesis tree separately."
argument-hint: [defectId ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}
{{cq:fragment:subagent-dispatch}}

Durable project facts enter this flow through the shared policy below:

{{cq:fragment:memory-grounding}}

Effect-boundary authority follows this shared contract:

{{cq:fragment:workset-effect-discipline}}

## Catalogue
```yaml
inputs:
  - "bounded ordered ready defect candidates and their linked hypothesis/question/research state"
outputs:
  - "validated hypothesis evidence and status changes"
  - "optional execution probes or research escalation"
  - "confirmed root cause, suggested fix, and defect-seeded planning goal"
ioSchema:
  - "one resumable evidence/adjudication round per invocation"
  - "parallel explorers only for independent roots; serial drilling within a branch"
  - "explorer/prober output: {hypothesisId,evidence[],lean,notes?,probeRequest?}"
```

You own the investigation loop for an admitted cohort. Explorers and probers gather
evidence; they never mutate the ledger or adjudicate. Re-derive state from the
ledger on every invocation. A round must dispatch a child or make a durable
mutation; otherwise stop with a handoff instead of rereading indefinitely.

## Mandatory cohort admission

Use mandatory safe fusion before per-node dispatch. Read authoritative
`derive_predicates()` and `get_cohort_status().readyBoundaries`, then make a
bounded observation of at most 256 ordered ready defects within one admitted
investigation boundary. Preserve total/unexamined counts for oversized boundaries;
never silently turn the remainder into singleton work. An explicit requested
defect remains in scope; unrelated work and other phases do not become admitted.

Call `cohort_advance({operation:"observe",plan,operation_id})` with the selected
members, their exact investigation hypothesis refs and revision-bound acceptance
provenance, and complete candidate atoms. The server must record a phase-homogeneous
common atom or an explicit singleton with its reason. A shared label or pairwise
overlap is insufficient; one complete witness/regression/gate/reviewer/deployment/
finalization atom must cover the whole set. Novel work uses the same rule.
No fusion setting or eager per-defect fallback exists.

Use `cohort_investigation_advance({input:{operation:..., ...}})` for the following
resumable parent operations; operation fields use the exact camelCase names below:

- `prepare`: pass the same `admissionPlan`, observed `definitionDigest`,
  `operationId`, and ordered `members` containing `defectRef`, `branchContext`,
  and `leads`. The server derives canonical hypotheses, revisions, and role
  contracts. Launch each returned `launches[].prepared` through the normal native
  bridge with its exact investigation binding: pass
  `investigationCohort: launch.nativeBinding` and
  `effectTargetRef: "cq-cohort-effect:v1:<planDigest>"`, preserving the returned
  role, handle, and capabilities. A prepared launch is not an executed role.
  Never reconstruct dispatch capabilities or substitute a task.
- `collect`: pass `planDigest` after native completion has been confirmed. The
  server authenticates consumed role results, reopens citations, and returns
  required prober preparations or per-member `adjudicationRequests`. Preparation,
  result storage, and consumed native completion are distinct states.
- `probe`: approve an explicit normalized `command` (`argv`, repository-relative
  `cwd`, and `environment`) with exact `planDigest`, prober `preparedDigest`, and
  `citation`. The server executes it under all-member admission. Never execute an
  explorer's free-text `probeRequest` automatically. Retained `probeEvidence`
  binds real execution identity, output digest, redacted diagnostics, and bounded
  `completeOutput`; an unavailable complete range is not evidence.
- `propose-correction`: after complete evidence has been collected and before
  adjudication, pass `planDigest` and an explicit `proposal` in the same
  `CohortAdmissionPlanV1` grammar. Preserve the exact ordered defect/hypothesis
  refs; propose each defect's current repository witness and correlated correction
  regression, canonical implementation gate, reviewer, deployment, and finalization
  boundaries. The server independently authenticates applicability and returns
  `correctionCandidates` with implementation-phase atoms and
  `correctionBoundaryDigest`. An original investigation atom is not a correction
  candidate; never relabel it or supply invented eligibility receipts.
- `adjudicate`: pass `planDigest` and the selected members' exact returned
  `evidenceDigest`, with explicit verdict, rationale, cause/correction-boundary
  digests, and applicable common-atom digests selected from the returned correction
  candidates. The server binds each separate confirmed-cause receipt to the
  complete revalidated candidate in `correctionEligibility`. This is parent judgment over
  authenticated evidence, not a worker verdict or implementation acceptance.
  Preserve separate judgments for every member and honor a returned split.
  Correction eligibility is pre-task planning evidence, not execution authority;
  implementation still requires its normal finalized task cohort.
- `resume`: pass the unchanged `planDigest` only after an execution-epoch change.
  The server reauthenticates retained evidence before renewing live authority;
  the previous epoch's launch authority cannot be reused.

Use only the installed cohort investigation operation and returned dispatch
authority when available; observation alone is not execution authority. A missing
cohort executor is `executor-unavailable`, never permission to substitute raw
task-only dispatch or caller-authored evidence. Bind every local probe/effect to
the current execution epoch; retained evidence is metadata, not a reusable lease.
On unchanged restart, renew live authority explicitly and preserve only exactly
matching durable evidence. A changed definition, member/hypothesis revision, or
probe boundary invalidates affected evidence.

Share gathering only while the complete common atom holds. Retain per-member
citations, findings, hypotheses, causal conclusions, and adjudications; no majority
vote or first-defect anchor replaces them. A divergent cause/probe requirement
records an explicit split and preserves parent/member lineage. Aggregate only
authenticated returned evidence, with no implementation acceptance, commit gate,
review, or completion receipt inferred from an investigation result.

Apply the following state, validation, and adjudication rules separately to every
member. Park only the affected branch when a question/research gate appears;
re-observe or split before changing admitted membership. Never mutate the sealed
member set in place or broaden workset/user authority.

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
