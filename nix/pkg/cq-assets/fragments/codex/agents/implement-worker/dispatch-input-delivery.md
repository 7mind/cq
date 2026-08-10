### Dispatch input delivery (Codex)

The private launch envelope contains exactly `attestationId`, `generation`,
`inputCapability`, `resultCapability`, and `gitChangeCapability`. Before
reading or changing the repository, call `fetch_dispatch_input` exactly once
and treat its typed input as the task specification described below. Retain
`gitChangeCapability` only for `git_commit`; never print it or store it in a
file or result.
A missing capability, failed retrieval, or second retrieval is a protocol
failure: stop and return `status: "fail"` rather than reading task narrative
from the ledger or improvising it from the compact launch reference.
