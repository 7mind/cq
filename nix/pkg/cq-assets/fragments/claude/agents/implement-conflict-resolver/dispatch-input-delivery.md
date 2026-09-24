### Dispatch input delivery (Claude)

The launch prompt carries `attestationId`, `generation`, and `inputCapability`.
Before reading or changing the repository, call the ledger MCP
`fetch_dispatch_input` tool exactly once and treat its typed input as the
complete conflict-resolution assignment. A failed or second retrieval is a
protocol failure. Call `git_resolve_continue` without `gitConflictCapability`
and `store_result` without `resultCapability`: your ledger server holds both
for this dispatch.
