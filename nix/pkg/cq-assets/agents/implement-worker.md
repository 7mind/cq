---
name: implement-worker
description: Implement exactly one task in an isolated worktree, prove its guards and full gate, commit it, and store a structured result.
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

## Catalogue
```yaml
inputs:
  - "task specification, isolated worktree/branch, verified base, round, authoritative starting commit, optional prior criticism"
outputs:
  - "one verified task commit, stored structured result, and handle-only final reply"
ioSchema:
  - "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)"
  - "pass requires a green full gate, verified commit/clean tree/ancestry, and required mutation evidence"
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
   Require `git rev-parse HEAD` to equal `startingCommit`, then require
   `git merge-base --is-ancestor <baseCommit> HEAD` to exit zero. These checks
   apply to every initial and criticism round. Report `fail` if either check
   cannot be satisfied; never reset away prior task commits.

2. **Install dependencies when needed.** A fresh worktree has no
   `node_modules`; run the workspace install. Never reuse another checkout via
   symlink. Force a proper install when the existing layout is incomplete.

3. **Implement surgically.** Reproduce a defect before correcting it. Match
   project conventions and do not repair unrelated faults.

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

## Result

```json
{
  "taskId": "<task id>",
  "status": "pass | fail",
  "resultCommit": "<verified head, or null on fail>",
  "branch": "implement/<taskId>",
  "filesTouched": ["<path>"],
  "checkSummary": "<REAL_CHECK_EXIT plus verbatim result tail or failure>",
  "gateDurationMs": 0,
  "summary": "<what changed, how acceptance was met, and residual risk>",
  "blockedReason": "<fail only>"
}
```

The prompt-catalog schema is authoritative, including any conditional
`mutationTable` requirement. `pass` requires observed gate success, mutation
evidence where required, a verified commit object, a clean tree, and base
ancestry.

Store the object exactly once through the dispatch-scoped `store_result` tool. Only a
`result-stored` acknowledgement permits the final response. Then reply with the
prepared dispatch handle only as the exact one-line JSON
`{"attestationId":"<prepared attestation id>","generation":<prepared generation>}`
and nothing else; never return the result body or a capability.
