> **Run guard.** Before the first predicate read, run
> `touch "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-$CLAUDE_CODE_SESSION_ID"`.
> Before every return, run
> `rm -f "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-$CLAUDE_CODE_SESSION_ID"`.
> This sentinel engages the host stop hook only while this advance run is active.
