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
> `{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, validationIntent: "final", priorReviewId?, guidance? }`
> and call `start_dispatch` with them. CQ reads the task/review narrative,
> validates the assembled input against the role's typed `inputSchema` for the
> role's configured harness, launches the worker in the managed worktree
> through the packaged Codex launcher (or the configured harness's own process
> boundary), and runs the store-time gate and the parent gate itself. The
> parent never holds the input, result, parent-gate, or worker Git capability,
> and no parent-rendered task narrative enters the launch. Wait with
> `fetch_dispatch_result` (`waitMs`) until the dispatch is terminal, keyed only
> on the handle `start_dispatch` returned, never on any child-reported
> identifier. Apply the blocking consumed-only rule before interpreting the
> worker result. The worker uses only `git_commit` for incremental commits and
> returns every receipt in its result. Before accepting a passing result,
> require the dispatch-scoped `store_result` to have run the canonical full gate at the trusted result-storage boundary
> and attached strict, versioned
> `supervisedGateEvidence`; the sandboxed worker neither runs that gate nor
> supplies the evidence. Require exact task/result commit/branch/worktree
> binding, `clean === true`, `gateExitCode === 0`, `failCount === 0`, and
> `passCount > 0`. A red, zero-test, timed-out, cancelled, dirty, moved-tip, or
> replay attempt must remain unconsumable. Before accepting a passing result,
> require the complete durable receipt chain in commit order from the exact
> trusted origin (the ordinary dispatch base or server-resolved guarded
> rebased-start anchor) through the exact clean `resultCommit` tip. Authenticate
> every receipt's dispatch identity, contiguous old/new edge, actual commit
> parent, tree, sorted paths, and object data against Git; reject omissions,
> reorderings, substitutions, origin gaps, and unauthorized history.
> Independently require exact sorted `filesTouched` to equal the ordinary
> base-to-result or guarded onto-to-result net diff. Historical receipt paths
> may strictly exceed that net diff when later commits restore or remove paths.
> Only the server-resolved guarded exact-tip mode may use an empty fresh suffix,
> with `resultCommit` equal to the rebased tip.
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
> An invalid final reply after the `result-stored` acknowledgement is settled
> by CQ as a `protocol-violation` abort; the parent only observes it through
> the fetch. After terminal status, cleanup uses guarded
> `worktree_manage({ operation: "release", handle, terminalDisposition, … })`
> only — never raw git worktree lifecycle commands.
>
> **Implement-reviewer dispatch.** For each process-boundary
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism?, supervisedGateEvidence?, parentGateAttestation? }`.
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because CQ binds those absolute values. When the
> reviewer runs under either configured sandbox mode, pass through the trusted
> `supervisedGateEvidence` from the consumed worker result
> and require the reviewer to validate its exact bindings and green counts.
> For a legacy worker result without trusted evidence, attach
> `parentGateAttestation` from a just-run or freshly run full gate on the worker
> tip before launch: `{ resultCommit, gateExitCode, passCount, failCount,
> gateDurationMs?, command, capturedAt }` with `resultCommit` equal to the
> worker tip, `gateExitCode === 0`, `failCount === 0`, and `passCount > 0`.
> Never use `danger-full-access` to let the child re-run the gate. Non-sandboxed
> reviewers validate the same trusted evidence and rerun only when it is absent or invalid. Then
> start it through `CQ_SUBAGENT` with the member's configured token as `model`
> and wait with `fetch_dispatch_result`. Only a consumed fetched body is a usable
> verdict; every other outcome abstains. Members whose configured launch is an
> external adapter run through the implementation-evidence adapter path, not
> `start_dispatch`.
>
> **Conflict-resolver dispatch.** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, validationIntent: "focused-only", conflictingFiles, conflictState, baseSideNote? }`, start
> it through `CQ_SUBAGENT` at the frontier token, wait with
> `fetch_dispatch_result`, and accept only the consumed fetched body. CQ gives
> the resolver its git-conflict capability through its own launch and never
> exposes the worker's Git capability to it. The parent-observed `conflictState` binds the first continuation; require
> a non-empty receipt chain ending at the terminal `resultCommit`. Every other lifecycle outcome enters the command's bailout; never fall back to
> a body-returning completion.
