> **Inline CQ recursion (Pi).** When this workflow says to run a `CQ::<path>`
> command INLINE, load that command through `fetch_prompt("<path>")`, execute its
> `promptTemplate` in this session, and complete it before resuming this workflow.
> Do not ask the user to invoke it.
