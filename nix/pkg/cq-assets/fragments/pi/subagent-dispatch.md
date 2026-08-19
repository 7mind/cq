> **Subagent dispatch (Pi).** `CQ_SUBAGENT` means the extension-local
> ref-first lifecycle. Call `prepare_dispatch` with the role's typed input,
> then launch
> `dispatch_agent(agent: "<role>", task: "<dispatch-handle>", targetRef: "<canonical-ref>")`.
> `task` is the opaque dispatch handle only — never assembled role
> instructions, never a body-returning request. The cq-subagent-dispatch
> extension runs the role as an isolated child turn and injects the packaged
> role at the child boundary. The target is the owning `tasks:T`, `goals:G`,
> `defects:D`, or `researches:RS` item, never a child hypothesis. Confirm or
> abort through the parent; materialize a validated result exactly once with
> `fetch_dispatch_result`. Never simulate the delegated role inline. An
> unavailable scoped store or extension aborts the dispatch; it never falls
> back to a body-returning completion.
