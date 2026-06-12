---
description: Start a plan-flow goal — create the goal (from free text OR one-or-more idea-ids, one goal per idea), then hand off to the planner for the first clarifying questions.
argument-hint: <goal description> | <I-id> [<I-id> ...]
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "EITHER one-or-more whitespace-separated idea-ids (each /^I\\d+$/) OR a free-text goal description ($ARGUMENTS) — not both interleaved"
outputs:
  - "coordination milestone M (create_milestone)"
  - "one-or-more goal items G in clarifying status (one goal PER idea when idea-ids are given; create_item on goals ledger)"
  - "for each idea-seeded goal: bidirectional ledgerRefs link (goal↔idea) + idea status→planned"
  - "first batch of clarifying questions (filed by plan-advance subagent)"
  - "planner summary log .cq/logs/<timestamp>-<agent-id>.md AND raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl, BOTH written via `cq log put`"
  - "handoffs item (answers-required) and ledger git commit"
ioSchema:
  - "bootstrap only — no plan logic; plan-advance subagent owns question generation"
  - "goal schema fields: title, description (required); grounding, milestones (set later by planner)"
  - "idea-id token grammar: /^I\\d+$/; argument is EITHER all idea-ids OR free text (no interleave)"
  - "handoffs item: flow=plan, ledgerRefs=goals:<G>, blockingQuestions=filed question ids"
```

You are starting a **plan-flow goal**. The user's goal is:

> $ARGUMENTS

This command does the one-time **bootstrap** only — create the coordination
milestone and the goal(s) — then hands off to the `plan-advance` planner for the
first clarifying questions. It owns NO question or plan logic of its own: that
all lives in the `plan-advance` subagent (the same planner `/cq:plan:advance`
drives), so the question-generation logic exists in exactly one place.

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

## Defect vs goal — intake the right ledger
Plan-flow goals are for **greenfield work** (build/change something). A
user-reported **DEFECT** — an existing fault to fix — should NOT be intaked as a
goal: file it on the `defects` ledger via **`/cq:investigate <defect
description>`** instead. That flow investigates the fault, confirms a root cause,
and (per the file-and-defer handoff, K8) seeds a *defect-seeded* plan-flow goal —
linked `defects:<D>` with the confirmed root cause embedded — which
`/cq:plan:advance` then turns into reviewed FIX TASKS (tasks remain the only
executable unit; the defect itself stays a problem record). So: fix request →
`/cq:investigate`; new capability → `/cq:plan` (here). If `$ARGUMENTS`
plainly describes a fault to repair, tell the user to use `/cq:investigate`
and stop instead of creating a goal.

## Argument grammar — idea-ids OR free text (Q188, no interleave)
`$ARGUMENTS` is parsed in exactly ONE of two mutually-exclusive modes — there is
NO 'mixed' interleaving:

- **Idea-ids mode.** If the argument is one or more whitespace-separated tokens
  and **every** token matches the idea-id pattern **`/^I\d+$/`** (an `I`
  followed by one-or-more digits, e.g. `I01`, `I2`, `I137`), treat the argument
  as a list of idea-ids. `/cq:plan I01 I02 I03` creates **ONE goal PER idea** —
  iterate the ids in order, running the §Consume-an-idea sub-procedure once per
  id. Each idea yields its own coordination milestone + goal + clarifying round.
- **Free-text mode.** Otherwise (any token does NOT match `/^I\d+$/`), treat the
  WHOLE argument as a single free-text goal description — today's path (steps
  1–8 below, once).

The two modes do not mix: you do not interleave idea-ids with free text in a
single invocation. If the argument is empty, ask the user what to plan and stop.

## Consume-an-idea sub-procedure
Run this ONCE per idea-id when in idea-ids mode. It is the single definition of
"turn an idea into a seeded plan-flow goal"; `/cq:plan:follow-up` references this
same sub-procedure (DRY — do not re-derive it there). For idea-id **I**:

1. **Fetch the idea.** `fetch_item("ideas", I)` from the `ideas` ledger. If `I`
   does not exist (or is not on the `ideas` ledger), report it and skip this id
   (continue with the remaining ids).
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
Search the ledger so you don't duplicate an existing goal: `fts_search` with
`ledger: "goals"` over the goal's key terms. If a live goal already covers this,
report its id and stop instead of creating a new one. In idea-ids mode, run this
de-dup check per idea before consuming it.

## Steps
In **free-text mode** these steps run once over `$ARGUMENTS`. In **idea-ids
mode** they run once PER idea-id — driven by the §Consume-an-idea sub-procedure,
which supplies the seeded title/description (step 2), performs the bidirectional
link, and flips the idea to `planned` — so one goal is bootstrapped per idea.

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

4. **Write the session logs and attach them to the goal.** The `plan-advance`
   subagent ends its reply with a `### Session summary` section. Persist BOTH a
   raw transcript and a summary — **ALL log writes go through `cq log put` under
   BOTH backends; never a direct `Write` to `.cq/logs/`, and never `git add` a
   log file** (`cq log put` does redaction + strict-JSONL validation IN the CLI,
   and under `git-object` commits to the orphan ref; under `fs` it writes under
   `.cq/logs/`, which the step-8 ledger commit already carries). Take
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

