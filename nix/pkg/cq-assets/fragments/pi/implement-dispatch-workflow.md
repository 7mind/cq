> **Implement-worker dispatch.** In Pi, for each
> `implement-worker`, first ensure a managed worktree via
> `worktree_manage({ operation: "prepare", taskId, baseCommit: <full main tip> })`
> (or resume-by-handle with the retained opaque handle). Use the returned
> absolute path as advisory `worktreePath`. Retain the handle across criticism
> rounds; on restart recover via prepare's resume-required response. Then
> compose `{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, round, startingCommit, priorCriticism? }` against the role's typed `inputSchema`, dispatch
> `CQ_SUBAGENT` with the composed input and `isolation: "worktree"`. The held
> direct-delivery Pi adapter cannot yet produce the parent-minted
> prepare/store/confirm/fetch proof required by the command, so its raw
> completion is never a usable worker result: route it to the bailout. Do not
> inspect the body or substitute a child-reported handle. The extension-local
> lifecycle must enable this edge before its results become authoritative.
> After terminal status, cleanup uses guarded
> `worktree_manage({ operation: "release", handle, terminalDisposition, … })`
> only — never raw git worktree lifecycle commands.
>
> **Implement-reviewer dispatch.** For each native
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`,
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because the authoritative dispatch lifecycle binds those
> absolute values, then
> dispatch through `CQ_SUBAGENT`, but treat the held adapter's raw verdict as an
> abstention because it cannot satisfy the consumed-result gate. The `pi:*`
> panel members remain external shellouts driving the shared
> `CQ::implement-review` rubric.
>
> **Conflict-resolver dispatch.** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }`, dispatch
> with the frontier model and `isolation: "worktree"`, but never interpret
> the held adapter's raw completion. Enter the bailout until the
> extension-local lifecycle can return a consumed fetched body.
