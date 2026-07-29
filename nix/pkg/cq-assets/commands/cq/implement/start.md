---
description: Resolve implementation scope, validate the initial task DAG, and run the implementation advance loop.
argument-hint: [milestoneId ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}

## Catalogue
```yaml
inputs:
  - "optional milestone ids; empty selects every active milestone with non-terminal tasks"
outputs:
  - "scope/ready-set report, inline implementation run, and one outer handoff"
ioSchema:
  - "bootstrap only; implement advance owns execution and suppresses its nested handoff"
```

With explicit ids, validate that every milestone exists and is active. Without
ids, select all active milestones containing non-terminal tasks. Do not ask for
scope, branch, or cadence confirmation; the current branch is the integration
target and the run continues until drained or genuinely blocked.

Read tasks, task dependencies, milestone dependencies, and linked questions.
Report target ids, task counts, and the initial ready set. A target with no
ready task may remain included while other targets progress.

Run `CQ::implement/advance` inline for the resolved set. It owns worktrees,
dispatch, review, correction, questions, verification, merge-back, logs, and
the final execution report. Suppress its handoff because this wrapper writes
one using the implement-advance mapping.

After user answers unblock tasks, resume with implement advance directly; the
bootstrap need not run again.
