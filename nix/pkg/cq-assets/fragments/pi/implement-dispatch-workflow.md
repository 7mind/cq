> **Implement-worker dispatch.** In Pi's ref-first
> procedure, for each
> `implement-worker`, first ensure a managed worktree via
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
> `{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, priorReviewId?, guidance?, resolvedModel? }`.
> Call `prepare_dispatch`; the server reads the task/review narrative, assembles
> it against the generated role's `inputSchema`, and returns a handle. Retain
> the exact prepared handle independently of every child-visible value, plus
> the deadlines. Dispatch `CQ_SUBAGENT` with the worker role,
> `isolation: "worktree"`, and the opaque prepared handle as the entire
> `dispatch_agent` `task`. The extension delivers the assembled typed input at
> the child boundary; the parent never reads or launches the task narrative.
> Confirm or abort through the parent, then call `fetch_dispatch_result` with
> the retained prepared handle exactly once. Apply the blocking consumed-only
> rule before interpreting the already-validated worker result. An unavailable
> scoped store or extension aborts the dispatch; it never falls back to a
> body-returning completion. After terminal status, cleanup uses guarded
> `worktree_manage({ operation: "release", handle, terminalDisposition, … })`
> only — never raw git worktree lifecycle commands.
>
> **Implement-reviewer dispatch.** Apply the same sequence
> to every native `pi:*` `implement-reviewer` with
> `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`, using the reviewer's resolved model.
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because `prepare_dispatch` binds those absolute values. A
> prepare, confirmation, abort, or fetch failure makes that reviewer abstain
> under the returned-failure rule; only the fetched consumed body is a usable
> verdict. The `pi:*` panel members remain external shellouts driving the
> shared `CQ::implement-review` rubric.
>
> **Conflict-resolver dispatch.** On a merge
> conflict, prepare `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, conflictState, baseSideNote? }` for
> `implement-conflict-resolver` and use the frontier model through the same
> handle-only sequence with `isolation: "worktree"` only when the extension
> delivers a prepare-bound `gitConflictCapability` to the child. Conflict
> continuation has no body-returning mutation path: without that capability,
> fail closed and retain the managed worktree for inspection. Accept only a
> consumed result whose durable receipt chain ends at the terminal tip. A
> prepare, scoped-store, confirmation, or fetch failure enters the command's
> bailout. A second materialization attempt is a protocol violation. Never
> fall back to a body-returning completion.
