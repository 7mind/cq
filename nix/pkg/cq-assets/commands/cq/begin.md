---
description: Split a mixed request into plan, investigate, and research intakes, then run one sequencer pass.
argument-hint: "<mixed request>"
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
  - "free-form request containing any mix of capabilities, faults, and empirical questions"
outputs:
  - "deduplicated flow intakes, one aggregate ambiguity question, one sequencer pass, and a routing report"
ioSchema:
  - "new capability -> goal; existing fault -> defect; empirical unknown -> research; user-only choice -> question"
```

Split `$ARGUMENTS` into independently actionable segments while preserving
their detail. Ask for input if it is empty.

## Route

Classify each segment:

| Meaning | Route |
| --- | --- |
| new capability or change | plan |
| existing incorrect behavior | investigate |
| empirically answerable unknown | research |
| user-only requirement/preference or genuinely ambiguous intent | ambiguity question |

Do not ask for routing confirmation when the segment is clear.

Search the target ledger for each clear segment:

- exact live duplicate: report and skip;
- clear extension of a live goal: use the `CQ::plan/follow-up` bootstrap;
- otherwise create a fresh intake through the target command's bootstrap.

Collect all ambiguous segments into one open question beneath one coordination
milestone. Include each segment verbatim, its plausible routes, and useful
suggestions. Do not intake those segments until answered.

## Intake and advance

Bootstrap all clear segments before advancing:

- plan: create the coordination milestone and clarifying goal;
- goal extension: validate, append scope, link ideas if present, and enter its
  documented follow-up path;
- investigate: create the coordination milestone and open defect;
- research: create the coordination milestone and open research.

Do not run each flow separately. After all intakes, run `CQ::advance` inline
once so its predicates advance the entire batch. The sequencer owns the sole
run-level handoff and all child logs. If no segment was intaked, skip it.

Report a routing table with a short segment label, item reference, flow, and
duplicate/ambiguous disposition. Include the ambiguity question and next
action.

Write a handoff only when the sequencer did not run and an ambiguity question
blocks intake: `answers-required`, `flow: "begin"`, the question reference, and
`blockingQuestions`. Exact-duplicate-only requests need no handoff.
