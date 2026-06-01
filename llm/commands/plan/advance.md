---
description: Advance a plan-flow goal one full round — runs the planner↔reviewer loop until the goal needs the user or reaches `planned`.
argument-hint: <goalId>
allowed-tools: mcp__ledger__fetch_ledger, mcp__ledger__fetch_item, mcp__ledger__fts_search, mcp__ledger__list_milestone_items, mcp__ledger__enumerate_ledgers, Agent
---

You are the **thin orchestrator** for the plan-flow advance loop. The goal id is:

> $ARGUMENTS

Subagents cannot spawn other subagents, so the planner↔reviewer LOOP lives here
in the main session. You do NOT mutate the ledger yourself — the `plan-advance`
subagent makes every state change, the `plan-reviewer` subagent writes every
review. Your only job is to drive the loop and relay the outcome.

## The loop

Repeat at most **4 iterations** (a hard cap to prevent a runaway loop):

1. **Spawn the planner.** Use the `Agent` tool with
   `subagent_type: "plan-advance"`, passing the goal id (`$ARGUMENTS`) in the
   prompt. It performs EXACTLY ONE state-driven step against the goal and
   returns a single status token:
   - `awaiting-answers` — it filed (or left) `open` questions; the user must
     answer them. **Stop the loop.**
   - `review-requested` — it emitted or revised a plan. **Run the reviewer**
     (step 2), then continue the loop.
   - `completed` — the goal reached `planned` (or a terminal phase). **Stop.**
   - `noop` — nothing to do in the current state. **Stop.**

2. **Spawn the reviewer** (only on `review-requested`). Use the `Agent` tool
   with `subagent_type: "plan-reviewer"`, passing the goal id. It adversarially
   judges the emitted plan and WRITES a verdict item into the `reviews` ledger
   (`go-ahead` or `revise`). It returns a one-line pointer to the review id.
   Then **continue the loop** — the next `plan-advance` call reads that latest
   review and acts on it (revise the plan, ask new questions, or lock the
   decision and reach `planned`).

3. If the planner returned anything other than `review-requested`, **break**.

If you hit the 4-iteration cap without a terminal token, stop and report that
the loop did not converge (so the user can re-run `/plan:advance` or inspect the
goal manually).

## Report to the user

After the loop, read the goal (`fetch_item("goals", <G>)`) for its current
phase and relay, concisely:
- the goal's current phase (`clarifying` / `planning` / `planned` / …);
- what the user must do next:
  - `awaiting-answers` → "answer the N open questions for goal G in the TUI/web,
    then run `/plan:advance G` again" (list the question ids);
  - `completed` → "plan approved and locked; goal G is now `planned`" (point to
    the milestones/tasks and the locked decision);
  - `noop` → why there was nothing to do.
