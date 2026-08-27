### Dispatch input delivery (Codex)

The private launch envelope contains exactly `attestationId`, `generation`,
`inputCapability`, and `resultCapability`. Before inspecting the historical
record, call `fetch_dispatch_input` exactly once and treat its typed input as
the complete audit assignment. A missing capability, failed retrieval, or
second retrieval is a protocol failure.
