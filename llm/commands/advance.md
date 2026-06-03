---
description: Advance the WHOLE flow one cycle — chain /investigate:advance, /plan:advance, /implement:advance to quiescence, then report DRAINED / BLOCKED-ON-QUESTIONS / MIXED.
argument-hint:   # no argument; operates on the entire ledger
allowed-tools: mcp__ledger__*, Read, Grep, Glob, Bash
---

You are the **top-level flow sequencer**. You drive an end-to-end run by chaining
the three existing per-flow advance commands — `/investigate:advance`,
`/plan:advance`, `/implement:advance` — to quiescence. You are a
**command-of-commands** (decision **K12**: a *command* may chain another command;
a *subagent* still cannot). This command runs in the **MAIN session** and
**dispatches NO subagents of its own** (Q58). Every subagent (explorers, planner,
reviewer, implement workers/reviewers/conflict-resolvers) is spawned by the
sub-commands you chain — never directly by you. Your only direct ledger calls are
**read-only** detection queries (`fetch_ledger`/`search_items`/`fts_search`/
`fetch_item`); the sub-commands own every ledger MUTATION.

**This command is idempotent and fully resumable** — it re-derives ALL state from
the ledger on each invocation and on each cycle. Run it repeatedly (e.g. after
answering questions); it picks up exactly where the durable ledger state left off.

## Conventions this command obeys (K12)
- **Pure sequencer.** You do not re-implement any sub-flow's logic — you RUN the
  sub-command (chaining it inline in this same main session, exactly per its own
  prompt: llm/commands/investigate/advance.md, llm/commands/plan/advance.md,
  llm/commands/implement/advance.md). The subagents-cannot-spawn-subagents rule is
  preserved because ONLY this command (a command) chains commands; the sub-flows'
  subagents still spawn nothing.
- **No concurrency cap of this command's own (Q60).** /advance introduces NO
  concurrency limit; each chained sub-flow keeps its OWN (implement-flow's `N = 8`
  worker batch, investigate's seed-parallel/drill-serial rule, etc.). You inherit
  whatever each sub-command enforces and add nothing.
- **No double-triage of goal-linked defects (Q57).** `/plan:advance` OWNS the
  auto-investigate of every defect linked to a goal it advances (its
  auto-investigate phase, keyed on defect STATUS). Therefore /advance's
  investigate stage triages ONLY defects NOT already owned by a planning goal — it
  does not re-run `/investigate:advance` on a defect that `/plan:advance` will pick
  up. See the investigate predicate below.
- **Ledger is the source of truth.** Detection is by LEDGER QUERY on item STATUS
  (the queryable lifecycles from T116/M33), never by parsing a sub-command's prose
  report. A sub-command's prose is advisory; you re-derive the next cycle's work
  from the ledger.

## Provenance
This command makes NO ledger writes of its own (read-only detection only). Every
write is performed by a chained sub-command, which stamps `author`/`session` per
its own prompt. You stamp nothing.

## Session logs
This command spawns no subagents, so it writes no session-log file of its own.
Each chained sub-command logs ITS subagents to `docs/logs/` per that command's
own §Session logs rule — follow each sub-command's logging rule while running it.

---

## Detection predicates (the three ledger queries — Q55)

Before each stage you run a LEDGER QUERY to decide whether that stage has work.
All three read item STATUS using the queryable lifecycles (the NEW defect statuses
from **T116/M33**); none parses prose.

### P-investigate — is there a defect actionable by /investigate:advance?
TRUE iff there exists a **defect** D such that ALL hold:
- D's `status` is **ACTIONABLE** — `open`, `wip`, or `inconclusive` (the new
  T116/M33 lifecycle; `root-caused` is READY-TO-SEED and handled by plan's
  auto-investigate, NOT re-triaged here — EXCLUDED; `resolved`/`wontfix` are
  terminal — EXCLUDED);
- D is **NOT blocked solely on an open question** — i.e. NOT every path forward
  for D depends on an unanswered `open` `questions` item linked `defects:<D>`. If
  D is parked on an unanswered question with no other lead, it is BLOCKED, not
  actionable;
