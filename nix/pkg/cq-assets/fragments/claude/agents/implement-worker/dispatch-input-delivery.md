### Dispatch input delivery (Claude)

The launch prompt carries only
`{ attestationId, generation, inputCapability }`. Before reading or changing
the repository, call the ledger MCP `fetch_dispatch_input` tool exactly once
with those three fields. Treat its returned `input` as the task specification
described below. A missing capability, failed retrieval, or second retrieval is
a protocol failure: stop and return `status: "fail"` rather than reading task
narrative from the ledger or improvising it from the compact launch reference.
