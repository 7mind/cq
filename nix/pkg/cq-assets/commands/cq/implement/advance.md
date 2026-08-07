---
description: "Advance implementation: dispatch DAG-ready tasks in isolated worktrees, review and correct them, then merge verified commits in dependency order."
argument-hint: [milestoneId ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}

## Catalogue

```yaml
inputs:
  - "optional milestone ids; empty resumes all active milestones with non-terminal tasks"
  - "full task state, dependencies, linked questions, worktrees, and reviewer configuration"
outputs:
  - "task transitions, one terminal review per task, verified fast-forward merges, defect closure, and milestone archival"
  - "standalone handoff"
ioSchema:
  - "worker: {taskId,status,resultCommit,branch,actualWorktreePath,baseVerification,filesTouched,checkSummary,gateDurationMs,summary,blockedReason?}"
  - "reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,resultCommitEvidence,baseAncestry,summary?}"
  - "resolver: {taskId,status,resultCommit?,summary,blockedReason?}"
```

You orchestrate implementation. Children never mutate the ledger or merge.
Re-derive state on every invocation. A pass must dispatch a child, mutate the
ledger, or merge; stop after two consecutive read-only passes.

{{cq:fragment:subagent-dispatch}}
{{cq:fragment:implement-dispatch-workflow}}

## Shared rules

- Resolve `tiers` and `reviewers` once per pass with
  `ledger::get_config("tiers")` and `ledger::get_config("reviewers")`.
  Workers use their task's `suggestedModel`; reviewers and conflict resolvers
  use `tiers.frontier`. Pass configured model aliases verbatim. If a tier is
  absent, inherit the current model and report the missing configuration.
- Run at most eight workers concurrently. Each task uses an isolated worktree
  and branch `implement/<taskId>`.
- **Managed worktrees.** ALL worktree lifecycle goes through
  `ledger::worktree_manage` — never raw git worktree lifecycle commands
  (add/remove/prune) on any active implement/advance surface. Before changing a
  task to `wip` or launching a worker, call
  `worktree_manage({ operation: "prepare", taskId, baseCommit: <full main tip> })`
  (or resume-by-handle with the retained opaque handle). Accept only a prepare
  result whose dependency-base evidence is verified. Pass the returned absolute
  path as advisory `worktreePath` on the child input. Retain the opaque handle
  across criticism rounds; on orchestrator restart, recover via prepare's
  resume-required response for that taskId and resume the same tree. Never
  discard worker partial/WIP state. Consume the worker's required
  `actualWorktreePath` on output as the authoritative location; merge by
  `resultCommit` SHA.
- Persist every child summary and available raw transcript with `cq log put`,
  attach their logical paths to the affected ledger item, and never expose
  capabilities or secrets. Before piping a transcript, require `test -s
  <transcript>` so empty or whitespace-only captures are skipped rather than
  written.
- The surface-specific fragment defines dispatch input delivery and result
  materialization. Retain the parent-prepared handle. Interpret a native
  result only after the exact retained handle yields `state: "consumed"`.
  Never inspect a body-returning completion or trust a child-reported handle.
- A missing or non-consumed native result is a LOST REPORT. Log it and retry
  the same role once with a fresh prepared dispatch. A second loss fails that
  task path closed, leaves the task non-terminal and its worktree intact, and
  cannot become a worker failure, reviewer abstention, or resolver verdict.

## 1. Derive the ready set

Read each target milestone and its full task items, linked questions, milestone
dependencies, and referenced dependency items.

Before dispatch, prune stale worktree metadata and inspect all implementation
and runtime-created worktrees via prepare/resume semantics. Never touch the
main checkout, the ledger backup branch, a worktree for a `wip`/`blocked` task,
or an unmerged worktree without a terminal task association. Release a worktree
only through guarded
`worktree_manage({ operation: "release", handle, terminalDisposition, … })`
when the associated task is terminal (`done`/`abandoned`) and release guards
pass. Never infer safety from a branch name alone. Never raw-remove or prune.

Change a `blocked` task back to `planned` after all linked questions become
`answered`; include the answers in its next dispatch.

A task is ready when:

- its status is `planned`;
- it has no open linked question;
- every resolvable `dependsOn` item has a satisfying status declared by its
  ledger (`tasks:done`, `defects:resolved`, `questions:answered`, and analogous
  configured sets);
- every prerequisite milestone has all tasks terminal.

Terminal-but-unsatisfying statuses such as `abandoned` and `wontfix` do not
satisfy dependencies. Advisory or unresolvable free-text references do.

If no task is ready and no task awaits review or merge, report and stop.

## 2. Dispatch workers

**Prepare BEFORE wip and BEFORE launch.** For each selected task:

1. Resolve the intended base as the current full main tip with
   `git rev-parse --verify` and require `git cat-file -t` to return `commit`.
