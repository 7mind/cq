---
description: Advance plan-flow goals one full round — a given goal, or (no argument) every unlocked goal — running the planner↔reviewer loop until each needs the user or reaches `planned`.
argument-hint: [goalId]
allowed-tools: mcp__ledger__fetch_ledger, mcp__ledger__fetch_item, mcp__ledger__fts_search, mcp__ledger__list_milestone_items, mcp__ledger__enumerate_ledgers, Agent, Write, Bash
---

You are the **thin orchestrator** for the plan-flow advance loop. The argument
(may be empty) is:

> $ARGUMENTS

Subagents cannot spawn other subagents, so the planner↔reviewer LOOP lives here
in the main session. You do NOT mutate the ledger yourself — the `plan-advance`
subagent makes every state change, the `plan-reviewer` subagent writes every
review. Your only job is to drive the loop and relay the outcome.

## Select the target goal(s)

- **`$ARGUMENTS` is a goal id** → the target set is just that one goal.
- **`$ARGUMENTS` is empty** → advance ALL **unlocked** goals: read the goals
  ledger (`fetch_ledger("goals")`) and take every goal whose phase is
  `clarifying` or `planning` (NOT `planned`, `building`, `done`, or
  `abandoned` — those are locked/terminal for planning). If none qualify, report
  "no unlocked goals" and stop.

Run **the per-goal round below independently for EACH** target goal **G** (the
4-iteration cap is per goal). Treat goals independently: one that stops at
`awaiting-answers` is recorded and the next goal still runs. Then give the
per-goal report.

## The per-goal round (for one goal G)

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

## Session logs (after EVERY subagent returns)

Each subagent (planner and reviewer) ends its reply with a `### Session summary`
section. After each `Agent` call returns, persist that summary so the run leaves
a durable trace (the subagents are read-only and write nothing themselves):

1. Take `<agent-id>` from the `Agent` tool result (the returned agent id).
2. Stamp `<timestamp>` yourself: `date -u +%Y%m%d-%H%M%S` via `Bash`.
3. `Bash`: `mkdir -p docs/logs` (the dir is tracked via `.gitkeep`).
4. `Write` `docs/logs/<timestamp>-<agent-id>.md` containing a short header
   (which goal, which subagent/role, the returned status token or verdict) and
   the verbatim `### Session summary` block the subagent emitted.

Do this for the planner AND the reviewer on every iteration — one log file per
spawned subagent.

## Report to the user

After running the round on every target goal, read each goal
(`fetch_item("goals", <G>)`) for its current phase and give a **per-goal**
summary line (when run with no argument, one line for each goal advanced):
- the goal's id + current phase (`clarifying` / `planning` / `planned` / …);
- what the user must do next:
  - `awaiting-answers` → "answer the N open questions for goal G in the TUI/web,
    then run `/plan:advance G` again" (list the question ids);
  - `completed` → "plan approved and locked; goal G is now `planned`" (point to
    the milestones/tasks and the locked decision);
  - `noop` → why there was nothing to do.

When no argument was given, finish with a one-line roll-up (e.g. "3 goals
advanced: 1 planned, 2 awaiting answers").
