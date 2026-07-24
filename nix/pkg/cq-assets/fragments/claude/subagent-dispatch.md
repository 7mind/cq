> **Subagent dispatch (Claude).** `CQ_SUBAGENT` means the native
> `Agent(subagent_type: "<role>", ...)` transport. Pass the complete task prompt
> and requested model; add `isolation: "worktree"` wherever the workflow
> requires an isolated worktree. Never simulate the delegated role inline.
