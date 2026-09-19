# g213-t4 queue rollout contract

Version 1 upgrades live implementation attestations before the canonical queue
is acquired. Rows are considered in durable staging-time and handle order.
Managed worktrees are protected before disposition. Compatible
`gate-pending` rows are enrolled unqualified; exact trusted completion may then
qualify the same immutable attempt. Incompatible rows are parked, while legacy
`gate-running` rows are marked `execution-uncertain`. Exact completed-green
evidence is adopted only when its output, result commit, managed-worktree
binding, and supervised-gate evidence digests match.

The contract forbids synthesized completion or gate evidence, resurrection of
an old generation, credential or mount forwarding, and PostgreSQL-to-XDG state
handoff. Stale qualified attempts use the existing terminal staged-rebase
successor path.

G191 consumes the exported `g213-t4` record. The producer is independent of
G191; this prevents a circular implementation dependency.
