> **Subagent dispatch (Codex).** `CQ_SUBAGENT` means the repository-owned
> `cq-codex-role` process boundary, never the native `spawn_agent` transport.
> Write one JSON request to its stdin:
> `{ roleId, handle:{attestationId,generation}, inputCapability, cwd, model,
> reasoningEffort, sandboxMode, timeoutMs }`. Keep capabilities off argv.
> The adapter supplies the packaged role body as native developer instructions,
> starts `codex exec` in `cwd` with the selected model, effort, and sandbox,
> disables child collaboration, and exposes only the role matrix's ledger
> profile before model context construction. Its intercepted stdout contains
> only the verified dispatch handle. Treat process completion as the trusted
> extension observation for confirm/fetch; never simulate the role inline.
