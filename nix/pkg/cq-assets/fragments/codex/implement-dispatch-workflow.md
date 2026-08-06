> **Implement-worker dispatch.** In Codex, for each
> `implement-worker`,
> compose refs only:
> `{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, priorReviewId?, guidance?, resolvedModel? }`,
> then call `prepare_dispatch`. The server reads the task/review narrative and
> validates the assembled input against the role's typed `inputSchema`. Dispatch
> `CQ_SUBAGENT` by writing the complete private request described above to the
> adapter's stdin. Retain the prepared handle, `inputCapability`, and
> `resultCapability`; set `cwd` to the child execution worktree and `ledgerCwd` to the
> parent project. The child calls `fetch_dispatch_input` exactly once before
> work, so no parent-rendered task narrative enters the launch. Await its
> handle-only final response after its capability-scoped `store_result`, confirm
> the observed native completion, and call `fetch_dispatch_result` exactly once
> with the exact handle retained from `prepare_dispatch`. Apply the blocking
> consumed-only rule before interpreting the worker result; never key the
> fetch on any child-reported identifier. Never put the input body or either
> capability in argv.
> If the adapter rejects an invalid final reply after it can observe the `result-stored` acknowledgement, the trusted parent persists only that
> lifecycle state and the adapter's bounded diagnostic through `cq log put`,
> then calls `abort_dispatch` with reason `protocol-violation`. Do not expose
> the stored payload or use either materialization operation on this path.
>
> **Implement-reviewer dispatch.** For each process-boundary
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism?, parentGateAttestation? }`.
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because `prepare_dispatch` binds those absolute values. When the
> reviewer runs under the `read-only` sandbox (gate primitives denied), attach
> `parentGateAttestation` from a just-run or freshly run full gate on the worker
> tip before launch: `{ resultCommit, gateExitCode, passCount, failCount,
> gateDurationMs?, command, capturedAt }` with `resultCommit` equal to the
> worker tip, `gateExitCode === 0`, `failCount === 0`, and `passCount > 0`.
> Never use `danger-full-access` to let the child re-run the gate. Non-sandboxed
> reviewers omit `parentGateAttestation` and re-run the gate themselves. Then
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
