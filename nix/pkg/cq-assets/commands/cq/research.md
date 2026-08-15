---
description: Create or resume an empirical research item, then run one research round.
argument-hint: <research question | researchId>
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:ledger-response-contract}}
Effect-boundary authority follows this shared contract:

{{cq:fragment:workset-effect-discipline}}

## Catalogue
```yaml
inputs:
  - "free-text empirical question or existing research id"
outputs:
  - "new/resumed research, inline research round, and one outer handoff"
ioSchema:
  - "research lifecycle: open -> wip -> concluded|inconclusive; abandonment is user-initiated"
```

Use research only for unknowns answerable by evidence or experiment. A
requirements, policy, scope, or preference choice belongs in a user question
instead.

If `$ARGUMENTS` names an existing research item, fetch it with full projection.
Reject missing or terminal (`concluded`/`abandoned`) items; resume `open`,
`wip`, or `inconclusive`.

For free text:

1. Recheck empirical-versus-user triage.
2. Search active researches by key terms and resume a matching item instead of
   duplicating it.
3. Derive an optional bounded scope from the supplied context.
4. Create a `Research: <short slug>` coordination milestone.
5. Create an `open` research item with the complete question and optional
   scope.

Run `CQ::research/advance <researchId>` inline. It owns hypotheses, explorers,
experiments, evidence validation, adjudication, synthesis, and child logs.
Suppress its handoff because this wrapper writes one using the research-advance
mapping.

Report whether the research was created or resumed, its milestone/scope, and
the complete round outcome. Resume later with research advance directly.