5. **Auto-investigate filed defects (conditional — K12).** This mirrors the
   same phase in `/cq:plan:advance` (see that command's §Auto-investigate filed
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

   For each defect **D** in the worklist, run **`/cq:investigate:advance D`
   inline** in this same main session, exactly per
   `/cq:investigate:advance` — do NOT duplicate or re-implement
   that logic; run it. Inherit the stop predicates from `/cq:plan:advance`'s
   auto-investigate phase (predicates a–f, per K12). A command chaining
   another command's loop is legal under **K12**; the
   subagents-cannot-spawn-subagents rule is preserved because only this
   orchestrator (a command) does the chaining.

6. **Report.** Tell the user:
   - the goal id **G** and milestone **M** (in idea-ids mode: one G+M line PER
     idea, each annotated with the source idea-id `I` it was seeded from and that
     `I` was flipped to `planned`);
   - the questions the planner filed (from its returned summary);
   - that they should answer the questions in the TUI or web client (set each to
     `answered` with a non-empty `answer`), then run **`/cq:plan:advance G`** to
     continue;
   - if step 5 ran: for each defect D in the worklist, one line covering its
     auto-investigate outcome (confirmed→seeded goal, parked on a question, or
     stopped by a K12 predicate) — same format as `/cq:plan:advance`'s §Report
     auto-investigate lines.

7. **Handoff record.** This command is the outermost wrapper for this
   invocation (the user ran `/cq:plan`), so **this command** writes the ONE
   `handoffs` record at this step. Use the field schema from `/cq:plan:advance`'s
   §Handoff record, STANDALONE branch — the goal is left in
   `clarifying`/`awaiting-answers` with the first questions filed, so the stop
   classification is `answers-required` (`flow` = `plan`; `ledgerRefs`
   `goals:<G>`; `blockingQuestions` the filed question ids; `sessionLogs` +
   `rawLogs` the step-4 summary + raw paths). Do not restate the field mapping
   here. The conditional step-5
   auto-investigate sub-round writes NO handoff of its own — `/cq:investigate:advance`
   suppresses its handoff when chained by this command (per its CHAINED section:
   `/<flow>:start` is listed as a suppress-context; this command owns the single
   authoritative write).

8. **Commit the ledger.** This command is the outermost wrapper, so it owns the
   single run-stop ledger commit. Immediately after the handoff write, persist
   the ledger to git — **when `[ledger] backend` is `fs` (the default); SKIP
   under `git-object`, whose orphan ref already carries each write** — ONLY the
   ledger (`.cq/*.md` + `.cq/archive` + `.cq/logs`; NEVER
   `docs/ledgers.yaml`, gitignored; NEVER code):
   ```
   git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
   git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:plan — goal G<n> bootstrapped (awaiting-answers)

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
   ```
   The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed.

Do not file questions, transition the goal, or emit any plan yourself — the
`plan-advance` planner and `/cq:plan:advance` own everything after the goal is
created.
