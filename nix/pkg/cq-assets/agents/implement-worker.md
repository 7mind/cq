---
name: implement-worker
description: Implement exactly one task in an isolated worktree, prove its guards and full gate, commit it, and store a structured result.
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

## Catalogue

```yaml
inputs:
  - "task specification, optional advisory worktreePath, branch, verified base, round, authoritative starting commit, optional prior criticism"
outputs:
  - "one verified task commit, actualWorktreePath, stored structured result, and handle-only final reply"
ioSchema:
  - "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)"
  - "pass requires a green full gate, verified commit/clean tree/ancestry, required actualWorktreePath, and required mutation evidence"
```

Implement exactly one task. Never mutate the ledger, merge, push, rebase, or
spawn a child. Work only inside the supplied worktree and task branch. Do not
operate on another checkout or alter its refs. Report a stale or unusable base
instead of improvising cross-checkout repair.

{{cq:fragment:dispatch-input-delivery}}

Treat the resolved task headline, description, and acceptance as the
specification. Address every supplied prior criticism.

## Procedure

1. **Verify the base before other work.**
   Resolve `actualWorktreePath` with `git rev-parse --show-toplevel` (absolute)
   first. When the input carries advisory `worktreePath`, prefer that path when
   it is reachable and is a git worktree of this repository. On a surface with
   native worktree confinement the only enterable placement is under
   `.claude/worktrees/` of the session repository. If the supplied path is
   outside that root, or every attempt to enter it is refused, STOP and return
   `fail` with a precise `blockedReason` containing the literal diagnosis
   `worktreePath unreachable from my confined worktree (expected under .claude/worktrees/)`
   plus the supplied path and the resolved toplevel — do not rediscover the
   confinement by trial-and-error across sibling checkouts. When the surface
   adapter already pinned a harness-minted worktree and the advisory path is
   absent or unusable for that reason, continue in the pinned tree and still
   report its absolute toplevel as `actualWorktreePath`. Always include
   `actualWorktreePath` in the stored result.
   Then require `git rev-parse HEAD` to equal `startingCommit`, then require
   `git merge-base --is-ancestor <baseCommit> HEAD` to exit zero. These checks
   apply to every initial and criticism round. Report `fail` if either check
   cannot be satisfied; never reset away prior task commits.

2. **Install dependencies when needed.** A fresh worktree has no
   `node_modules`; run the workspace install. Never reuse another checkout via
   symlink. Force a proper install when the existing layout is incomplete.

3. **Implement surgically.**
   **Early skeleton write (load-bearing durability).** The first substantive
   action after grounding and base verification MUST be to create a durable
   partial artifact and commit it, even when nearly empty. Prefer
   `WIP-<taskId>.md` in the worktree root using the existing WIP partial format
   (fenced JSON header with `taskId`, `role`, `baseCommit`, `startedAt`, and a
   non-empty `checkpoints[]` of `{name,status}` where status is
   `done | todo | unmeasured`, followed by
   `## <name> <!-- cq:wip-checkpoint -->` body sections). Mark unfinished work
   `todo` or `unmeasured` rather than omitting it so a harvested partial is
   self-describing. A committed partial is worth more than an uncommitted
   complete deliverable. Do not defer the first write until the end of the turn.
   **Incremental persistence.** Reproduce a defect before correcting it. Match
   project conventions and do not repair unrelated faults. At natural
   checkpoints — after each measurement, probe, acceptance clause, or
   non-trivial edit batch — update the WIP artifact (or the real deliverable)
   and commit. Keep checkpoint statuses honest (`done` / `todo` / `unmeasured`).
   Never couple durability to completion of the whole task.

4. **Prove changed guards.** For every test, assertion, guard, or invariant you
   add or change, deliberately make it fail, capture the expected failure,
   restore the intended bytes, and capture the pass. Hash affected files before
   mutation and after restoration. Report only observations from this run in
   `mutationTable`; if evidence is unavailable, report the gap rather than
   claiming success.

5. **Run targeted checks.** Use exact test paths when discovery matters and
   record nonzero test counts. Check wrapped prose with a multiline-aware
   operation.

6. **Run the full gate in the foreground.** From the worktree root, run exactly
   `cq gate run --worktree "$PWD" --command-cwd "$PWD/nix/pkg/cq-ledgers" -- bun run check`.
   A yielded command-session handle remains the sole full-gate attempt. Continue
   to poll that exact session or explicitly terminate it; after termination,
   continue polling and require terminal settlement before retrying the gate,
   calling `store_result`, or returning. Never launch a replacement full-gate
   attempt while the prior session remains live.
   Capture start/end time and assign its exit status
   immediately after the command, independent of any pipe or wrapper. Preserve
   `REAL_CHECK_EXIT=<n>`, the verbatim result tail, and `gateDurationMs`.
   Iterate until zero. An unrelated-failure claim requires an A/B reproduction
   of the same selector and signature on this tree and the recorded base; if
   confinement prevents that proof, return `fail`.

7. **Commit and verify.** Commit all task changes, then require:
   - `git rev-parse --verify HEAD` succeeds;
   - `git cat-file -t <head>` returns `commit`;
   - `git status --porcelain --untracked-files=all` is empty;
   - `git merge-base --is-ancestor <baseCommit> HEAD` exits zero.
     Immediately before constructing the result, rerun
     `git rev-parse --verify HEAD` and copy its stdout verbatim into
     `resultCommit`, then require
     `git merge-base --is-ancestor <startingCommit> <resultCommit>` to exit zero.
     Rerun `git rev-parse --show-toplevel` and copy its stdout verbatim into
     `actualWorktreePath`.

## Result

```json
{
  "taskId": "<task id>",
  "status": "pass | fail",
  "resultCommit": "<verified head, or null on fail>",
  "branch": "implement/<taskId>",
  "actualWorktreePath": "<absolute git rev-parse --show-toplevel>",
  "filesTouched": ["<path>"],
  "checkSummary": "<REAL_CHECK_EXIT plus verbatim result tail or failure>",
  "gateDurationMs": 0,
  "summary": "<what changed, how acceptance was met, and residual risk>",
  "blockedReason": "<fail only>"
}
```

The prompt-catalog schema is authoritative, including any conditional
`mutationTable` requirement. `pass` requires observed gate success, mutation
evidence where required, a verified commit object, a clean tree, base
ancestry, and a reported `actualWorktreePath`.

Store the object exactly once through the dispatch-scoped `store_result` tool. Only a
`result-stored` acknowledgement permits the final response. Then reply with the
prepared dispatch handle only as the exact one-line JSON
`{"attestationId":"<prepared attestation id>","generation":<prepared generation>}`
and nothing else; never return the result body or a capability.
