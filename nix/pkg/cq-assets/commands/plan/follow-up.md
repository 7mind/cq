---
description: Add new scope to an EXISTING plan-flow goal — append the follow-up request, re-open the goal, and hand to the planner for a fresh clarifying round.
argument-hint: <goalId> <follow-up request>
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

You are adding a **follow-up** to an existing plan-flow goal. The first
whitespace-delimited token of the arguments is the goal id; the REST is the
follow-up request (free text):

> $ARGUMENTS

Use this when a goal's plan is already done (`planned`) — or its build is under
way (`building`) — and the user wants to add MORE scope to the SAME goal. Like
`/cq:plan`, this command does the one-time **bootstrap** only — record the
request and re-open the goal — then hands off to the `plan-advance` planner for a
fresh clarifying round (clarify-first). It owns NO question or plan logic itself.

> **Follow-up scope vs a defect.** Use this for MORE greenfield scope on an
> existing goal. If the follow-up is really a **DEFECT report** — an existing
> fault to fix, not new capability — intake it on the `defects` ledger via
> **`/cq:investigate <defect description>`** instead of folding it into this
> goal. Investigation confirms the root cause and seeds a *defect-seeded*
> plan-flow goal (linked `defects:<D>`) that `/plan:advance` turns into reviewed
> FIX TASKS — tasks remain the only executable unit; the defect stays a problem
> record. If the request plainly describes a fault to repair, point the user at
> `/cq:investigate` rather than re-opening this goal.

