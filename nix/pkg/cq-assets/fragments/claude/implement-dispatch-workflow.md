> **Catalog-driven dispatch (G41 — implement-worker).** In Claude's ref-first
> procedure, for each
> `implement-worker`, compose refs only:
> `{ roleId, surface, projectKey, taskId, coordinates, round?, priorReviewId?, guidance?, resolvedModel? }`.
> Call `prepare_dispatch`; the server reads the task/review narrative, assembles
> it against the generated role's `inputSchema`, and returns a handle plus a
> distinct `inputCapability`. Retain only the handle, input capability, and
> deadlines in the orchestrator. Dispatch `CQ_SUBAGENT` with the worker role, the §K4
> model, `isolation: "none"`, `run_in_background: false`, and the serialized
> `{ attestationId, generation, inputCapability }` as its entire launch prompt.
> The child calls `fetch_dispatch_input` exactly once before work; the parent
> never reads or launches the task narrative. Require the bridge's handle-only
> native-completion confirmation with actual child/run/model provenance, then
> call `fetch_dispatch_result` exactly once to materialize the already-validated
> worker result.
>
> **Catalog-driven dispatch (G41 — implement-reviewer).** Apply the same sequence
> to every native `claude:*` `implement-reviewer` with
> `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`, using the reviewer's resolved model. A bridge failure makes
> that reviewer abstain under the returned-failure rule. The `pi:*` panel members
> remain external shellouts driving the shared `CQ::implement-review` rubric.
>
> **Catalog-driven dispatch (G41 — implement-conflict-resolver).** On a merge
> conflict, prepare `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }` for
> `implement-conflict-resolver` and use the §K4 FRONTIER model through the same
> handle-only sequence. A prepare, scoped-store, correlation, confirmation, or
> fetch failure enters the §5 bailout. A second materialization attempt is a
> protocol violation. Never fall back to a body-returning completion.
