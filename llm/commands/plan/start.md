---
description: Start a plan-flow goal — create the goal, then hand off to the planner for the first clarifying questions.
argument-hint: <goal description>
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
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

## Defect vs goal — intake the right ledger
Plan-flow goals are for **greenfield work** (build/change something). A
user-reported **DEFECT** — an existing fault to fix — should NOT be intaked as a
goal: file it on the `defects` ledger via **`/investigate:start <defect
description>`** instead. That flow investigates the fault, confirms a root cause,
and (per the file-and-defer handoff, K8) seeds a *defect-seeded* plan-flow goal —
linked `defects:<D>` with the confirmed root cause embedded — which
`/plan:advance` then turns into reviewed FIX TASKS (tasks remain the only
executable unit; the defect itself stays a problem record). So: fix request →
`/investigate:start`; new capability → `/plan:start` (here). If `$ARGUMENTS`
plainly describes a fault to repair, tell the user to use `/investigate:start`
and stop instead of creating a goal.

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

4. **Write the session log.** The `plan-advance` subagent ends its reply with a
   `### Session summary` section. Persist it: take `<agent-id>` from the `Agent`
   tool result, stamp `<timestamp>` via `Bash` (`date -u +%Y%m%d-%H%M%S`),
   `mkdir -p docs/logs`, and `Write` `docs/logs/<timestamp>-<agent-id>.md` with a
   short header (goal id, role: planner, returned status token) followed by the
   verbatim summary block. The subagent writes no file itself — the orchestrator
   does.

5. **Auto-investigate filed defects (conditional — K12).** This mirrors the
   same phase in `plan/advance.md` (see that file's §Auto-investigate filed
   defects for the full logic) — this step is a pointer to it, not a
   re-derivation.

   Derive the worklist by **LEDGER QUERY** — NOT from the planner's prose:
   > every `open` defect whose `ledgerRefs` link the just-created goal
   > (`goals:<G>`) and that has no terminal status (`resolved`/`wontfix`).

   (`fts_search`/`search_items` on the `defects` ledger filtered to
   `status:open` with a `goals:<G>` ledgerRef.)

   **If the worklist is empty (the typical case on a fresh bootstrap) — skip
   this step entirely.** A freshly bootstrapped goal usually reaches
   `clarifying` with open questions and no filed defects; the
   defect-seeded-goal path (investigate→plan) is the main case.

   For each defect **D** in the worklist, run **`/investigate:advance D`
   inline** in this same main session, exactly per
   llm/commands/investigate/advance.md — do NOT duplicate or re-implement
   that logic; run it. Inherit the stop predicates from plan/advance.md's
   auto-investigate phase (predicates a–f, per K12). A command chaining
   another command's loop is legal under **K12**; the
   subagents-cannot-spawn-subagents rule is preserved because only this
   orchestrator (a command) does the chaining.

6. **Report.** Tell the user:
   - the goal id **G** and milestone **M**;
   - the questions the planner filed (from its returned summary);
   - that they should answer the questions in the TUI or web client (set each to
     `answered` with a non-empty `answer`), then run **`/plan:advance G`** to
     continue;
   - if step 5 ran: for each defect D in the worklist, one line covering its
     auto-investigate outcome (confirmed→seeded goal, parked on a question, or
     stopped by a K12 predicate) — same format as plan/advance.md's §Report
     auto-investigate lines.

Do not file questions, transition the goal, or emit any plan yourself — the
`plan-advance` planner and `/plan:advance` own everything after the goal is
created.
