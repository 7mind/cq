> **Implement-worker dispatch.** In Codex, for each
> `implement-worker`,
> compose refs only:
> `{ roleId, surface, projectKey, taskId, coordinates, round?, priorReviewId?, guidance?, resolvedModel? }`,
> then call `prepare_dispatch`. The server reads the task/review narrative and
> validates the assembled input against the role's typed `inputSchema`. Dispatch
> `CQ_SUBAGENT` with only the returned
> `{ attestationId, generation, inputCapability }` and
> `isolation: "worktree"`; the child calls `fetch_dispatch_input` exactly once
> before work, so no parent-rendered task narrative enters the launch. Await its
> handle-only final response after its capability-scoped `store_result`, confirm
> the observed native completion, and call `fetch_dispatch_result` exactly once
> with the exact handle retained from `prepare_dispatch`. Apply the blocking
> consumed-only rule before interpreting the worker result; never key the
> fetch on any child-reported identifier.
>
> **Implement-reviewer dispatch.** For each native
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`,
> dispatch through `CQ_SUBAGENT`, require its capability-scoped `store_result`
> plus handle-only final response, confirm native completion, and fetch once
> with the retained prepared handle. Only a consumed fetched body is a usable
> verdict; every other outcome abstains. The `pi:*` panel members remain
> external shellouts driving the shared `CQ::implement-review` rubric.
>
> **Conflict-resolver dispatch.** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }`, dispatch
> with the frontier model and `isolation: "worktree"`, require the same
> store/handle-only/confirm/fetch sequence, and accept only the consumed fetched
> body. Every other lifecycle outcome enters the command's bailout; never fall back to
> a body-returning completion.
