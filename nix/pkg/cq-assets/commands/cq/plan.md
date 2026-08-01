---
description: Create plan-flow goals from free text or idea ids, then run their first guarded planning round.
argument-hint: <goal description> | <ideaId> [<ideaId> ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:subagent-dispatch}}
{{cq:fragment:ledger-response-contract}}

## Catalogue
```yaml
inputs:
  - "free-text goal description, or one or more idea ids without interleaving"
outputs:
  - "one coordination milestone and clarifying goal per intake"
  - "bidirectional idea/goal links and planned idea status when idea-seeded"
  - "first guarded planning round and one outer handoff"
ioSchema:
  - "bootstrap only; plan advance owns questions, claims, drafts, reviews, and finalization"
```

Create goals for new capabilities. A report that existing behavior fails belongs
to investigation instead; do not turn a fault report directly into a goal.

## Parse and deduplicate

An empty argument requires user input. An idea id is `I` followed by decimal
digits. If every whitespace-delimited token matches that grammar, process each
idea independently. Otherwise treat the entire argument as one free-text
description; do not interleave ids and prose.

For each prospective goal, search active goals by key terms. If one already
covers the scope, report it and skip creation.

## Bootstrap

For free text:

1. Create a coordination milestone titled `Plan: <short goal>`.
2. Create a `clarifying` goal beneath it with a short title and the complete
   description.

For each idea id:

1. Fetch the full idea; report and skip missing ids.
2. Create the milestone and goal using the idea title and verbatim description.
3. Merge `ideas:<ideaId>` into the goal's `fields.sourceRefs` and
   `goals:<goalId>` into the idea's `fields.ledgerRefs`, preserving all entries
   already stored in both arrays.
4. Set the idea to `planned`.

The coordination milestone contains the goal, clarification questions, reviews,
and approval decision. Draft publication creates separate work milestones.

## First planning round

Run `CQ::plan/advance <goalId>` inline for every new goal. That command owns the
claim, planner dispatch, guarded mutation, defect investigation, and child
logs. Suppress its handoff because this wrapper writes the single outer record.
Its defect phase may run `CQ::investigate/advance` inline.

After the round, read the goal-linked open questions and report the milestone,
goal, source idea when applicable, current phase, questions to answer, and any
defect investigation outcome. Tell the user to answer questions in a client and
run plan advance again.

Write one append-only plan handoff using the plan-advance mapping. A normal
first round stops as `answers-required`, linked to the goal with
`blockingQuestions` and the child log paths. If several goals produce different
stop causes, use the corresponding aggregate status.

Do not generate questions, mutate managed plan state, publish a draft, or lock
a decision in this command.
