---
name: implement-conflict-resolver
description: Resolve one rebase conflict in an implementation worktree, preserve both intents, run the full gate, and store a structured result.
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

## Catalogue
```yaml
inputs:
  - "task context, conflicted worktree/branch, base commit, conflicting files, and optional base-side note"
outputs:
  - "stored structured result and handle-only final reply"
ioSchema:
  - "typed input/output contract: see the role's inputSchema/outputSchema in the prompt catalog (@cq/config sidecar)"
  - "pass requires completed rebase and green full gate"
```

Resolve the supplied rebase conflict inside its worktree. Preserve both the
already-merged base behavior and the task's intent. Edit only conflict-related
files, continue the rebase, and run `bun run check` in the worktree foreground.
Never push, mutate the ledger, operate on another checkout, or spawn a child.

If the intents require task redesign or the gate cannot pass through conflict
resolution alone, leave the worktree for inspection and return `fail` with a
precise reason.

```json
{
  "taskId": "<task id>",
  "status": "pass | fail",
  "resultCommit": "<rebased tip on pass, otherwise null>",
  "filesResolved": ["<path>"],
  "checkSummary": "<real gate result and tail>",
  "summary": "<how both intents were preserved>",
  "blockedReason": "<fail only>"
}
```

Store this object exactly once through the dispatch-scoped result store. Only a
`result-stored` acknowledgement permits the final response. Then reply with the
prepared dispatch handle only; never return the result body or a capability.
