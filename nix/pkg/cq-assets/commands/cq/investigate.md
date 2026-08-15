---
description: Create or resume a defect, then run one investigation round.
argument-hint: <defect description | defectId>
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}
Effect-boundary authority follows this shared contract:

{{cq:fragment:workset-effect-discipline}}

## Catalogue
```yaml
inputs:
  - "free-text defect description or existing defect id"
outputs:
  - "new/resumed defect, inline investigation round, and one outer handoff"
ioSchema:
  - "new defects require headline, description, and critical|high|medium|low severity"
```

If `$ARGUMENTS` names an existing defect, fetch it with full projection. Reject
missing or terminal items; otherwise resume it.

For free text:

1. Search active defects by key terms and resume a matching item instead of
   duplicating it.
2. Infer severity:
   - `critical`: security, data loss, crash, or system-wide block;
   - `high`: major behavior unavailable without workaround;
   - `medium`: degraded behavior with a workaround;
   - `low`: cosmetic or narrow edge case.
   Ask one question only when adjacent tiers remain genuinely ambiguous.
3. Create an `Investigate: <short slug>` coordination milestone.
4. Create an `open` defect with a concise headline, complete description, and
   severity.

Run `CQ::investigate/advance <defectId>` inline. It owns hypotheses, evidence,
probes, research escalation, adjudication, goal seeding, and child logs.
Suppress its handoff because this wrapper writes one using the
investigate-advance mapping.

Report whether the defect was created or resumed, its milestone/severity, and
the complete round outcome. Resume later with investigate advance directly.
