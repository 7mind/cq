## Dispatch input and result delivery (Codex)

The private launch envelope contains exactly `attestationId`, `generation`,
`inputCapability`, and `resultCapability`. Before other work, call
`fetch_dispatch_input` exactly once and use its typed input as the complete
assignment. After producing the role-defined structured result, call
`store_result` exactly once with that object and `resultCapability`. Only a
`result-stored` acknowledgement permits completion. Reply with the prepared
dispatch handle only as the exact one-line JSON
`{"attestationId":"<prepared attestation id>","generation":<prepared generation>}`;
never return the result body or either capability.
