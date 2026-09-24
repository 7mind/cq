> **Subagent dispatch (Codex).** `CQ_SUBAGENT` means the repository-owned
> `cq-codex-role` process boundary, never the native `spawn_agent` transport.
> Call `prepare_dispatch` with the role's typed input first.
> Write one JSON request to its stdin:
> `{ roleId, handle:{attestationId,generation}, inputCapability,
> resultCapability, effectTargetRef, parentGateCapability?, gitChangeCapability?,
> gitConflictCapability?, cwd, ledgerCwd, model, reasoningEffort, sandboxMode,
> timeoutMs }`, where `effectTargetRef` is the canonical
> `tasks:` / `goals:` / `defects:` / `researches:` identity admitted by the
> workset provider, never an admission capability; `cwd` is the child execution worktree
> and `ledgerCwd` is
> the parent project that owns the prepared dispatch. Keep capabilities off
> argv.
> Launch it stdin-preserving: run `stty -echo; exec cq-codex-role` through
> `exec_command` with `tty: true`, keep the returned session id, deliver the
> single newline-terminated JSON request through `write_stdin`, then poll that
> same session until it reports terminal completion.
> A default non-PTY `exec_command` reads EOF before `write_stdin` can attach —
> the boundary then exits with `request ended before a newline-terminated JSON
> value` — and `write_stdin` refuses a nonempty body on a non-TTY session.
> The adapter supplies the packaged role body as native developer instructions,
> starts `codex exec` in `cwd` with the selected model, effort, and sandbox,
> disables child collaboration, and exposes only the role matrix's ledger
> profile before model context construction. Its intercepted stdout contains
> only the verified dispatch handle. Treat process completion as the trusted
> extension observation for confirm/fetch; materialize a validated result
> exactly once with `fetch_dispatch_result`. Never simulate the role inline.
