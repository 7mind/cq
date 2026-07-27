---
description: Add new scope to an EXISTING plan-flow goal — append the follow-up request, re-open the goal, and hand to the planner for a fresh clarifying round.
argument-hint: <goalId> <follow-up request> | <goalId> <I-id> [<I-id> ...]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:inline-command-recursion}}
{{cq:fragment:subagent-dispatch}}


## Catalogue
```yaml
inputs:
  - "goal id G (first whitespace-delimited token of $ARGUMENTS)"
  - "follow-up scope: EITHER one-or-more idea-ids (each /^I\\d+$/) OR free-text request (remainder of $ARGUMENTS after the goal id)"
outputs:
  - "goal description updated (follow-up appended; for each idea, its title+description appended as new scope)"
  - "for each idea-seeded follow-up: bidirectional ledgerRefs link (goal↔idea) + idea status→planned"
  - "goal re-opened to clarifying status (legacy goals only — a protocol-managed goal's follow-up is the guarded follow-up claim, T855/T856)"
  - "new clarifying questions filed (by the chained CQ::plan/advance via the guarded questions pause)"
  - "planner summary log .cq/logs/<timestamp>-<agent-id>.md AND raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl, BOTH written via `cq log put` (by the chained CQ::plan/advance)"
  - "handoffs item (answers-required)"
ioSchema:
  - "bootstrap only — appends scope and re-opens; plan-advance subagent owns question generation"
  - "argument grammar: first token = target goal id; remaining tokens are EITHER all idea-ids (/^I\\d+$/) OR free text (no interleave)"
  - "idea-ids path: reuses plan.md's §Consume-an-idea sub-procedure for the link + idea→planned transition (DRY)"
  - "phase gate: done/abandoned goals cannot be re-opened (user must start a fresh goal)"
  - "handoffs item: flow=plan, ledgerRefs=goals:<G>, blockingQuestions=filed question ids"
```

You are adding a **follow-up** to an existing plan-flow goal. The first
whitespace-delimited token of the arguments is the **target goal id**; the REST
is the follow-up scope — EITHER a free-text request OR one-or-more idea-ids (see
**§Argument grammar** below):

> $ARGUMENTS

Use this when a goal's plan is already done (`planned`) — or its build is under
way (`building`) — and the user wants to add MORE scope to the SAME goal. Like
`CQ::plan`, this command does the one-time **bootstrap** only — record the
request and re-open the goal — then hands off to **`CQ::plan/advance`**
(chained inline) for a fresh clarifying round (clarify-first). It owns NO
question or plan logic itself.

## Argument grammar — `<goalId>` then idea-ids OR free text (no interleave)
`$ARGUMENTS` is the target goal id **G** (the FIRST whitespace-delimited token)
followed by the follow-up scope. The scope is parsed in exactly ONE of two
mutually-exclusive modes — there is NO 'mixed' interleaving (mirrors `plan.md`'s
§Argument grammar, applied to the tokens AFTER the goal id):

- **Idea-ids mode.** If every remaining token matches the idea-id pattern
  **`/^I\d+$/`** (an `I` followed by one-or-more digits, e.g. `I01`, `I2`,
  `I137`), treat them as a list of idea-ids. `CQ::plan/follow-up G35 I01 I02`
  appends EACH idea as new scope onto the SAME existing goal G35 — iterate the
  ids in order, running the §Consume-an-idea-into-this-goal steps below once per
  id. (Unlike `CQ::plan`, which creates one NEW goal per idea, here every idea
  folds into the one pre-existing target goal G.)
- **Free-text mode.** Otherwise (any remaining token does NOT match `/^I\d+$/`),
  treat the WHOLE remainder as a single free-text follow-up request — the
  existing path (step 3 records it verbatim).

The two modes do not mix: you do not interleave idea-ids with free text after the
goal id. If the remainder is empty, stop and ask the user what to add.

### Consume-an-idea-into-this-goal (idea-ids mode)
Run this ONCE per idea-id, for the SAME target goal **G**. For each idea-id **I**:

1. **Fetch the idea.**
   `fetch_item({ ledger_id: "ideas", item_id: I, projection: "full" })` from the
   `ideas` ledger. If `I` does not exist (or is not on the `ideas` ledger),
   report it and skip this id (continue with the remaining ids).