## Provenance (every ledger write)
On every `update_item`, pass `author` = your OWN model class (derived from
runtime identity, never hardcoded — Claude Opus 4.8 (1M) → `"opus-4.8[1m]"`;
Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` = `$CLAUDE_CODE_SESSION_ID` (or
the Codex equivalent; omit if unavailable).

## Steps

1. **Parse + validate.** Split off the goal id **G** (first token); the
   remainder is the follow-up **request**. If the request is empty, stop and ask
   the user what to add. `fetch_item("goals", G)` — if G does not exist, report
   and stop.

2. **Phase gate.** Read `G`'s status (phase):
   - **`done` / `abandoned`** (terminal): a finished goal canNOT be re-opened —
     the goals state machine keeps terminal statuses outgoing-edge-free by
     design. STOP and tell the user to start a fresh goal for the new scope with
     `/cq:plan` (it can reference G in its description). Do not mutate G.
   - **`clarifying`**: already taking input — skip the re-open in step 4, just
     append (step 3) and hand off (step 5).
   - **`planning` / `planned` / `building`**: proceed.

3. **Record the request on the goal.** Append it to the goal's `description`,
   preserving the existing text and history — add a section like:
   `\n\n## Follow-up (<short date or ordinal>)\n<the request verbatim>`.
   `update_item("goals", G, fields: { description: "<existing + appended>" })`.
   (Keep prior follow-up sections; never overwrite the original goal text.)

4. **Re-open the goal to `clarifying`** (clarify-first). Apply the FIRST matching
   path — the goals guard allows each hop:
   - `planned`  → `update_item("goals", G, status: "planning")`, then
     `update_item("goals", G, status: "clarifying")`.
   - `building` → `update_item("goals", G, status: "planning")`, then
     `update_item("goals", G, status: "clarifying")`.
   - `planning` → `update_item("goals", G, status: "clarifying")`.
   - `clarifying` → already there; do nothing here.
   (Re-open edges `planned→planning` and `building→planning` exist specifically
   for this command; `planning→clarifying` is the standard loop-back.)

5. **Hand off to the planner.** Spawn the `plan-advance` subagent — `Agent` tool,
   `subagent_type: "plan-advance"`, passing the goal id **G** in the prompt. With
   G now in `clarifying` and the new scope folded into its description, the
   planner files the next batch of clarifying questions (scoped to the follow-up)
   and returns `awaiting-answers`. Drive it exactly once here — there is nothing
   to review yet.

6. **Write the session log and attach it to the goal.** The `plan-advance`
   subagent ends its reply with a `### Session summary` section. Persist it:
   take `<agent-id>` from the `Agent` tool result, stamp `<timestamp>` via
   `Bash` (`date -u +%Y%m%d-%H%M%S`), `mkdir -p docs/logs`, and `Write`
   `docs/logs/<timestamp>-<agent-id>.md` with a short header (goal id, role:
   planner, returned status token) followed by the verbatim summary block.
   **Immediately after writing the log**, call `update_item("goals", G, fields:
   { sessionLogs: ["docs/logs/<timestamp>-<agent-id>.md"] })` to attach the log
   path to the goal item — do NOT defer this to a separate pass.

7. **Auto-investigate filed defects (conditional — K12).** This mirrors the
   same phase in `plan/advance.md` (see that file's §Auto-investigate filed
   defects for the full logic) — this step is a pointer to it, not a
   re-derivation.

   Derive the worklist by **LEDGER QUERY** — NOT from the planner's prose:
   > every `open` defect whose `ledgerRefs` link the just-advanced goal
   > (`goals:<G>`) and that has no terminal status (`resolved`/`wontfix`).

   (`fts_search`/`search_items` on the `defects` ledger filtered to
   `status:open` with a `goals:<G>` ledgerRef.)

   **If the worklist is empty (the typical case on a fresh follow-up bootstrap)
   — skip this step entirely.** A freshly re-opened goal usually reaches
   `clarifying` with new questions and no filed defects on this round; the
   defect-seeded-goal path (investigate→plan) is the main case.

   For each defect **D** in the worklist, run **`/investigate:advance D`
   inline** in this same main session, exactly per
   llm/commands/investigate/advance.md — do NOT duplicate or re-implement
   that logic; run it. Inherit the stop predicates from plan/advance.md's
   auto-investigate phase (predicates a–f, per K12). A command chaining
   another command's loop is legal under **K12**; the
   subagents-cannot-spawn-subagents rule is preserved because only this
   orchestrator (a command) does the chaining.

8. **Report.** Tell the user: the goal id **G** and its new phase (`clarifying`);
   the questions the planner filed; and that they should answer them in the
   TUI/web, then run **`/plan:advance G`** to plan the added scope;
   if step 7 ran: for each defect D in the worklist, one line covering its
   auto-investigate outcome (confirmed→seeded goal, parked on a question, or
   stopped by a K12 predicate) — same format as plan/advance.md's §Report
   auto-investigate lines.

9. **Handoff record.** This command is the outermost wrapper for this
   invocation (the user ran `/plan:follow-up`), so **this command** writes the
   ONE `handoffs` record at this step. Use the field schema from
   plan/advance.md's §Handoff record, STANDALONE branch — the re-opened goal
   lands in `clarifying` with new questions filed, so the stop classification is
   `answers-required` (`flow` = `plan`; `ledgerRefs` `goals:<G>`;
   `blockingQuestions` the filed question ids; `sessionLogs` the round's log
   path). Do not restate the field mapping here. The conditional step-7
   auto-investigate sub-round writes NO handoff of its own — investigate/advance.md
   suppresses its handoff when chained by this command (per its CHAINED section:
   `/<flow>:follow-up` is listed as a suppress-context; this command owns the
   single authoritative write).

10. **Commit the ledger.** This command is the outermost wrapper, so it owns the
    single run-stop ledger commit. Immediately after the handoff write, persist
    ONLY the ledger (`docs/*.md` + `docs/archive` + `docs/logs`; NEVER
    `docs/ledgers.yaml`, gitignored; NEVER code):
    ```
    git add docs/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
    git diff --cached --quiet -- docs/ || git commit -q -m "chore(ledger): /plan:follow-up — goal G<n> re-opened (awaiting-answers)

    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
    ```
    The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed.

Do not file questions, emit a plan, or lock decisions yourself — the
`plan-advance` planner and `/plan:advance` own everything after the re-open.
