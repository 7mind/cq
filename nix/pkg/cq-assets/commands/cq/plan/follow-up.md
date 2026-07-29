---
description: Append scope to an existing non-terminal goal and route it into follow-up planning.
argument-hint: <goalId> <follow-up request> | <goalId> <ideaId> [<ideaId> ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:subagent-dispatch}}

## Catalogue
```yaml
inputs:
  - "target goal id followed by free text or one or more idea ids"
outputs:
  - "appended scope, optional idea links, follow-up planning round, and one outer handoff"
ioSchema:
  - "terminal goals reject without mutation"
  - "managed goals use the guarded follow-up claim; unmanaged goals use the legacy reopen transitions"
```

Use this for added capability scope on an existing `clarifying`, `planning`,
`planned`, or `building` goal. Existing faults belong to investigation.

## Parse and gate

The first token is the goal id. An idea id is `I` followed by decimal digits.
If every remaining token matches that grammar, use idea mode; otherwise treat
the entire remainder as free text. Reject an empty remainder. Fetch the full
goal. Missing, `done`, or `abandoned` goals stop without mutation; terminal
goals require a new goal.

In idea mode, fetch each idea, skip missing ids, and use its title and
description as one follow-up section. In free-text mode, use the request
verbatim.

## Append and link

Append each scope to the existing description without replacing history:

```markdown
## Follow-up (<date or ordinal>)
<scope>
```

For each idea, preserve refs while adding `ideas:<ideaId>` to the goal and
`goals:<goalId>` to the idea, then set the idea `planned`.

## Enter planning

After appending, inspect `planGeneration`.

- A protocol-managed goal enters replanning through
  `claim_plan(purpose: "follow-up")`; do not use raw status transitions. Stop
  this bootstrap and report the guarded follow-up requirement.
- For an unmanaged goal, move `planned` or `building` through `planning` to
  `clarifying`; move `planning` to `clarifying`; leave `clarifying` unchanged.

For an unmanaged goal now in `clarifying`, run
`CQ::plan/advance <goalId>` inline. It owns questions, guarded mutations,
defect investigation, and child logs. Suppress its handoff.
Its defect phase may run `CQ::investigate/advance` inline.

Report appended scope, current phase, open question ids, the next plan-advance
action, and any investigation outcome. Write one outer plan handoff using the
plan-advance mapping and child log paths. Do not generate questions, publish a
draft, or lock a decision here.