2. **Append the idea as new scope onto G.** Append the idea's **title +
   description** to G's `description` as a new follow-up scope section, using the
   SAME re-open path this command already documents for adding scope to a
   `planned`/`building` goal — i.e. step 3 (append the section) + step 4 (re-open
   to `clarifying`). This is the pre-existing follow-up re-open behaviour; no new
   re-open semantics are introduced.
3. **Link + transition via the shared sub-procedure.** For the goal↔idea
   `ledgerRefs` link and the idea→`planned` flip, reuse the
   **§Consume-an-idea sub-procedure defined in `CQ::plan` (`plan.md`)** — add
   `goals:<G>` to the idea's `ledgerRefs` AND `ideas:<I>` to the goal's
   `ledgerRefs` (bidirectional, preserving pre-existing refs), then
   `update_item("ideas", I, status: "planned")`. Do NOT re-derive that
   link-and-transition sub-procedure here (DRY); its canonical definition lives
   in exactly one place (`plan.md`'s §Consume-an-idea sub-procedure). The only
   difference from `plan.md` is the target: there a freshly-created goal, here
   the pre-existing goal G — the link + idea→`planned` steps are identical.

> **Follow-up scope vs a defect.** Use this for MORE greenfield scope on an
> existing goal. If the follow-up is really a **DEFECT report** — an existing
> fault to fix, not new capability — intake it on the `defects` ledger via
> **`CQ::investigate <defect description>`** instead of folding it into this
> goal. Investigation confirms the root cause and seeds a *defect-seeded*
> plan-flow goal (linked `defects:<D>`) that `CQ::plan/advance` turns into reviewed
> FIX TASKS — tasks remain the only executable unit; the defect stays a problem
> record. If the request plainly describes a fault to repair, point the user at
> `CQ::investigate` rather than re-opening this goal.

## Provenance (every ledger write)
On every `update_item`, pass `author` = your OWN model class (derived from
runtime identity, never hardcoded — Claude Opus 4.8 (1M) → `"opus-4.8[1m]"`;
Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` = `$CLAUDE_CODE_SESSION_ID` (or
the Codex equivalent; omit if unavailable).

**Mutation response rule:** Every ledger mutation below returns only its fixed
acknowledgement (allocated id, current status, canonicalized reference fields,
timestamps, and provenance), never a full entity. Use acknowledgement ids
directly; issue an explicit full read only when later reasoning needs narrative
fields.

## Steps

1. **Parse + validate.** Split off the goal id **G** (first token); classify the
   remainder per §Argument grammar — **idea-ids mode** (every remaining token
   matches `/^I\d+$/`) or **free-text mode** (otherwise). If the remainder is
   empty, stop and ask the user what to add.
   `fetch_item({ ledger_id: "goals", item_id: G, projection: "full" })` — if G
   does not exist, report and stop. In idea-ids mode, the per-idea append + link
   + transition runs via §Consume-an-idea-into-this-goal (which drives steps 3–4
   per idea); in free-text mode, step 3 records the request verbatim.

2. **Phase gate.** Read `G`'s status (phase):
   - **`done` / `abandoned`** (terminal): a finished goal canNOT be re-opened —
     the goals state machine keeps terminal statuses outgoing-edge-free by
     design. STOP and tell the user to start a fresh goal for the new scope with
     `CQ::plan` (it can reference G in its description). Do not mutate G.
   - **`clarifying`**: already taking input — skip the re-open in step 4, just
     append (step 3) and hand off (step 5).
   - **`planning` / `planned` / `building`**: proceed.

3. **Record the scope on the goal.** Append it to the goal's `description`,
   preserving the existing text and history — add a section like:
   `\n\n## Follow-up (<short date or ordinal>)\n<the scope>`.
   `update_item("goals", G, fields: { description: "<existing + appended>" })`.
   (Keep prior follow-up sections; never overwrite the original goal text.)
   - **Free-text mode:** `<the scope>` is the request verbatim.
   - **Idea-ids mode:** `<the scope>` is each idea's **title + description**
     (fetched per §Consume-an-idea-into-this-goal step 1), one appended section
     per idea — and after appending, perform that sub-procedure's step 3 (the
     bidirectional `ledgerRefs` link + idea→`planned` flip, reusing `plan.md`'s
     §Consume-an-idea sub-procedure).

4. **Re-open the goal to `clarifying`** (clarify-first). FIRST check whether
   the goal is PROTOCOL-MANAGED: when its `fields.planGeneration` is present
   (the goal has been through the guarded plan protocol), the raw re-open
   transitions below are REJECTED by the store (`managed plan transition may
   mutate only through PlanLifecycleStore`) — a managed goal's follow-up
   re-plan enters through a `claim_plan` `purpose: "follow-up"` claim (the
   reacquisition path T855/T856 wire), NOT through this command's raw edges.
   STOP on a managed goal and report that its follow-up path is the guarded
   follow-up claim, not this re-open. On a LEGACY goal (no `planGeneration`),
   apply the FIRST matching
   path — the goals guard allows each hop:
   - `planned`  → `update_item("goals", G, status: "planning")`, then
     `update_item("goals", G, status: "clarifying")`.
   - `building` → `update_item("goals", G, status: "planning")`, then
     `update_item("goals", G, status: "clarifying")`.
   - `planning` → `update_item("goals", G, status: "clarifying")`.
   - `clarifying` → already there; do nothing here.
   (Re-open edges `planned→planning` and `building→planning` exist specifically
   for this command; `planning→clarifying` is the standard loop-back.)

5. **Hand off to the planner — chain `CQ::plan/advance` inline.** Run
   **`CQ::plan/advance G` INLINE** in this same main session, exactly per
   `commands/cq/plan/advance.md` — do NOT duplicate or re-implement that logic;
   run it (legal under **K12**: only this orchestrator does the chaining). With
   G now in `clarifying` and the new scope folded into its description, the
   chained command claims the round, the planner returns a `questions` result,
   and the guarded pause files the next batch of clarifying questions (scoped
   to the follow-up) and returns the goal to `clarifying` — the chained run
   stops at `awaiting-answers`. One chained run is enough here — there is
   nothing to review yet. The chained command SUPPRESSES its own handoff (step
   9 writes the ONE record) and writes + attaches BOTH planner session logs
   itself — you do NOT redo that here.

6. **Confirm the questions.** After the chained run stops, read the goal's
   open linked questions (`list_milestone_items({ milestone_id: M, projection:
   "compact" })`, `questions` items with a `goals:<G>` ledgerRef in `open`
   status) so step 8 can name them. (No writes in this step.)

7. **Auto-investigate filed defects (conditional — K12).** Already covered:
   the chained `CQ::plan/advance` runs its own auto-investigate phase after the
   per-goal round (see that command's §Auto-investigate filed defects). Do NOT
   re-derive or re-run that phase here (its once-per-round predicate (a)
   bounds it).

8. **Report.** Tell the user: the goal id **G** and its new phase (`clarifying`);
   the questions the chained planning round filed; and that they should answer them in the
   TUI/web, then run **`CQ::plan/advance G`** to plan the added scope;
   for each defect D the chained command's auto-investigate phase handled
   (usually none on a fresh follow-up): one line covering its outcome
   (confirmed→seeded goal, parked on a question, or stopped by a K12
   predicate) — same format as plan/advance.md's §Report auto-investigate lines.

9. **Handoff record.** This command is the outermost wrapper for this
   invocation (the user ran `CQ::plan/follow-up`), so **this command** writes the
   ONE `handoffs` record at this step. Use the field schema from
   plan/advance.md's §Handoff record, STANDALONE branch — the re-opened goal
   lands in `clarifying` with new questions filed, so the stop classification is
   `answers-required` (`flow` = `plan`; `ledgerRefs` `goals:<G>`;
   `blockingQuestions` the filed question ids; `sessionLogs` + `rawLogs` the
   planner summary + raw log paths the chained command wrote). Do not restate the
   field mapping here. The chained command's
   auto-investigate sub-round writes NO handoff of its own — investigate/advance.md
   suppresses its handoff when chained (per its CHAINED section), and the chained
   `CQ::plan/advance` suppresses its own handoff under this `/<flow>:follow-up`
   wrapper; this command owns the single authoritative write.

10. **Ledger persistence.** Persistence is the store's job — no git action
    here; when the optional `[ledger].backup` mode (in-tree / orphan-branch) is
    enabled, the debounced exporter mirrors the ledger + logs to git.

Do not file questions, emit a plan, claim the round, or lock decisions yourself —
`CQ::plan/advance` (chained above) owns everything after the re-open.
