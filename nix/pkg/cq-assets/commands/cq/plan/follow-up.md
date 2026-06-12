---
description: Add new scope to an EXISTING plan-flow goal — append the follow-up request, re-open the goal, and hand to the planner for a fresh clarifying round.
argument-hint: <goalId> <follow-up request> | <goalId> <I-id> [<I-id> ...]
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "goal id G (first whitespace-delimited token of $ARGUMENTS)"
  - "follow-up scope: EITHER one-or-more idea-ids (each /^I\\d+$/) OR free-text request (remainder of $ARGUMENTS after the goal id)"
outputs:
  - "goal description updated (follow-up appended; for each idea, its title+description appended as new scope)"
  - "for each idea-seeded follow-up: bidirectional ledgerRefs link (goal↔idea) + idea status→planned"
  - "goal re-opened to clarifying status"
  - "new clarifying questions filed by plan-advance subagent"
  - "planner summary log .cq/logs/<timestamp>-<agent-id>.md AND raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl, BOTH written via `cq log put`"
  - "handoffs item (answers-required) and ledger git commit"
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
`/cq:plan`, this command does the one-time **bootstrap** only — record the
request and re-open the goal — then hands off to the `plan-advance` planner for a
fresh clarifying round (clarify-first). It owns NO question or plan logic itself.

## Argument grammar — `<goalId>` then idea-ids OR free text (no interleave)
`$ARGUMENTS` is the target goal id **G** (the FIRST whitespace-delimited token)
followed by the follow-up scope. The scope is parsed in exactly ONE of two
mutually-exclusive modes — there is NO 'mixed' interleaving (mirrors `plan.md`'s
§Argument grammar, applied to the tokens AFTER the goal id):

- **Idea-ids mode.** If every remaining token matches the idea-id pattern
  **`/^I\d+$/`** (an `I` followed by one-or-more digits, e.g. `I01`, `I2`,
  `I137`), treat them as a list of idea-ids. `/cq:plan:follow-up G35 I01 I02`
  appends EACH idea as new scope onto the SAME existing goal G35 — iterate the
  ids in order, running the §Consume-an-idea-into-this-goal steps below once per
  id. (Unlike `/cq:plan`, which creates one NEW goal per idea, here every idea
  folds into the one pre-existing target goal G.)
- **Free-text mode.** Otherwise (any remaining token does NOT match `/^I\d+$/`),
  treat the WHOLE remainder as a single free-text follow-up request — the
  existing path (step 3 records it verbatim).

The two modes do not mix: you do not interleave idea-ids with free text after the
goal id. If the remainder is empty, stop and ask the user what to add.

### Consume-an-idea-into-this-goal (idea-ids mode)
Run this ONCE per idea-id, for the SAME target goal **G**. For each idea-id **I**:

1. **Fetch the idea.** `fetch_item("ideas", I)` from the `ideas` ledger. If `I`
   does not exist (or is not on the `ideas` ledger), report it and skip this id
   (continue with the remaining ids).
2. **Append the idea as new scope onto G.** Append the idea's **title +
   description** to G's `description` as a new follow-up scope section, using the
   SAME re-open path this command already documents for adding scope to a
   `planned`/`building` goal — i.e. step 3 (append the section) + step 4 (re-open
   to `clarifying`). This is the pre-existing follow-up re-open behaviour; no new
   re-open semantics are introduced.
3. **Link + transition via the shared sub-procedure.** For the goal↔idea
   `ledgerRefs` link and the idea→`planned` flip, reuse the
   **§Consume-an-idea sub-procedure defined in `/cq:plan` (`plan.md`)** — add
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
> **`/cq:investigate <defect description>`** instead of folding it into this
> goal. Investigation confirms the root cause and seeds a *defect-seeded*
> plan-flow goal (linked `defects:<D>`) that `/cq:plan:advance` turns into reviewed
> FIX TASKS — tasks remain the only executable unit; the defect stays a problem
> record. If the request plainly describes a fault to repair, point the user at
> `/cq:investigate` rather than re-opening this goal.

