> **Subagent dispatch (Pi).** `CQ_SUBAGENT` means
> `dispatch_agent(agent: "<role>", task: "<complete prompt>", targetRef: "<canonical-ref>")`. The
> cq-subagent-dispatch extension runs the role as an isolated child turn.
> The target is the owning `tasks:T`, `goals:G`, `defects:D`, or `researches:RS`
> item, never a child hypothesis.
> Never simulate the delegated role inline.
