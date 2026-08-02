> **Implement-worker dispatch.** In Claude's ref-first
> procedure, for each
> `implement-worker`, compose refs only:
> `{ roleId, surface, projectKey, taskId, coordinates, round, startingCommit, priorReviewId?, guidance?, resolvedModel? }`.
> Call `prepare_dispatch`; the server reads the task/review narrative, assembles
> it against the generated role's `inputSchema`, and returns a handle plus a
> distinct `inputCapability`. Retain the exact prepared handle independently of
> every child-visible value, plus the input capability and deadlines. Dispatch
> `CQ_SUBAGENT` with the worker role, the resolved
> model, `isolation: "none"`, synchronous execution, and the serialized
> `{ attestationId, generation, inputCapability }` as its entire launch prompt.
> The child calls `fetch_dispatch_input` exactly once before work; the parent
> never reads or launches the task narrative. Require the bridge's handle-only
> native-completion confirmation with actual child/run/model provenance, then
> call `fetch_dispatch_result` with the retained prepared handle exactly once.
> Apply the blocking consumed-only rule before interpreting the
> already-validated worker result.
>
> **Implement-reviewer dispatch.** Apply the same sequence
> to every native `claude:*` `implement-reviewer` with
> `{ taskId, acceptance, worktreePath, branch, baseCommit, workerResult, round, priorCriticism? }`, using the reviewer's resolved model. A bridge failure makes
> that reviewer abstain under the returned-failure rule; only the fetched
> consumed body is a usable verdict. The `pi:*` panel members remain external
> shellouts driving the shared `CQ::implement-review` rubric.
>
> **Conflict-resolver dispatch.** On a merge
> conflict, prepare `{ taskId, headline?, description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote? }` for
> `implement-conflict-resolver` and use the frontier model through the same
> handle-only sequence. A prepare, scoped-store, correlation, confirmation, or
> fetch failure enters the command's bailout. Only the fetched consumed body is a
> usable resolution. A second materialization attempt is a protocol violation.
> Never fall back to a body-returning completion.
