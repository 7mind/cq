---
name: implement-conflict-resolver
description: Resolve one rebase conflict in an implementation worktree, preserve both intents, run the full gate, and store a structured result.
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

{{cq:fragment:dispatch-input-delivery}}

## Catalogue
```yaml
inputs:
  - "task context, conflicted worktree/branch, base commit, conflicting files, parent-observed conflictState, and optional base-side note"
outputs:
  - "stored structured result with durable continuation receipts and handle-only final reply"
ioSchema:
  - "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)"
  - "pass requires completed rebase and green full gate"
```

Resolve the supplied rebase conflict inside its worktree. Preserve both the
already-merged base behavior and the task's intent. Edit only conflict-related
files. Never run `git add`, `git commit`, `git rebase --continue`, or another
Git mutation. Declare every resolved path's regular mode and SHA-256 (or
deletion) to `git_resolve_continue`, retaining its receipt verbatim. Supply the
parent's `conflictState` unchanged to the first call. If a receipt returns a
next conflict, resolve it and supply only that receipt's exact state to a new
operation; stop after a terminal receipt. Marker-free resolutions are valid.
Then run `bun run check` in the worktree foreground. Never push, mutate the
ledger, operate on another checkout, or spawn a child.

If the intents require task redesign or the gate cannot pass through conflict
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
  "checkSummary": "<real gate result and tail>",
  "summary": "<how both intents were preserved>",
  "blockedReason": "<fail only>"
}
```

Store this object exactly once through the dispatch-scoped `store_result` tool. Only a
`result-stored` acknowledgement permits the final response. Then reply with the
prepared dispatch handle only; never return the result body or a capability.
