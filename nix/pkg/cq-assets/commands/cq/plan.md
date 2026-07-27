---
description: Start a plan-flow goal — create the goal (from free text OR one-or-more idea-ids, one goal per idea), then hand off to the planner for the first clarifying questions.
argument-hint: <goal description> | <I-id> [<I-id> ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:subagent-dispatch}}


## Catalogue
```yaml
inputs:
  - "EITHER one-or-more whitespace-separated idea-ids (each /^I\\d+$/) OR a free-text goal description ($ARGUMENTS) — not both interleaved"
outputs:
  - "coordination milestone M (create_milestone)"
  - "one-or-more goal items G in clarifying status (one goal PER idea when idea-ids are given; create_item on goals ledger)"
  - "for each idea-seeded goal: bidirectional ledgerRefs link (goal↔idea) + idea status→planned"
  - "first batch of clarifying questions (filed by the chained CQ::plan/advance via the guarded questions pause)"
  - "planner summary log .cq/logs/<timestamp>-<agent-id>.md AND raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl, BOTH written via `cq log put` (by the chained CQ::plan/advance)"
  - "handoffs item (answers-required)"
ioSchema:
  - "bootstrap only — no plan logic; CQ::plan/advance owns the claim + question generation"
  - "goal schema fields: title, description (required); grounding, milestones (set later via the guarded plan mutations)"
  - "idea-id token grammar: /^I\\d+$/; argument is EITHER all idea-ids OR free text (no interleave)"
  - "handoffs item: flow=plan, ledgerRefs=goals:<G>, blockingQuestions=filed question ids"
```

You are starting a **plan-flow goal**. The user's goal is:

> $ARGUMENTS

This command does the one-time **bootstrap** only — create the coordination
milestone and the goal(s) — then hands off to **`CQ::plan/advance`** (chained
inline) for the first clarifying round. It owns NO question or plan logic of
its own: that all lives in `CQ::plan/advance` (which claims the round,
dispatches the `plan-advance` planner, and applies its typed result through the
guarded plan mutations), so the question-generation logic exists in exactly one
place.

The argument is EITHER a **free-text goal description** (today's path) OR
**one-or-more idea-ids** drawn from the `ideas` ledger — see §Argument grammar
below for the token rule and §Consume-an-idea sub-procedure for the idea path.

## Provenance (every ledger write)
On every `create_item` / `create_milestone`, pass:
- `author` = your OWN model class, derived from your runtime identity — never a
  hardcoded literal. An Opus 4.8 (1M) run passes `"opus-4.8[1m]"`; a Codex
  GPT-5.x run passes its own class (e.g. `"gpt-5.5"`). Use the class of the
  model that is actually executing this command.
- `session` = the value of the `$CLAUDE_CODE_SESSION_ID` environment variable
  (Claude), or the Codex session-id equivalent. If unavailable, omit it.

**Mutation response rule:** Every ledger mutation below returns only its fixed
acknowledgement (allocated id, current status, canonicalized reference fields,
timestamps, and provenance), never a full entity. Use acknowledgement ids
directly; issue an explicit full read only when later reasoning needs narrative
fields.

## Defect vs goal — intake the right ledger
Plan-flow goals are for **greenfield work** (build/change something). A
user-reported **DEFECT** — an existing fault to fix — should NOT be intaked as a
goal: file it on the `defects` ledger via **`CQ::investigate <defect
description>`** instead. That flow investigates the fault, confirms a root cause,
and (per the file-and-defer handoff, K8) seeds a *defect-seeded* plan-flow goal —
linked `defects:<D>` with the confirmed root cause embedded — which
`CQ::plan/advance` then turns into reviewed FIX TASKS (tasks remain the only
executable unit; the defect itself stays a problem record). So: fix request →
`CQ::investigate`; new capability → `CQ::plan` (here). If `$ARGUMENTS`
plainly describes a fault to repair, tell the user to use `CQ::investigate`
and stop instead of creating a goal.

## Argument grammar — idea-ids OR free text (Q188, no interleave)
`$ARGUMENTS` is parsed in exactly ONE of two mutually-exclusive modes — there is
NO 'mixed' interleaving:

- **Idea-ids mode.** If the argument is one or more whitespace-separated tokens
  and **every** token matches the idea-id pattern **`/^I\d+$/`** (an `I`
  followed by one-or-more digits, e.g. `I01`, `I2`, `I137`), treat the argument
  as a list of idea-ids. `CQ::plan I01 I02 I03` creates **ONE goal PER idea** —
  iterate the ids in order, running the §Consume-an-idea sub-procedure once per
  id. Each idea yields its own coordination milestone + goal + clarifying round.
- **Free-text mode.** Otherwise (any token does NOT match `/^I\d+$/`), treat the
  WHOLE argument as a single free-text goal description — today's path (steps
  1–8 below, once).

