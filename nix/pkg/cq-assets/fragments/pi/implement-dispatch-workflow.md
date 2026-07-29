> **Catalog-driven dispatch (G41 — implement-worker).** In Pi, for each
> `implement-worker`,
> compose `{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, priorCriticism? }` against the role's typed `inputSchema`, dispatch
> `CQ_SUBAGENT` with the composed input and `isolation: "worktree"`. The held
> direct-delivery Pi adapter cannot yet produce the parent-minted
> prepare/store/confirm/fetch proof required by §2, so its raw completion is
> never a usable worker result: route it to the §5 bailout. Do not inspect the
> body or substitute a child-reported handle. T693/T696/T714/T715 own enabling
> this edge with the extension-local lifecycle.
>
> **Catalog-driven dispatch (G41 — implement-reviewer).** For each native
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`,
> dispatch through `CQ_SUBAGENT`, but treat the held adapter's raw verdict as an
> abstention because it cannot satisfy §2's consumed-result gate. The `pi:*`
> panel members remain external shellouts driving the shared
> `CQ::implement-review` rubric.
>
> **Catalog-driven dispatch (G41 — implement-conflict-resolver).** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }`, dispatch
> with the §K4 FRONTIER model and `isolation: "worktree"`, but never interpret
> the held adapter's raw completion. Enter the §5 bailout until the
> extension-local lifecycle can return a consumed fetched body.
