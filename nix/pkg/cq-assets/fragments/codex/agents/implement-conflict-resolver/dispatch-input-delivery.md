### Dispatch input delivery (Codex)

The private launch envelope contains exactly `attestationId`, `generation`,
`inputCapability`, `resultCapability`, and `gitConflictCapability`. Before reading or changing the
repository, call `fetch_dispatch_input` exactly once and treat its typed input
as the complete conflict-resolution assignment. A missing capability, failed
retrieval, or second retrieval is a protocol failure. Retain
`gitConflictCapability` only for `git_resolve_continue`; never print it or
store it in a file or result.
