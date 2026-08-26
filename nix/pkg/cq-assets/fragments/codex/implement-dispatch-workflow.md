> **Implement-worker dispatch.** In Codex, for each
> `implement-worker`, first ensure a managed worktree via
> `worktree_manage({ operation: "prepare", taskId, baseCommit: <full main tip> })`
> (or resume-by-handle with the retained opaque handle). Use the returned
> absolute path as advisory `worktreePath` / coordinates and as the child `cwd`.
> Retain the handle across criticism rounds; on restart recover via prepare's
> resume-required response. For an exact pre-registry tree only, use handle-free
> prepare with paired
> `adoptWorktreePath: <canonical .claude/worktrees/implement-<taskId>>` and
> `expectedHead: <observed full HEAD>`; never combine them with a handle, and
> never supply activity-fence, registry, reconciliation, Git, or install
> authority. Retain the returned opaque handle and refuse launch when adoption
> refuses. Then compose refs only:
> `{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, priorReviewId?, guidance?, resolvedModel? }`,
> then call `prepare_dispatch`. The server reads the task/review narrative and
> validates the assembled input against the role's typed `inputSchema`. Dispatch
> `CQ_SUBAGENT` by writing the complete private request described above to the
> adapter's stdin. Retain the prepared handle, `inputCapability`,
> `resultCapability`, and the `parentGateCapability` returned by
> `prepare_dispatch`; forward that exact parent-only capability in the private
> implement-worker request, alongside the exact prepared `effectTargetRef`.
> Retain worker-only `gitChangeCapability`; set `cwd` to the managed worktree
> path and `ledgerCwd` to the parent project. The child calls
> `fetch_dispatch_input` exactly once before
> work, so no parent-rendered task narrative enters the launch. Await its
> handle-only final response after its capability-scoped `store_result`, confirm
> the observed native completion, and call `fetch_dispatch_result` exactly once
> with the exact handle retained from `prepare_dispatch`. Apply the blocking
> consumed-only rule before interpreting the worker result; never key the
> fetch on any child-reported identifier. Never put the input body or either
> capability in argv. The worker uses only `git_commit` for incremental commits;
> the parent retains every returned receipt. Before accepting a passing result,
> require `store_result` to have run the canonical full gate at the trusted result-storage boundary
> and attached strict, versioned
> `supervisedGateEvidence`; the sandboxed worker neither runs that gate nor
> supplies the evidence. Require exact task/result commit/branch/worktree
> binding, `clean === true`, `gateExitCode === 0`, `failCount === 0`, and
> `passCount > 0`. A red, zero-test, timed-out, cancelled, dirty, moved-tip, or
> replay attempt must remain unconsumable. Before accepting a passing result,
> require a non-empty receipt chain in commit order; verify each old/new head
> edge and receipt tree against Git, require the final new head to equal
> `resultCommit`, and require the union of receipt paths to equal
> `filesTouched`.
>
> **Guarded-rebase redispatch.** When a journaled guarded rebase rewrote the
> managed tip, the worker redispatch prepare names the exact terminal prior
> worker generation through `reprepareOf` and carries the exact retained
> reference as `guardedRebase`; never place `guardedRebaseLineage` or any
> journal coordinate in caller input. The server resolves the reference against
> its terminal durable journal, verifies the declared coordinates, and injects
> the closed lineage into the worker input. Accept a consumed guarded result
> only when its `gitLineage` echoes the resolved bridge exactly, its receipt
> chain is the fresh post-rebase suffix beginning at the rebased head (empty
> only in the server-resolved exact-tip mode, with `resultCommit` equal to the
> rebased tip), its `filesTouched` equals the onto-commit-to-result diff set,
> and fresh runner-owned `supervisedGateEvidence` binds the rebased tip before
> any review.
> If the adapter rejects an invalid final reply after it can observe the `result-stored` acknowledgement, the trusted parent persists only that
> lifecycle state and the adapter's bounded diagnostic through `cq log put`,
> then calls `abort_dispatch` with reason `protocol-violation`. Do not expose
> the stored payload or use either materialization operation on this path.
> After terminal status, cleanup uses guarded
> `worktree_manage({ operation: "release", handle, terminalDisposition, … })`
> only — never raw git worktree lifecycle commands.
>
> **Implement-reviewer dispatch.** For each process-boundary
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism?, supervisedGateEvidence?, parentGateAttestation? }`.
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because `prepare_dispatch` binds those absolute values. When the
> reviewer runs under the `read-only` sandbox (gate primitives denied), pass
> through the trusted `supervisedGateEvidence` from the consumed worker result
> and require the reviewer to validate its exact bindings and green counts.
> For a legacy worker result without trusted evidence, attach
> `parentGateAttestation` from a just-run or freshly run full gate on the worker
> tip before launch: `{ resultCommit, gateExitCode, passCount, failCount,
> gateDurationMs?, command, capturedAt }` with `resultCommit` equal to the
> worker tip, `gateExitCode === 0`, `failCount === 0`, and `passCount > 0`.
> Never use `danger-full-access` to let the child re-run the gate. Non-sandboxed
> reviewers omit both evidence fields and re-run the gate themselves. Then
> dispatch through `CQ_SUBAGENT`, require its capability-scoped `store_result`
> plus handle-only final response, confirm native completion, and fetch once
> with the retained prepared handle. Only a consumed fetched body is a usable
> verdict; every other outcome abstains. The `pi:*` panel members remain
> external shellouts driving the shared `CQ::implement-review` rubric.
>
> **Conflict-resolver dispatch.** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, conflictState, baseSideNote? }`, dispatch
> with the frontier model and `isolation: "worktree"`, require the same
> store/handle-only/confirm/fetch sequence, and accept only the consumed fetched
> body. The parent-observed `conflictState` binds the first continuation; require
> a non-empty receipt chain ending at the terminal `resultCommit`. Every other lifecycle outcome enters the command's bailout; never fall back to
> a body-returning completion.