The two modes do not mix: you do not interleave idea-ids with free text in a
single invocation. If the argument is empty, ask the user what to plan and stop.

## Consume-an-idea sub-procedure
Run this ONCE per idea-id when in idea-ids mode. It is the single definition of
"turn an idea into a seeded plan-flow goal"; `CQ::plan/follow-up` references this
same sub-procedure (DRY — do not re-derive it there). For idea-id **I**:

1. **Fetch the idea.**
   `fetch_item({ ledger_id: "ideas", item_id: I, projection: "full" })` from the
   `ideas` ledger. If `I` does not exist (or is not on the `ideas` ledger),
   report it and skip this id (continue with the remaining ids).
2. **Bootstrap a goal seeded from the idea.** Create the coordination milestone
   (step 1 of §Steps) and the goal (step 2), but **seed the goal's `title` from
   the idea's title** and its `description` **VERBATIM from the idea's
   description** (copy the idea description text unchanged as the goal's starting
   description). The normal clarifying bootstrap then proceeds from this seed
   (steps 3–8 below run for this goal). Capture the new goal id as **G**.
3. **Link bidirectionally.** Add `ideas:<I>` to the new goal's `ledgerRefs`
   (`update_item("goals", G, fields: { ledgerRefs: [..existing.., "ideas:<I>"] })`)
   AND add `goals:<G>` to the idea's `ledgerRefs`
   (`update_item("ideas", I, fields: { ledgerRefs: [..existing.., "goals:<G>"] })`).
   Preserve any pre-existing refs on both sides.
4. **Mark the idea planned.** `update_item("ideas", I, status: "planned")` — the
   idea has now been turned into a plan-flow goal (the `ideas` lifecycle's
   terminal `planned` status).

## Before you start
Search the ledger so you don't duplicate an existing goal:
`fts_search({ query: "<goal key terms>", ledger: "goals", projection:
"compact", limit: 20 })`. If a live goal already covers this, report its id and
stop instead of creating a new one. In idea-ids mode, run this de-dup check per
idea before consuming it.

## Steps
In **free-text mode** these steps run once over `$ARGUMENTS`. In **idea-ids
mode** they run once PER idea-id — driven by the §Consume-an-idea sub-procedure,
which supplies the seeded title/description (step 2), performs the bidirectional
link, and flips the idea to `planned` — so one goal is bootstrapped per idea.

1. **Create the coordination milestone.** `create_milestone(title: "Plan: <short
   goal>")` — keep the title to a short slug of the goal. Capture the fixed
   acknowledgement's allocated id as **M**. M groups the goal, its questions,
   its reviews, and the final
   approval decision. (The plan's WORK tasks live under separate work milestones
   that the planner creates during the `planning` phase and records on the goal's
   `fields.milestones` — not under M.)

2. **Create the goal.** `create_item(ledger_id: "goals", milestone_id: M, status:
   "clarifying", fields: { title: "<short goal>", description: "<the full goal
   text, verbatim or lightly cleaned>" })`. Capture the fixed acknowledgement's
   allocated id as **G**. (The `goals` schema requires both `title` and
   `description`.)