- D is **NOT already owned by a planning goal** (Q57) — D is not linked
  (`ledgerRefs` `defects:<D>`) by any goal in a movable planning phase
  (`clarifying`/`planning`). Those defects are `/plan:advance`'s to
  auto-investigate; triaging them here would double-triage.

(`root-caused` defects are NOT re-triaged here — plan's auto-investigate seeds the
fix goal from them.)

### P-plan — is there a goal in a movable planning phase?
TRUE iff there exists a **goal** G whose phase is a MOVABLE planning phase:
- `clarifying` **with NO open question** linked to G (a `clarifying` goal sitting
  on unanswered `open` questions is BLOCKED, not movable — answering is the user's
  action), OR
- `planning` (always movable — the planner advances one step toward `planned`).

(`planned`, `building`, `done`, `abandoned` are locked/terminal for planning and
do NOT make P-plan true.)

### P-implement — is there a DAG-ready task to implement?
TRUE iff there exists a **goal** G in `planned` or `building` that has a
**DAG-READY non-terminal task** — a task in the implement-flow READY-SET per
llm/commands/implement/advance.md §1: status non-terminal and NOT `blocked`; every
task in its `dependsOn` is `done`; its milestone's `dependsOn` milestones are
satisfied; and it has NO linked `open` question. (A goal whose only remaining
tasks are all `blocked` on open questions yields no ready task — P-implement is
FALSE for it.)

---

## The cycle (Q56 — loop to quiescence, NO max-iteration cap)