## Provenance (every ledger write)
On every `update_item`, pass `author` = your OWN model class (derived from
runtime identity, never hardcoded — Claude Opus 4.8 (1M) → `"opus-4.8[1m]"`;
Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` = `$CLAUDE_CODE_SESSION_ID` (or
the Codex equivalent; omit if unavailable).

## Steps

1. **Parse + validate.** Split off the goal id **G** (first token); classify the
   remainder per §Argument grammar — **idea-ids mode** (every remaining token
   matches `/^I\d+$/`) or **free-text mode** (otherwise). If the remainder is
   empty, stop and ask the user what to add. `fetch_item("goals", G)` — if G does
   not exist, report and stop. In idea-ids mode, the per-idea append + link +
   transition runs via §Consume-an-idea-into-this-goal (which drives steps 3–4
   per idea); in free-text mode, step 3 records the request verbatim.

2. **Phase gate.** Read `G`'s status (phase):
   - **`done` / `abandoned`** (terminal): a finished goal canNOT be re-opened —
     the goals state machine keeps terminal statuses outgoing-edge-free by
     design. STOP and tell the user to start a fresh goal for the new scope with
     `/cq:plan` (it can reference G in its description). Do not mutate G.
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

6. **Write the session logs and attach them to the goal.** The `plan-advance`
   subagent ends its reply with a `### Session summary` section. Persist BOTH a
   raw transcript and a summary — **ALL log writes go through `cq log put` under
   BOTH backends; never a direct `Write` to `.cq/logs/`, and never `git add` a
   log file** (`cq log put` does redaction + strict-JSONL validation IN the CLI,
   and under `git-object` commits to the orphan ref; under `fs` it writes under
   `.cq/logs/`, which the step-10 ledger commit already carries). Take
   `<agent-id>` from the `Agent` tool result and stamp `<timestamp>` via `Bash`
   (`date -u +%Y%m%d-%H%M%S`), then:
   - **Raw transcript.** Locate the native transcript at
     `~/.claude/projects/<slug>/<session>/subagents/agent-<agent-id>.jsonl` (the
     `<slug>` is the absolute ledger-root path with `/` → `-`; `<session>` =
     `$CLAUDE_CODE_SESSION_ID`) and pipe it through `cq log put`:
     `cat <transcript> | cq log put --stdin --dest logs/raw/<timestamp>-<agent-id>.jsonl`.
     **Absent transcript** (older run / crash / non-Claude harness) → do NOT
     fabricate a raw log: write an explicit `raw transcript unavailable: <reason>`
     line in the summary-log HEADER and proceed summary-only (leave `rawLogs`
     un-extended).
   - **Summary.** Write a short header (goal id, role: planner, returned status
     token) followed by the verbatim summary block via `cq log put` to
     `logs/<timestamp>-<agent-id>.md`.
   **Immediately after writing the logs**, call `update_item("goals", G, fields: {
   sessionLogs: [".cq/logs/<timestamp>-<agent-id>.md"], rawLogs:
   [".cq/logs/raw/<timestamp>-<agent-id>.jsonl"] })` to attach BOTH paths to the
   goal item in the SAME call (omit `rawLogs` when the transcript was absent) —
   do NOT defer this to a separate pass.

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

   For each defect **D** in the worklist, run **`/cq:investigate:advance D`
   inline** in this same main session, exactly per
   llm/commands/cq/investigate/advance.md — do NOT duplicate or re-implement
   that logic; run it. Inherit the stop predicates from plan/advance.md's
   auto-investigate phase (predicates a–f, per K12). A command chaining
   another command's loop is legal under **K12**; the
   subagents-cannot-spawn-subagents rule is preserved because only this
   orchestrator (a command) does the chaining.

8. **Report.** Tell the user: the goal id **G** and its new phase (`clarifying`);
   the questions the planner filed; and that they should answer them in the
   TUI/web, then run **`/cq:plan:advance G`** to plan the added scope;
   if step 7 ran: for each defect D in the worklist, one line covering its
   auto-investigate outcome (confirmed→seeded goal, parked on a question, or
   stopped by a K12 predicate) — same format as plan/advance.md's §Report
   auto-investigate lines.

9. **Handoff record.** This command is the outermost wrapper for this
   invocation (the user ran `/cq:plan:follow-up`), so **this command** writes the
   ONE `handoffs` record at this step. Use the field schema from
   plan/advance.md's §Handoff record, STANDALONE branch — the re-opened goal
   lands in `clarifying` with new questions filed, so the stop classification is
   `answers-required` (`flow` = `plan`; `ledgerRefs` `goals:<G>`;
   `blockingQuestions` the filed question ids; `sessionLogs` + `rawLogs` the
   round's summary + raw log paths). Do not restate the field mapping here. The conditional step-7
   auto-investigate sub-round writes NO handoff of its own — investigate/advance.md
   suppresses its handoff when chained by this command (per its CHAINED section:
   `/<flow>:follow-up` is listed as a suppress-context; this command owns the
   single authoritative write).

10. **Commit the ledger.** This command is the outermost wrapper, so it owns the
    single run-stop ledger commit. Immediately after the handoff write, persist
    the ledger to git — **when `[ledger] backend` is `fs` (the default); SKIP
    under `git-object`, whose orphan ref already carries each write** — ONLY
    the ledger (`.cq/*.md` + `.cq/archive` + `.cq/logs`; NEVER
    `docs/ledgers.yaml`, gitignored; NEVER code):
    ```
    git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
    git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:plan:follow-up — goal G<n> re-opened (awaiting-answers)

    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
    ```
    The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed.

Do not file questions, emit a plan, or lock decisions yourself — the
`plan-advance` planner and `/cq:plan:advance` own everything after the re-open.
