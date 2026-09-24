> **Implement-worker dispatch.** In Claude, for each `implement-worker`,
> first ensure a managed worktree via
> `worktree_manage({ operation: "prepare", taskId, baseCommit: <full main tip> })`
> (or resume-by-handle with the retained opaque handle). Use the returned
> absolute path as advisory `worktreePath` / coordinates. Retain the handle
> across criticism rounds; on restart recover via prepare's resume-required
> response. For an exact pre-registry tree only, use handle-free prepare with
> paired `adoptWorktreePath: <canonical .claude/worktrees/implement-<taskId>>`
> and `expectedHead: <observed full HEAD>`; never combine them with a handle,
> and never supply activity-fence, registry, reconciliation, Git, or install
> authority. Retain the returned opaque handle and refuse launch when adoption
> refuses. Then compose refs only:
> `{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, validationIntent: "final", priorReviewId?, guidance? }`
> and dispatch through `CQ_SUBAGENT`: call `start_dispatch` with them. CQ reads
> the task/review narrative,
> assembles it against the role's `inputSchema` for the role's configured
> harness, launches the worker in the managed worktree, and runs the store-time
> gate and any parent gate itself; the parent never reads or launches the task
> narrative and never holds a worker, Git, or parent-gate capability. Wait with
> `fetch_dispatch_result` (`waitMs`) until the dispatch is terminal and apply
> the blocking consumed-only rule before interpreting the already-validated
> worker result. After terminal status, cleanup uses guarded
> `worktree_manage({ operation: "release", handle, terminalDisposition, … })`
> only — never raw git worktree lifecycle commands.
>
> **Implement-reviewer dispatch.** Start every configured
> `implement-reviewer` panel member the same way with
> `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`,
> passing the member's configured token as `model`.
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because CQ binds those absolute values. A rejected start or aborted fetch makes that
> reviewer abstain under the returned-failure rule; only a consumed fetched body
> is a usable verdict. Members whose configured launch is an external adapter
> run through the implementation-evidence adapter path, not `start_dispatch`.
>
> **Conflict-resolver dispatch.** On a merge conflict, start
> `implement-conflict-resolver` with
> `{ taskId, headline?, description?, worktreePath, branch, baseCommit, validationIntent: "focused-only", conflictingFiles, conflictState, baseSideNote? }`
> at the frontier token. CQ gives the resolver its git-conflict capability
> through the resolver's own ledger connection and never exposes the worker's
> Git capability to it. Accept only a consumed result whose durable receipt
> chain ends at the terminal tip. A rejected start or an aborted fetch enters
> the command's bailout. Never fall back to a body-returning completion.
