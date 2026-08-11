> **Implement-worker dispatch.** In Pi, for each
> `implement-worker`, first ensure a managed worktree via
> `worktree_manage({ operation: "prepare", taskId, baseCommit: <full main tip> })`
> (or resume-by-handle with the retained opaque handle). Use the returned
> absolute path as advisory `worktreePath`. Retain the handle across criticism
> rounds; on restart recover via prepare's resume-required response. Then
> adopt an exact pre-registry tree only through handle-free prepare with paired
> `adoptWorktreePath: <canonical .claude/worktrees/implement-<taskId>>` and
> `expectedHead: <observed full HEAD>`; never combine them with a handle, and
> never supply activity-fence, registry, reconciliation, Git, or install
> authority. Retain the returned opaque handle and refuse launch when adoption
> refuses. Then compose
> `{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, round, startingCommit, priorCriticism? }` against the role's typed `inputSchema`, dispatch
> `CQ_SUBAGENT` with the composed input and `isolation: "worktree"`.
>
> **Result authority (Pi held freeform).** When the Pi extension-local
> prepare/store/confirm/fetch lifecycle is available, materialize only a
> consumed, schema-valid result through that gate — never trust a
> child-reported handle alone. Until that lifecycle ships, the **held freeform**
> path is authoritative under parent verification: the parent MUST independently
> require (1) `resultCommit` is a full-SHA commit object equal to the worker
> branch tip, (2) `git merge-base --is-ancestor <startingCommit> <resultCommit>`,
> (3) clean worktree vs claimed files, (4) `REAL_CHECK_EXIT=0` from a parent-
> observed full gate (or an equivalent parent-attested green gate record), and
> (5) dual-review approve with empty criticism/questions before merge. Freeform
> authority is **not** consumed-handle semantics; do not claim
> `state: "consumed"` without a prepare-bound handle. Do not bail out solely
> because freeform lacks a prepare-bound result capability.
>
> After terminal status, cleanup uses guarded
> `worktree_manage({ operation: "release", handle, terminalDisposition, … })`
> only — never raw git worktree lifecycle commands.
>
> **Implement-reviewer dispatch.** For each native
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`,
> Omit `responseStoreNow`, `gateCompleteBy`, and `synthesisStoreReserveMs` from
> caller input because the authoritative dispatch lifecycle binds those
> absolute values when present, then dispatch through `CQ_SUBAGENT`. When the
> consumed-result gate is unavailable, accept a freeform structured verdict
> only after the parent independently verifies resultCommit + baseAncestry +
> gate evidence (same parent-verification bar as workers). The `pi:*` panel
> members remain external shellouts driving the shared `CQ::implement-review`
> rubric and count as votes under the external-reviewer usable-verdict rule.
>
> **Conflict-resolver dispatch.** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, conflictState, baseSideNote? }`, dispatch
> with the frontier model and `isolation: "worktree"` only when the extension
> delivers a prepare-bound `gitConflictCapability` to the child. Conflict
> continuation has no held-freeform mutation path: without that capability,
> fail closed and retain the managed worktree for inspection. Accept only a
> consumed result whose durable receipt chain ends at the terminal tip.
