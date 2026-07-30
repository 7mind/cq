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
  - "worker: {taskId,status,resultCommit,branch,filesTouched,checkSummary,gateDurationMs,summary,blockedReason?}"
  - "reviewer: {taskId,verdict,criticism[],questions[],defects[],rationale,summary?}"
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
- Persist every child summary and available raw transcript with `cq log put`,
  attach their logical paths to the affected ledger item, and never expose
  capabilities or secrets.
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
and runtime-created worktrees. Never touch the main checkout, the ledger backup
branch, a worktree for a `wip`/`blocked` task, or an unmerged worktree without a
terminal task association. Remove a worktree and branch only when its branch
has merged into the base or its associated task is `done`/`abandoned`.

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

Before each initial or criticism-round dispatch, resolve the intended base with
`git rev-parse --verify` and require `git cat-file -t` to return `commit`.
Retain that exact `baseCommit`; never reconstruct it from a child report.

For each selected task:

1. If its linked owning goal is `planned`, move it once to `building`. Never
   move a goal to a terminal status.
2. Set the task `wip`.
3. Prepare its worktree and dispatch `implement-worker` with the exact task
   specification, worktree coordinates, verified base, and any prior
   criticism.
4. Accept only a consumed, schema-valid result through the dispatch protocol.

Do not symlink another checkout's `node_modules`; the worker installs its own
workspace dependencies.

## 3. Review

Review each passing worker result against the actual `baseCommit..resultCommit`
diff, acceptance criteria, and gate evidence. A worker failure enters the
criticism loop using `blockedReason`.

If reviewers are unconfigured, dispatch one native `implement-reviewer`. If
configured, dispatch the panel concurrently. Native reviewers use the
surface-specific dispatch protocol. External reviewers run through their
configured non-interactive adapter and the shared implement-review rubric.

A returned external failure, empty output, malformed result, or off-enum
verdict abstains and must be logged. Do not impose a silent timeout. If every
configured reviewer abstains, use one native reviewer; zero successful
reviewers can never approve a task.

Reconcile surviving reviews in configured order:

- any `disapprove` wins; all must approve and the gate must be green for
  `approve`;
- union and source-tag `criticism`, `questions`, and `defects`, deduplicating
  equivalent entries;
- `approve` requires empty criticism/questions;
- `disapprove` requires at least one criticism or question.

File each out-of-scope or pre-existing `defects[]` entry once as an open defect
linked to the task and owning goal. Such defects do not block the current task
and never become user disposition questions.

## 4. Correct or park

When the reconciled verdict disapproves with criticism and no questions,
redispatch the same worker in the same worktree, then review again. There is no
fixed round cap while evidence shows convergence.

Park the task when:

- the review asks a genuine user-only requirements question;
- a correction round makes no file change;
- the same criticism repeats without shrinking across consecutive rounds;
- the same gate failure signature repeats.

Create linked open questions with the round history, set the task `blocked`,
and preserve its worktree. Do not ask the user to decide whether a confirmed
fault deserves a fix.

## 5. Success authority

A task may merge only when all of these hold:

- its latest worker and required native-reviewer results were consumed through
  parent-retained handles;
- the worker reported `REAL_CHECK_EXIT=0`;
- all surviving reviewers approved with empty criticism/questions;
- the orchestrator independently verified the exact commit and ancestry.

Treat `gateDurationMs` below `50`, absent/zero, or below one quarter of the
median for earlier rounds of this same task as implausible. Re-run
`bun run check` in the foreground and use its real exit status. If that cannot
be done, fail closed.

Before rebase and immediately before merge:

1. require `git cat-file -t <resultCommit>` to return `commit`;
2. require the worker branch tip to equal `resultCommit`;
3. require `git merge-base --is-ancestor <verifiedBaseCommit> <resultCommit>`
   to exit zero.

Any failure is a contract breach and forbids merge-back.

## 6. Merge in DAG order

Process successful tasks sequentially after their dependencies have landed.
Rebase each branch onto the current base. If the tip changes, the old worker
result loses authority: redispatch the worker on the rebased tree, rerun its
gate and review, and repeat the success checks.

On conflict, dispatch `implement-conflict-resolver`. Continue only from a
consumed `pass` result. On `fail`, create a linked question, set the task
`blocked`, keep the worktree, and skip its dependants.

After the final checks, merge the exact object:

```sh
git merge --ff-only <resultCommit>
```

Then mark the task `done` with `resultCommit`, completion summary, and all
worker/reviewer log paths in the same update. Remove its worktree, delete its
derived branch, and prune worktree metadata.

For each linked defect, collect all fix tasks from the defect's task
dependencies and reverse task links. When all are `done`, set the defect
`resolved` with a concise fix summary.

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
