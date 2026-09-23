## Memory grounding

The `memories` ledger holds durable project facts that no code, git history, or
item narrative records. It is inert unless a decision procedure reads it, so
grounding is a precondition of this flow, not ambient advice.

Before forming or dispatching the first hypothesis, plan, research synthesis,
or implementation of an invocation, run `fts_search` against `memories` for the
terms that identify the current target — its ids, the subsystem and file paths
it names, and the vocabulary of its headline — restricted to active items. Read
every plausible match in full before relying on it; a compact hit is enough to
decide relevance and never enough to decide anything else. Carry the resulting
facts into the decision you are about to make, and when the search returns
nothing relevant, record that no relevant memory exists rather than leaving the
step invisible. A later invocation of the same flow repeats the search, because
the target and the ledger both move.

A dispatched role has no domain-ledger reads of its own. Forward the selected
memory content to it as part of the prepared typed input, exactly like any
other context this flow supplies. Never widen a child's tool profile so it can
retrieve memories itself: retrieval is the parent's obligation, and a profile
widened to compensate for missing orchestration grants a durable capability to
solve a transient gap.

Record a new memory only for a confirmed durable project fact with useful
`sourceRefs`. Transient reasoning, session notes, and unconfirmed preferences
do not belong in this ledger.
