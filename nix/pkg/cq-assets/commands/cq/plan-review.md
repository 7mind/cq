---
description: Portable adversarial plan-review rubric and structured verdict contract.
argument-hint: <goalId and plan context>
# {{cq:fragment:host-tool-vocabulary}}
---

## Catalogue
```yaml
inputs:
  - "goal, grounding, full answered-question history, current plan DAG, and prior reviews"
outputs:
  - "one fenced structured verdict"
ioSchema:
  - "{summary,verdict:go-ahead|revise,new_questions[],criticism[],defects[]}"
```

Review the plan against the goal, every answered question, and the actual
repository. Judge:

- task granularity and bounded scope;
- correct milestone/task dependency order;
- concrete, observable acceptance criteria;
- grounding in real code and constraints;
- completeness against the goal.

When a task declares an expected failure, require §6a of the implementation
orchestrator. Forms (a) and (b) use the annotation, live marker, and inventory
entry; form (c) needs no marker. The planned fix must replace a marker with a
same-titled plain test and remove the annotation and inventory entry. Reject a
plan that permits triple co-deletion without that plain test or requires a red
full gate.

Classify each finding once:

- `new_questions`: user-only requirements or preferences;
- `criticism`: plan defects the planner can correct;
- `defects`: out-of-scope or pre-existing repository faults, independent of
  the plan verdict.

A discoverable fact is not a user question. A confirmed fault is not a
fix-versus-ignore question.

```json
{
  "summary": "<one-line verdict>",
  "verdict": "go-ahead | revise",
  "new_questions": ["<user-only question>"],
  "criticism": ["<planner-fixable plan defect>"],
  "defects": [
    {
      "headline": "<out-of-scope fault>",
      "severity": "low | medium | high | critical",
      "rootCause": "<optional>",
      "suggestedFix": "<optional>"
    }
  ]
}
```

`go-ahead` requires empty question and criticism buckets. `revise` requires at
least one. Defects never determine the verdict.

When a writer persists `defects` in a review item, validate the complete batch,
construct objects in property order `headline`, `severity`, optional
`rootCause`, optional `suggestedFix`, and compact-serialize each. Consumers
must parse and canonically reconstruct the entire batch before side effects.

Write nothing. End with the fenced JSON object.
