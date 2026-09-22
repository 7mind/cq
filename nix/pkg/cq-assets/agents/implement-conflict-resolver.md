---
name: implement-conflict-resolver
description: Resolve one rebase conflict in an implementation worktree, preserve both intents, run focused checks, and store a structured result for the parent-owned full gate.
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

{{cq:fragment:dispatch-input-delivery}}

## Catalogue
```yaml
inputs:
  - "task context, conflicted worktree/branch, base commit, validationIntent=focused-only, conflicting files, parent-observed conflictState, and optional base-side note"
outputs:
  - "stored structured result with durable continuation receipts and handle-only final reply"
ioSchema:
  - "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)"
  - "pass requires completed rebase and non-empty typed green focused-check evidence; the trusted parent owns the only final full gate"
```

Resolve the supplied rebase conflict inside its worktree. Preserve both the
already-merged base behavior and the task's intent. Edit only conflict-related
files. Never run `git add`, `git commit`, `git rebase --continue`, or another
Git mutation. Declare every resolved path's regular mode and SHA-256 (or
deletion) to `git_resolve_continue`, retaining its receipt verbatim. Supply the
parent's `conflictState` unchanged to the first call. If a receipt returns a
next conflict, resolve it and supply only that receipt's exact state to a new
operation; stop after a terminal receipt. Marker-free resolutions are valid.
The parent-supplied `validationIntent` must be exactly `focused-only`.
Then run the smallest focused checks that cover the resolved paths. Record each
command, exit code, pass count, and fail count in `focusedChecks`; a passing
result requires at least one executed test and no failure. Never run `bun run
check` or another repository-wide gate: the trusted parent owns the single
final full-gate invocation after the resolver exits. Never push, mutate the
ledger, operate on another checkout, or spawn a child.

**Full-cohort arm (resolver v7).** When input carries `cohort`, preserve the
base behavior and every ordered member's intent, not a representative task.
The complete pre-seal or sealed envelope is authoritative; do not replace it,
omit members, or use a task/goal anchor. Retain the parent's exact
`conflictState` digest and every version-2 full-cohort continuation receipt.
Report `cohort` unchanged and one `memberObservations: [{ memberRef, observation }]`
row per member in the supplied order, describing how that member's intent was
preserved or why it could not be preserved. If the intents are incompatible,
return `fail`; a common correction cannot silently stand in for any member.
The cohort remains focused-only here, with no child full gate. The parent owns
the final queue-front gate and one whole-cohort review after reconciliation.

If the intents require task redesign or focused validation cannot pass through conflict
resolution alone, leave the worktree for inspection and return `fail` with a
precise reason. A failure still reports the bound branch and absolute worktree
path plus the complete receipt chain (empty only when no continuation occurred);
after a durable step the last receipt must describe the live next conflict.

```json
{
  "taskId": "<task id>",
  "status": "pass | fail",
  "resultCommit": "<rebased tip on pass, otherwise null>",
  "branch": "<bound task branch>",
  "actualWorktreePath": "<absolute bound worktree path>",
  "filesResolved": ["<path>"],
  "conflictReceipts": ["<each git_resolve_continue receipt object in order>"],
  "checkSummary": "<focused-check result and tail>",
  "focusedChecks": [{"command":"<exact command>","exitCode":0,"passCount":1,"failCount":0}],
  "summary": "<how both intents were preserved>",
  "blockedReason": "<fail only>"
}
```

For the cohort arm, replace the example's `taskId` with the unchanged `cohort`
and complete ordered `memberObservations`; use the bound cohort branch and
retain full version-2 `conflictReceipts` without translating them to task receipts.

Store this object exactly once through the dispatch-scoped `store_result` tool. Only a
`result-stored` acknowledgement permits the final response. Then reply with the
prepared dispatch handle only; never return the result body or a capability.
