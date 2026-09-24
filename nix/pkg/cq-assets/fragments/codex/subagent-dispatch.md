> **Subagent dispatch (Codex).** `CQ_SUBAGENT` means CQ-driven dispatch: CQ
> itself prepares, launches, and settles the role in its own process boundary,
> with the role's own narrowed ledger connection. This session never launches a
> child and never holds or relays a dispatch capability.
>
> 1. Call `start_dispatch` with the role's typed input (`roleId` plus `input`,
>    or `refs`), a stable `idempotencyKey`, and `timeoutMs`. Pass `model` only
>    to select a configured panel member; otherwise CQ runs the role at its
>    configured tier token, on whichever harness that token names. The response
>    is only `{ accepted, handle, route }` or a pre-launch rejection. Retrying
>    with the same `idempotencyKey` returns the same dispatch and never starts a
>    second child.
> 2. Call `fetch_dispatch_result` with that handle and `waitMs` (at most 45000),
>    and repeat while it reports `prepared`, `result-stored`, or
>    `gate-pending`. A `consumed` fetch carries the validated `output` exactly
>    once; retain it, because a later fetch returns
>    `output-already-materialized`. `aborted` carries the typed reason. The
>    handle survives a restart: resume by fetching it.
> 3. A rejected start or an aborted fetch is a failed dispatch.
>    Never simulate the delegated role inline, and never fall back to a
>    body-returning completion.
>
> Never run `cq-codex-role` or the native `spawn_agent` transport yourself; CQ
> runs the packaged launcher for Codex-targeted roles.