Repeat the following cycle. There is **NO fixed iteration cap** (Q56); the loop is
bounded by PROGRESS, not by a counter. Each stage runs its sub-command's own
internal loop (which is itself bounded by that command's stop predicates), then
you re-derive the predicates and continue.

### Cycle order: investigate → plan → implement, then RE-CHECK investigate
1. **Investigate stage.** Evaluate **P-investigate**. If TRUE, for each defect D in
   its worklist run **`/investigate:advance D` INLINE** — exactly per
   llm/commands/investigate/advance.md (do NOT re-implement it; RUN it). This
   triages only the NOT-owned-by-a-planning-goal defects (Q57); a defect already
   linked to a `clarifying`/`planning` goal is left for the plan stage's
   auto-investigate. If P-investigate is FALSE, skip this stage.
2. **Plan stage.** Evaluate **P-plan**. If TRUE, run **`/plan:advance` INLINE**
   (no argument — it advances every unlocked goal) exactly per
   llm/commands/plan/advance.md. Note: **plan:advance OWNS auto-investigate** of
   its goal-linked defects (its own auto-investigate phase) — so /advance does NOT
   double-triage them (Q57); the plan stage handles them as part of its own round.
   If P-plan is FALSE, skip this stage.
3. **Implement stage.** Evaluate **P-implement**. If TRUE, run
   **`/implement:advance` INLINE** (no argument — it resumes the in-progress run)
   exactly per llm/commands/implement/advance.md. Its reviewers may FILE new
   `open` defects (file-and-defer, K13). If P-implement is FALSE, skip this stage.
4. **RE-CHECK investigate after implement.** Because the implement reviewer may
   have filed new defects this cycle, re-evaluate **P-investigate** at the END of
   the cycle. If it is now TRUE again (new actionable defects appeared), the loop
   has made progress — continue to the next cycle (which will investigate them).

### Stop condition — quiescence (Q56)
Stop the loop ONLY when **progress is genuinely impossible** — that is, after a
full cycle in which **NO stage did any work AND no new actionable item appeared**.
Operationally, STOP when, at the end of a cycle, ALL hold:
- **P-investigate is FALSE** — every defect is terminal (`resolved`/`wontfix`),
  or owned by a planning goal (will be picked up by plan), or BLOCKED solely on an
  unanswered open question;
- **P-plan is FALSE** — no goal is in a movable planning phase (every unlocked
  goal is parked on open questions, or all goals are locked/terminal);
- **P-implement is FALSE** — no goal has a DAG-ready non-terminal task (every
  remaining task is terminal or blocked on an open question).

In other words: stop when **every ledger is DRAINED** (nothing actionable
anywhere) **OR every actionable item is BLOCKED on an unanswered user question**.
Do NOT stop merely because a cycle was "long"; keep cycling while ANY stage still
moves the ledger forward. A cycle that made progress (any stage acted, or
re-check (4) surfaced new work) means another cycle is warranted.

---

## Milestone auto-close + archive sweep (end-of-run — placeholder, T128)

After the loop reaches quiescence, run the **auto-close+archive sweep** over the
entire `milestones` ledger. `/advance` is the AUTHORITATIVE locus for this rule
(it re-derives ledger state each run, so it also catches milestones whose goal
the user closed between runs); implement/advance.md's milestone-completion step
states the SAME factored predicate for the in-pass case — keep the two in sync,
do not let them diverge.

A milestone `M` is **eligible to auto-close+archive** iff BOTH:
1. **every item under `M`** (across ALL ledgers — tasks, defects, reviews,
   questions, decisions, hypotheses, and the goal item if any) is **terminal**; AND
2. if `M` is a **coordination milestone** (its items include a `goals` item),
   that **goal is itself terminal** (`done`/`abandoned`). A **work** milestone
   has no goal item, so condition 2 is vacuous for it.

**Mechanism (both hold):** `update_milestone(M, status: "done")` THEN
`archive_milestone(M)` — `archive_milestone` refuses unless the milestone-item is
already terminal, so the `done` step comes first. No `dependsOn`-terminal
precondition beyond the two above.

**Guard:** NEVER archive a coordination milestone whose goal is **non-terminal**,
even when all its current items are terminal — pending follow-up scope may still
add items (a goal in `planned`/`building`, or re-opened to `clarifying`, keeps
its coordination milestone open).

**Goal-vs-milestone asymmetry (explicit):** **GOALS NEVER auto-close** — never
transition a goal `building`→`done` (always the user's action; the G3-B / M16
invariant). **MILESTONES ALWAYS may** auto-close+archive once eligible. So once
the user closes a goal `G`, the next `/advance` sweep archives `G`'s
now-eligible coordination milestone automatically.

---

## End-of-run report (Q59 — DRAINED / BLOCKED-ON-QUESTIONS / MIXED)

When the loop stops, classify the run into exactly ONE of three categories and
report it. Mirror llm/commands/implement/advance.md's end-of-pass report style
(concise, id-listing, next-action-bearing).

- **DRAINED** — nothing actionable remains anywhere: every defect terminal or
  plan-owned, every goal locked/terminal for planning, every task terminal, and
  NO actionable item is blocked on an open question. Report: the work that landed
  across the run (defects root-caused/resolved, goals planned, tasks merged,
  milestones archived), and that the run is complete — no user action needed.
- **BLOCKED-ON-QUESTIONS** — progress stopped ONLY because actionable items are
  parked on unanswered `open` questions. **Enumerate every blocking question** by
  id, each with its OWNING item (the `defects:<D>` / `goals:<G>` / `tasks:<id>` it
  ledgerRefs) and a one-line summary. Instruct the user: **answer the listed
  questions in the TUI/web, then re-run `/advance`** to resume (the loop folds the
  answers back in and continues).
- **MIXED** — progress was made this run AND some actionable items remain blocked
  on open questions. Report BOTH: (a) what landed (as in DRAINED), and (b) the
  remaining blocking question ids with owning items (as in BLOCKED-ON-QUESTIONS).
  Next action: answer the listed questions, then re-run `/advance`.

To build the report, re-derive the three predicates one final time from the
ledger: if all three are FALSE and no `open` question gates any actionable item →
**DRAINED**; if the only thing standing between an item and progress is an
unanswered question → **BLOCKED-ON-QUESTIONS** (or **MIXED** when the run also
landed work). Always close with the concrete next action and (for the blocked
categories) the exact list of question ids to answer.
