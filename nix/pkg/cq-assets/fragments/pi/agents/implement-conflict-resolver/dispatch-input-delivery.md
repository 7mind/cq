### Dispatch input delivery (Pi — held protocol)

The Pi orchestrator supplies the complete typed conflict-resolution input
directly. Continue only when the private launch also supplies
`{ attestationId, generation, gitConflictCapability }` from one prepare; retain
the capability only for `git_resolve_continue`. Without that private envelope,
fail closed and leave the managed worktree for inspection.
