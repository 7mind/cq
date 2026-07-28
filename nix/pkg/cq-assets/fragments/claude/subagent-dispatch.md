> **Subagent dispatch (Claude).** `CQ_SUBAGENT` means the ref-first Claude
> bridge. Prepare the typed role input first, then launch
> `CQ_SUBAGENT(role: "<role>", handle: <dispatch-handle>, model: <model>)`.
> The bridge selects the generated role,
> gives only that child a capability-scoped `store_result`, observes the actual
> child/run/model completion, confirms it, and returns a handle-only completion.
> The launch prompt contains only the handle; role instructions and assembled
> input resolve inside the child boundary. Use `isolation: "none"` because the
> orchestrator already prepared the absolute worktree path carried by the typed
> input, and set `run_in_background: false` so completion stays correlatable.
> Materialize a validated result exactly once with `fetch_dispatch_result`.
> Never simulate the delegated role inline and never dispatch through a generic
> launcher. An unavailable scoped store or bridge aborts the dispatch; it never
> falls back to a body-returning completion.
