### Dispatch input delivery (Claude)

The launch prompt carries `attestationId`, `generation`, and `inputCapability`.
Before inspecting the historical record, call the ledger MCP
`fetch_dispatch_input` tool exactly once and treat its typed input as the
complete audit assignment. A failed or second retrieval is a protocol failure.
