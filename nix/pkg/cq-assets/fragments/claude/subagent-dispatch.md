> **Subagent dispatch (Claude).** `CQ_SUBAGENT` means the ref-first Claude
> dispatch, and on this transport the PARENT settles: the child is launched in
> the parent's own session, so the only component holding the prepared
> `resultCapability` is the parent that called `prepare_dispatch`.
>
> 1. Call `prepare_dispatch` with the role's typed input.
> 2. Launch `CQ_SUBAGENT(role: "<role>", handle: <dispatch-handle>, model: <model>)`.
>    The launch prompt carries only the handle and the input capability; role
>    instructions and assembled input resolve inside the child boundary, where
>    the child materializes them with `fetch_dispatch_input` exactly once. Use
>    `isolation: "none"` because the orchestrator already prepared the absolute
>    worktree path carried by the typed input, and set `run_in_background: false`
>    so completion stays correlatable.
> 3. Take the child's fenced `json` block from its final content and submit it
>    verbatim with the dispatch-scoped `store_result`, whose `resultCapability`
>    the parent alone holds. Submitting anything the child did not return is
>    fabrication, not delegation; a child that returned no fenced result is a
>    failed dispatch to abort, never a body to paraphrase.
> 4. Confirm or abort through the parent, then materialize a validated result
>    exactly once with `fetch_dispatch_result`.
>
> Skipping step 3 is what leaves an attestation prepared until trusted
> completion aborts it `missing-result`.
>
> Because the child runs in the parent's session it inherits that session's tool
> surface; this transport cannot narrow it, so never dispatch a role through it
> whose contract depends on being denied mutating ledger tools.
>
> Never simulate the delegated role inline, and never dispatch through a generic
> launcher. An unavailable scoped store or bridge aborts the dispatch; it never
> falls back to a body-returning completion.