2. Call `worktree_manage({ operation: "prepare", taskId, baseCommit })` (or
   resume-by-handle with the retained handle / allowResumeRequired recovery).
   On resume-required, retain the returned handle and path and continue on that
   tree — do not mint a second tree for the same task.
3. Accept only verified dependency-base evidence from prepare. Missing or
   unresolvable dependency `resultCommit` evidence blocks dispatch without a
   `wip` write; it becomes actionable after the ledger object is corrected.
4. Resolve the authoritative tip with
   `git -C <worktree> rev-parse --verify HEAD`, retain it as `startingCommit`,
   and require `git -C <worktree> cat-file -t <startingCommit>` to return
   `commit` plus
   `git merge-base --is-ancestor <verifiedBaseCommit> <startingCommit>` to exit
   zero. Immediately before launch, require the current worktree `HEAD` to equal
   that retained `startingCommit`. Retain the exact `baseCommit`, `round`,
   `startingCommit`, and opaque worktree handle; never reconstruct them from a
   child report.
5. Only after prepare succeeds: if the linked owning goal is `planned`, move it
   once to `building` (never terminal). Set the task `wip`.
6. Dispatch `implement-worker` with the exact task specification, advisory
   `worktreePath` from prepare, branch, verified full-SHA base, required
   `round` (0 on first dispatch; increment on each criticism re-dispatch),
   authoritative `startingCommit`, optional `priorResultCommit` on round>0, and
   any prior criticism.
7. Materialize only a consumed, schema-valid result through the dispatch
   protocol. Before accepting a passing result, require its `resultCommit` to be
   a commit, the worker branch tip to equal it,
   `actualWorktreePath` to be a non-empty absolute path,
   `baseVerification.status === "verified"` with full SHAs, and
   `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.

**Harvest then prefer RESUME.** Before every (re)dispatch, inspect the task
worktree for a partial artifact — a `WIP-<taskId>.md` (or equivalent
deliverable) in the existing WIP partial format with open checkpoints, plus any
uncommitted or committed-but-incomplete work. When a self-describing partial
exists, RESUME the same worker in the same managed worktree (same handle) onto
that partial rather than preparing a fresh empty tree. Re-running an expensive
probe to recover work already done is the expensive failure mode; resumption is
preferred when there is durable state to resume onto. When the prior return is a
LOST REPORT or an incomplete turn, harvest first, then resume.

A base-only repair / reprepare / rebase maintenance round does **not** count as
criticism, no-files output, or an ill-loop counter increment.

## 3. Review

Before any review dispatch, require
`git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.
Review each passing worker result against the actual `baseCommit..resultCommit`
diff, acceptance criteria, and gate evidence. A worker failure enters the
criticism loop using `blockedReason`.

If reviewers are unconfigured, dispatch one native `implement-reviewer`. If
configured, dispatch the panel concurrently. Native reviewers use the
surface-specific dispatch protocol. External reviewers run through their
configured non-interactive adapter and the shared implement-review rubric.

**Sandboxed reviewer parent-attested gate.** When a surface's dispatch workflow
requires parent-attested gate evidence for a sandboxed `implement-reviewer`
(gate primitives denied), the parent MUST attach `parentGateAttestation` built
from a just-run or freshly run full gate on the worker tip:
`{ resultCommit, gateExitCode, passCount, failCount, gateDurationMs?, command,
capturedAt }` with exact tip match, `gateExitCode === 0`, `failCount === 0`, and
`passCount > 0`. Do not escalate the child sandbox to gain gate primitives.
Non-sandboxed reviewers omit the attestation and still re-run the gate
themselves; their approve path still requires child `gateReRan=true`.

**External reviewer usable-verdict rule.** Fence-strip and validate stdout
first. A complete, parseable verdict counts as a vote despite a non-zero shell
exit; log that exit anomaly. Require full-object validation before accepting the
verdict. Only a returned external failure without such a verdict, empty output,
malformed result, or off-enum verdict abstains and must be logged.

**External reviewer no-timeout rule.** Do not impose a silent timeout.
Fence-strip and validate stdout first. A complete, parseable verdict counts as a
vote despite a non-zero shell exit; log that exit anomaly. A non-zero exit
causes abstention only when no complete, parseable, fully validated verdict
exists; a genuinely stalled adapter remains an operational failure. If every
configured reviewer abstains, use one native reviewer; zero successful
reviewers can never approve a task.

Reconcile surviving reviews in configured order:

- any `disapprove` wins; all must approve and the gate must be green for
  `approve`;
- union and source-tag `criticism`, `questions`, and `defects`, deduplicating
  equivalent entries;
- `approve` requires empty criticism/questions and verified
  `resultCommitEvidence` + `baseAncestry` on every surviving native reviewer;
- `disapprove` requires at least one criticism or question.

File each out-of-scope or pre-existing `defects[]` entry once as an open defect
linked to the task and owning goal. Such defects do not block the current task
and never become user disposition questions.

