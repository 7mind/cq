---
description: Start a plan-flow goal — create the goal, then hand off to the planner for the first clarifying questions.
argument-hint: <goal description>
allowed-tools: mcp__ledger__*, Agent
---

You are starting a **plan-flow goal**. The user's goal is:

> $ARGUMENTS

This command does the one-time **bootstrap** only — create the coordination
milestone and the goal — then hands off to the `plan-advance` planner for the
first clarifying questions. It owns NO question or plan logic of its own: that
all lives in the `plan-advance` subagent (the same planner `/plan:advance`
drives), so the question-generation logic exists in exactly one place.

## Provenance (every ledger write)
On every `create_item` / `create_milestone`, pass:
- `author` = your OWN model class, derived from your runtime identity — never a
  hardcoded literal. An Opus 4.8 (1M) run passes `"opus-4.8[1m]"`; a Codex
  GPT-5.x run passes its own class (e.g. `"gpt-5.5"`). Use the class of the
  model that is actually executing this command.
- `session` = the value of the `$CLAUDE_CODE_SESSION_ID` environment variable
  (Claude), or the Codex session-id equivalent. If unavailable, omit it.

## Before you start
Search the ledger so you don't duplicate an existing goal: `fts_search` with
`ledger: "goals"` over the goal's key terms. If a live goal already covers this,
report its id and stop instead of creating a new one.

## Steps

1. **Create the coordination milestone.** `create_milestone(title: "Plan: <short
   goal>")` — keep the title to a short slug of the goal. Capture the returned id
   as **M**. M groups the goal, its questions, its reviews, and the final
   approval decision. (The plan's WORK tasks live under separate work milestones
   that the planner creates during the `planning` phase and records on the goal's
   `fields.milestones` — not under M.)

2. **Create the goal.** `create_item(ledger_id: "goals", milestone_id: M, status:
   "clarifying", fields: { title: "<short goal>", description: "<the full goal
   text, verbatim or lightly cleaned>" })`. Capture the returned id as **G**.
   (The `goals` schema requires both `title` and `description`.)

3. **Hand off to the planner.** Spawn the `plan-advance` subagent — `Agent` tool,
   `subagent_type: "plan-advance"`, passing the goal id **G** in the prompt. On a
   fresh goal (in `clarifying` with no questions yet) it files the FIRST batch of
   clarifying questions and returns `awaiting-answers`. You drive it exactly once
   here — there is nothing to review yet, so no loop is needed.

4. **Report.** Tell the user:
   - the goal id **G** and milestone **M**;
   - the questions the planner filed (from its returned summary);
   - that they should answer the questions in the TUI or web client (set each to
     `answered` with a non-empty `answer`), then run **`/plan:advance G`** to
     continue.

Do not file questions, transition the goal, or emit any plan yourself — the
`plan-advance` planner and `/plan:advance` own everything after the goal is
created.
