### Dispatch input delivery (Pi)

The launch prompt carries `attestationId`, `generation`, and `inputCapability`.
Before inspecting the historical record, call the `fetch_dispatch_input` tool
exactly once and treat its typed input as the complete audit assignment. A
failed or second retrieval is a protocol failure. Call `store_result` without
`resultCapability`: your ledger connection holds it for this dispatch.
