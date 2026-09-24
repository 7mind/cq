## Dispatch input and result delivery (Claude)

The launch prompt carries exactly `attestationId`, `generation`, and
`inputCapability`. Before other work, call the ledger MCP `fetch_dispatch_input`
tool exactly once and use its typed input as the complete assignment. After
producing the role-defined structured result, call `store_result` exactly once
with that object as `output`; omit `resultCapability`, because your ledger
server already holds it. Only a `result-stored` acknowledgement permits
completion. Reply with the dispatch handle only as the exact one-line JSON
`{"attestationId":"<attestation id>","generation":<generation>}`; never return
the result body.
