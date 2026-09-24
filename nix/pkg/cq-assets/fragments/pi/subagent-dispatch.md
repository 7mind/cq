> **Subagent dispatch (Pi).** `CQ_SUBAGENT` means the PARENT-OWNED ref-first
> lifecycle. On this surface the parent both prepares and settles, because a
> capability token is returned by `prepare_dispatch` exactly once and is
> persisted only as a hash — nothing can recover it afterwards, and it must
> never cross a prompt, argv, environment, transcript or tool result.
>
> 1. Call `prepare_dispatch` with the role's typed input.
> 2. Materialize that input exactly once with `fetch_dispatch_input`.
> 3. Launch
>    `dispatch_agent(agent: "<role>", task: "<materialized typed input>", targetRef: "<canonical-ref>")`.
>    `task` carries the materialized typed input and nothing else — never a
>    capability, never assembled role instructions, never a body-returning
>    request. The cq-subagent-dispatch extension runs the role as an isolated
>    child turn and injects the packaged role at the child boundary. The target
>    is the owning `tasks:T`, `goals:G`, `defects:D`, or `researches:RS` item,
>    never a child hypothesis.
> 4. Take the child's fenced `json` block from the returned body and submit it
>    verbatim with the dispatch-scoped `store_result`, whose `resultCapability`
>    the parent alone holds. Submitting anything the child did not return
>    is fabrication, not delegation; a child that returned no fenced result is a
>    failed dispatch to abort, never a body to paraphrase.
> 5. Confirm or abort through the parent, then materialize a validated result
>    exactly once with `fetch_dispatch_result`.
>
> Skipping step 4 is what leaves an attestation prepared until trusted
> completion aborts it `missing-result`. Never simulate the delegated role
> inline. An unavailable scoped store or extension aborts the dispatch; it never
> falls back to a body-returning completion.
