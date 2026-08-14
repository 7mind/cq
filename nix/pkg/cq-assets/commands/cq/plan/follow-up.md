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
verbatim. This preparation is read-only: do not update the goal or any idea
yet.

## Acquire managed authority

Inspect `planGeneration` before appending or linking anything.

For a protocol-managed goal, mint a fresh request id and secret fence token,
then call `claim_plan(purpose: "follow-up")` with the observed plan generation
and write provenance. Never log the token. Any rejected claim result exits
before appending scope or mutating the goal or ideas; report its conflict and
perform no fallback raw transition. This rule covers every rejection,
including a terminal or phase conflict, active claim or implementation,
research wait, stale generation, request reuse, and fence mismatch.

On acknowledgement, keep the claim id, generation, and fence token in memory.
The claim has entered `planning` and superseded the prior unstarted manifest.
Do not issue a raw status transition for this managed goal.

An unmanaged goal has no `planGeneration`; it does not use `claim_plan` and
continues through the legacy path below.

## Append and link

Reach this section only after a managed follow-up claim was acknowledged or
the goal was confirmed unmanaged.

Append each scope to the existing description without replacing history:

```markdown
## Follow-up (<date or ordinal>)
<scope>
```

Create or update each idea without `milestone_id`; the server attaches it to `M-AMBIENT`.
Ideas never attach to work milestones and are not archived with them.
`ledgerRefs` linking remains independent of milestone attachment.

For each idea, merge `ideas:<ideaId>` into the goal's `fields.sourceRefs` and
`goals:<goalId>` into the idea's `fields.ledgerRefs`, preserving all entries
already stored in both arrays; then set the idea `planned`.

## Enter planning

For an unmanaged goal, move `planned` or `building` through `planning` to
`clarifying`; move `planning` to `clarifying`; leave `clarifying` unchanged.

For an unmanaged goal now in `clarifying`, run
`CQ::plan/advance <goalId>` inline. It owns questions, guarded mutations,
defect investigation, and child logs. Suppress its handoff.
Its defect phase may run `CQ::investigate/advance` inline.

For a managed goal with the acknowledged claim, enter `CQ::plan/advance` at
**§2. Resolve planners and dispatch** and transfer the in-memory claim id,
generation, and fence token. Do not run its §1 pre-claim gate or request a
second `purpose: "initial"` claim. The resumed command owns planner/reviewer
dispatch and every guarded publish, pause, abandon, or finalize operation under
the transferred claim. Suppress its handoff; its defect phase may run
`CQ::investigate/advance` inline.

Report appended scope, current phase, open question ids, the next plan-advance
action, and any investigation outcome. Write one outer plan handoff using the
plan-advance mapping and child log paths. Do not generate questions, publish a
draft, or lock a decision here.
