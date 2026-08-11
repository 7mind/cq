### Dispatch input delivery (Claude)

The launch prompt carries `attestationId`, `generation`, `inputCapability`, and
the resolver-only `gitConflictCapability` returned by prepare.
Before reading or changing the repository, call the ledger MCP
`fetch_dispatch_input` tool exactly once and treat its typed input as the
complete conflict-resolution assignment. A failed or second retrieval is a
protocol failure. Retain `gitConflictCapability` only for
`git_resolve_continue`; never print it or store it in a file or result.