## 4. Correct or park

When the reconciled verdict disapproves with criticism and no questions,
redispatch the same worker in the **same managed worktree** (retained handle;
`round` incremented; `priorResultCommit` = prior pass tip when present), then
review again. Round N+1 must retain round N commits. There is no fixed round cap
while evidence shows convergence.

Park the task when:

- the review asks a genuine user-only requirements question;
- a correction round makes no file change;
- the same criticism repeats without shrinking across consecutive rounds;
- the same gate failure signature repeats.

Create linked open questions with the round history, set the task `blocked`,
and preserve its worktree + handle. Do not ask the user to decide whether a
confirmed fault deserves a fix.

## 5. Success authority

A task may merge only when all of these hold:

- its latest worker and required native-reviewer results were consumed through
  parent-retained handles;
- the worker reported `REAL_CHECK_EXIT=0`;
- all surviving reviewers approved with empty criticism/questions and verified
  commit/ancestry evidence;
- the orchestrator independently verified the exact commit and ancestry.

Treat `gateDurationMs` below `50`, absent/zero, or below one quarter of the
median for earlier rounds of this same task as implausible. Re-run
`bun run check` in the foreground and use its real exit status. If that cannot
be done, fail closed.

Before rebase and immediately before merge, the orchestrator independently:

1. require `git cat-file -t <resultCommit>` to return `commit` (full SHA);
2. require the worker branch tip to equal `resultCommit`;
3. require a clean claimed file set vs `filesTouched` / the actual diff;
4. require `git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`
   to exit zero;
5. require `git merge-base --is-ancestor <startingCommit> <resultCommit>` to
   exit zero;
6. require every dependency task `resultCommit` to be an ancestor of the tip
   (or equal) when resolvable — missing/unresolvable dependency evidence forbids
   merge.

Fabricated, missing, non-tip, stale-base, or non-ancestor result commits never
merge. Any failure is a contract breach and forbids merge-back.

## 6. Merge in DAG order

Process successful tasks sequentially after their dependencies have landed.
If main has advanced past the dispatch base, rebase onto current main and rerun
gates + review before ff-only merge; that ancestry-only maintenance does not
increment criticism/no-files counters. If the tip changes under rebase, the old
worker result loses authority: redispatch the worker on the rebased tree (same
handle), rerun its gate and review, and repeat the success checks.

On conflict, dispatch `implement-conflict-resolver`. Continue only from a
consumed `pass` result. On `fail`, create a linked question, set the task
`blocked`, keep the worktree/handle, and skip its dependants.

After the final checks, merge the exact object:

```sh
git merge --ff-only <resultCommit>
```

Then mark the task `done` with `resultCommit`, completion summary, and all
worker/reviewer log paths in the same update. Cleanup uses guarded release only:

```
worktree_manage({
  operation: "release",
  handle: <retained opaque handle>,
  terminalDisposition: "done",
  resultCommit: <merged tip>,
  deleteBranch: true
})
```

A failed harvest or release guard preserves the tree and any side recovery ref.
Never raw-remove or prune outside guarded release. Successful terminal flow
releases once: Remove its worktree, delete its
derived branch, and prune worktree metadata through that single guarded release.

For each linked defect, collect all fix tasks from the defect's task
dependencies and reverse task links. When all are `done`, set the defect
`resolved` with a concise fix summary. A discovered task in `planned`, `wip`,
or `blocked` prevents resolution; never treat task discovery as task completion.

Record exactly one terminal `reviews` item per task from the reconciled result:
`go-ahead` for approval, otherwise `revise`, with source-tagged findings and
all reviewer log paths.

Re-derive the ready set after every merge and continue until drained.

## 7. Milestones and goals

For each touched milestone, close and archive it only when every contained item
is terminal and, for a coordination milestone, its goal is also terminal.
Perform `update_item(ledger_id: "milestones", ..., status: "done")` before
`archive_milestone(...)`.

Never auto-close a goal. When all of a goal's work milestones are archived,
report that the user may set the goal to `done`; a later sweep may then archive
its coordination milestone.

## Report and handoff

Report merged tasks and commits, blocked tasks and question ids, failed paths,
archived milestones, and goals ready for user closure.

When invoked standalone, write exactly one append-only `handoffs` item:

- `drained`: no reachable task remains;
- `answers-required`: tasks are blocked on open questions;
- `user-action-required`: a named task needs a specific external action only
  the user can perform;
- `mixed`: several stop causes coexist;
- `illness-detected`: a protocol, merge, or invariant failure prevents
  progress.

Set `flow: "implement"`, relevant `ledgerRefs`, required
`blockingQuestions`/`handoffReasons`, and pass log paths. Do not write a
handoff for an ordinary context-window interruption. Never stop because of
elapsed effort, task count, or remaining work size.

When invoked inline by another flow, suppress this handoff; the outermost
command owns it.