3. **Hand off to the planner — chain `CQ::plan/advance` inline.** Run
   **`CQ::plan/advance G` INLINE** in this same main session, exactly per
   `commands/cq/plan/advance.md` — do NOT duplicate or re-implement that logic;
   run it (legal under **K12**: only this orchestrator does the chaining). With
   G freshly created in `clarifying` and no questions yet, the chained command
   CLAIMS the round (`claim_plan`, purpose `initial`) BEFORE any planner
   dispatch, dispatches the `plan-advance` planner, and applies its RETURNED
   `questions` **PlanStepResult** through the guarded `release_plan_claim`
   questions pause (the no-write PlanStepResult contract: the `plan-advance`
   subagent RETURNS its typed result and writes NOTHING — every managed write
   is the chained command's, made through the guarded plan mutations). The
   pause files the FIRST batch of clarifying questions and returns the goal to
   `clarifying`, so the chained run stops at `awaiting-answers`. One chained
   run is enough here — there is nothing to review yet. The chained command
   SUPPRESSES its own handoff (step 7 writes the ONE record) and writes +
   attaches BOTH planner session logs itself (its §Session logs) — you do NOT
   redo that here.

4. **Confirm the questions.** After the chained run stops, read the goal's
   open linked questions (`list_milestone_items({ milestone_id: M, projection:
   "compact" })`, `questions` items with a `goals:<G>` ledgerRef in `open`
   status) so step 6 can name them. (No writes in this step.)

5. **Auto-investigate filed defects (conditional — K12).** Already covered:
   the chained `CQ::plan/advance` runs its own auto-investigate phase after the
   per-goal round (see that command's §Auto-investigate filed defects — the
   authoritative goal-linked defect worklist lives THERE, exactly once). Do NOT
   re-derive or re-run that phase here (its once-per-round predicate (a)
   bounds it).

6. **Report.** Tell the user:
   - the goal id **G** and milestone **M** (in idea-ids mode: one G+M line PER
     idea, each annotated with the source idea-id `I` it was seeded from and that
     `I` was flipped to `planned`);
   - the questions the chained planning round filed (named from step 4);
   - that they should answer the questions in the TUI or web client (set each to
     `answered` with a non-empty `answer`), then run **`CQ::plan/advance G`** to
     continue;
   - for each defect D the chained command's auto-investigate phase handled
     (usually none on a fresh bootstrap): one line covering its outcome
     (confirmed→seeded goal, parked on a question, or stopped by a K12
     predicate) — same format as `CQ::plan/advance`'s §Report auto-investigate
     lines.

7. **Handoff record.** This command is the outermost wrapper for this
   invocation (the user ran `CQ::plan`), so **this command** writes the ONE
   `handoffs` record at this step. Use the field schema from `CQ::plan/advance`'s
   §Handoff record, STANDALONE branch — the goal is left in
   `clarifying`/`awaiting-answers` with the first questions filed, so the stop
   classification is `answers-required` (`flow` = `plan`; `ledgerRefs`
   `goals:<G>`; `blockingQuestions` the filed question ids; `sessionLogs` +
   `rawLogs` the planner summary + raw paths the chained command wrote). Do not
   restate the field mapping
   here. The chained command's
   auto-investigate sub-round writes NO handoff of its own — `CQ::investigate/advance`
   suppresses its handoff when chained (per its CHAINED section), and the
   chained `CQ::plan/advance` suppresses its own handoff under this
   `/<flow>:start` wrapper; this command owns the single authoritative write.

8. **Ledger persistence.** Persistence is the store's job — no git action here;
   when the optional `[ledger].backup` mode (in-tree / orphan-branch) is
   enabled, the debounced exporter mirrors the ledger + logs to git.

Do not file questions, transition the goal, claim the round, or emit any plan
yourself — `CQ::plan/advance` (chained above) owns everything after the goal is
created.
