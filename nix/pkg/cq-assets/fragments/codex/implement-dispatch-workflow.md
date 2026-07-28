> **Catalog-driven dispatch (G41 — implement-worker).** In Codex, for each
> `implement-worker`,
> compose `{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit, priorCriticism? }` against the role's typed `inputSchema`, dispatch
> `CQ_SUBAGENT` with the composed input and `isolation: "worktree"`, await its
> result, and call `validate_output("implement-worker", output)` against the
> role's `outputSchema`; a validation failure is a contract breach to surface.
>
> **Catalog-driven dispatch (G41 — implement-reviewer).** For each native
> `implement-reviewer`, compose `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`,
> dispatch through `CQ_SUBAGENT`, await its verdict, and call
> `validate_output("implement-reviewer", output)`; a validation failure is a
> contract breach to surface. The `pi:*` panel members remain external shellouts
> driving the shared `CQ::implement-review` rubric.
>
> **Catalog-driven dispatch (G41 — implement-conflict-resolver).** For
> `implement-conflict-resolver`, compose `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }`, dispatch
> with the §K4 FRONTIER model and `isolation: "worktree"`, await its result, and
> call `validate_output("implement-conflict-resolver", output)`; a validation
> failure is a contract breach to surface. When the catalog output validator is
> absent, skip validation and use the bare `CQ_SUBAGENT` path; validator absence
> never blocks the pass.
