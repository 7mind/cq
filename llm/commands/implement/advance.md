---
description: Advance an implement-flow run one full pass — pick DAG-ready tasks, implement each in an isolated worktree, adversarially review, autonomously fix criticism, register user questions, and merge back in dependency order.
argument-hint: [milestoneId ...]   # optional; omit to resume the in-progress run
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

You are the **implement-flow orchestrator**. You execute a plan-flow roadmap by
driving worker/reviewer/conflict-resolver subagents. Subagents CANNOT spawn
subagents, so the whole loop — concurrent dispatch, the criticism loop, and
merge-back — lives HERE in the main session.

Target milestones (optional): `$ARGUMENTS`. If empty, operate on the run already
in progress: every non-archived, non-terminal milestone that has non-terminal
`tasks` linked to it. **This command is idempotent and fully resumable** — it
re-derives ALL state from the ledger and the git worktrees on each invocation,
so a user can run it repeatedly (e.g. after answering questions) and it picks up
exactly where it left off.

## Conventions this command obeys (decision K4)
- **Model tiers** (`tasks.suggestedModel`): `frontier`→opus / `standard`→sonnet /
  `fast`→haiku under Claude; the host's top/mid/fast tier under Codex. Resolve a
  task's tier to a concrete model just before dispatch. If `suggestedModel` is
  unset → default to your OWN class (Claude: `inherit`) AND print a `WARNING:
  task <id> has no suggestedModel` line.
- **Reviewer & conflict-resolver** always run at the host's MOST-CAPABLE model
  (Claude `opus`), regardless of the task's tier.
- **Worktrees**: Claude → dispatch the worker via `Agent` with
  `isolation: "worktree"` (native; auto-removed if unchanged, never
  auto-merged). Codex → `git worktree add ../wt-<taskId> -b implement/<taskId>
  <base>` before dispatch and `git worktree remove` after merge-back. Branch:
  `implement/<taskId>`. A fresh worktree has NO `node_modules`; do NOT symlink
  the parent checkout's `node_modules` (a single root symlink does not reproduce
  a bun workspace's per-package layout and makes a later `bun install` a no-op —
  see defect D2). Let the worker run a real `bun install` in the worktree
  (cheap with a warm global cache, offline-capable).
- **Concurrency**: at most **N = 8** workers in flight at once (configurable —
  treat 8 as the default ready-batch size). Dispatch a batch in a single
  message (parallel `Agent` calls), then process returns.

## Provenance (every ledger write)
On every `create_item` / `update_item`, pass `author` = your OWN model class
(derived from runtime identity, never hardcoded — Claude Opus 4.8 (1M) →
`"opus-4.8[1m]"`; Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` =
`$CLAUDE_CODE_SESSION_ID` (or the Codex equivalent; omit if unavailable).

## Session logs (after EVERY subagent returns)
Each subagent ends its reply with a `### Session summary` block. After each
`Agent` call returns: take `<agent-id>` from the tool result, stamp
`<timestamp>` (`Bash`: `date -u +%Y%m%d-%H%M%S`), `mkdir -p docs/logs`, and
`Write` `docs/logs/<timestamp>-<agent-id>.md` — a short header (task id, role,
returned status/verdict) plus the verbatim summary block. Subagents write no
file; you do.

---

## The pass (repeat until no task is ready)

### 1. Derive the READY-SET (purely from the ledger)
For each target milestone, `list_milestone_items` and collect its `tasks`. Also
read the `questions` ledger items linked `tasks:<id>` and the milestones' own
`dependsOn`/`blockedBy`.

First, **resume bookkeeping (Q7)**: for any task currently `blocked` whose
linked blocking `questions` are now all `answered` (non-empty `answer`), flip it
back `update_item("tasks", <id>, status: "planned")` and fold the answer text
into the next dispatch as additional guidance.

A task is **READY** iff ALL hold:
- its status is non-terminal and NOT `blocked` (`planned`, or re-opened above);
- every task in its `dependsOn` is `done`;
- its milestone's `dependsOn` milestones are satisfied (all their tasks
  terminal);
- it has NO linked `open` question.

If the ready-set is empty: skip to **Report** (nothing left to do this pass).

### 2. Dispatch workers (up to N concurrently)
Take up to N ready tasks. For each, resolve its model (§K4), set
`update_item("tasks", <id>, status: "wip")`, prepare its worktree (Claude:
`isolation: "worktree"`; Codex: manual `git worktree add`), and dispatch an
`implement-worker` via `Agent` (`subagent_type: "implement-worker"`,
`model: <resolved>`, `isolation: "worktree"` under Claude). The prompt MUST carry:
the task id + verbatim `headline`/`description`/`acceptance`, the branch
`implement/<taskId>` and base commit, and (on a re-dispatch) the prior round's
`criticism[]`. Issue the batch's `Agent` calls in ONE message so they run
concurrently. Write each worker's session log on return (§Session logs).

### 3. Review each finished worker
For every worker that returned `status: "pass"`, dispatch an `implement-reviewer`
(`subagent_type: "implement-reviewer"`, at the most-capable model — `opus`)
against that task's worktree diff (`base..HEAD`), passing the task acceptance,
the worker's structured result, and the round number. A worker that returned
`status: "fail"` skips review and goes straight to the criticism loop (its
`blockedReason` is treated as round-0 criticism).

**File the reviewer's `defects[]` (Q22/Q26, file-and-defer, K13).** A reviewer
return may carry a non-empty `defects[]` — OUT-OF-SCOPE or pre-existing faults
the reviewer noticed in the diff (entries `{ headline, description, severity,
suggestedFix? }`, see implement-reviewer T42). This is INDEPENDENT of the
verdict and never blocks the current in-scope task (Q26). For each entry,
`create_item("defects", <taskMilestone>, status: "open", fields: { headline,
description, severity: <reviewer's severity>, suggestedFix?, ledgerRefs:
["tasks:<id>", "goals:<G>"] })`. Record the triage context (task id, round,
reviewer rationale) in the defect's OWN `fields` (e.g. `description` or
`suggestedFix`). **Do NOT file a `questions` item routing the user to
`/investigate:start <D>` (K13 — questions are reserved for genuine user
decisions, not routing pointers).** The defect is self-contained: its
`ledgerRefs` link it to the task and goal, and `/investigate:start` accepts a
bare defect id (`^D\d+$` resume path) so any open defect is directly actionable
via ledger query without a pointer question. **Implement:* does NOT auto-launch
investigate inline (Q43) — that is plan:*'s responsibility, since implement:* is
an execution flow, not a planning flow. The filed defect will be triaged by the
next /plan:advance cycle's auto-investigate phase, or by a direct user
/investigate:start <D>.** Do NOT block, fail, or re-dispatch the current task on
a filed defect, and do NOT add it to the criticism loop — it is tracked
separately. Filing a defect is idempotent: on a re-run, skip entries already
filed for this task (match by headline + task ledgerRef).

### 4. Autonomous criticism loop (NO fixed cap)
For a task whose reviewer verdict is `disapprove` with non-empty `criticism` and
EMPTY `questions`: re-dispatch the SAME worker in the SAME worktree with the
`criticism[]` as guidance, then re-review. Repeat. There is deliberately **no
normal round cap** — keep iterating while the work is converging.

**Validate each round and detect an ILL LOOP.** Before re-dispatching, check the
returned results for sanity and STOP the loop (→ §5 bailout) when ANY holds:
- the latest round produced **no file changes** (worker's `filesTouched` empty /
  diff identical to the previous round's);
- the **criticism repeats without shrinking** — the same defects recur across
  two consecutive rounds with no reduction in count/severity;
- the **same `bun run check` failure** (same failing test/error signature)
  recurs across rounds.

Log the reason you stopped.

### 5. Register questions (reviewer questions OR ill-loop bailout)
When the reviewer returns non-empty `questions`, OR the criticism loop bailed as
an ill loop: for each open issue create
`create_item("questions", <taskMilestone>, status: "open", fields: { question:
"<the question / the ill-loop diagnosis as a question>", context: "<round
history, last criticism, last check failure>", ledgerRefs: ["tasks:<id>",
"goals:<G>"] })`, then `update_item("tasks", <id>, status: "blocked")`. Leave
the worktree INTACT (do not remove it) so the work survives until the user
answers. The user answers in the TUI/web, then re-runs `/implement:advance` to
resume (step 1 re-opens the task).

### 6. Success gate
A task SUCCEEDS only when BOTH hold: its worker's last `bun run check` was green
AND the reviewer verdict is `approve` (empty criticism and questions). Only
succeeded tasks proceed to merge-back.

### 7. Merge-back (sequential, DAG order, rebase-before-merge)
Process succeeded tasks ONE AT A TIME, in dependency order (a task merges only
after every task in its `dependsOn` has merged). For each:
1. Rebase its branch onto the CURRENT base (which now includes earlier
   merge-backs from this pass): `git rebase <base> implement/<taskId>` (run from
   its worktree, or fetch the branch into the main checkout).
2. **On conflict** → dispatch `implement-conflict-resolver` (most-capable model)
   with the worktree, branch, base, and conflicting files. On its `pass`,
   continue; on its `fail`, treat like a question bailout (§5: register a
   `questions` item, set the task `blocked`, leave the worktree) and SKIP merging
   this task (and transitively anything depending on it) this pass.
3. On a clean rebase (or resolved conflict) → fast-forward merge into the base,
   set `update_item("tasks", <id>, status: "done", fields: { resultCommit:
   "<merged sha>", completion: "<1-line: what landed>" })` (both are valid
   optional `tasks` fields), and remove the worktree (Claude: auto; Codex: `git
   worktree remove` + delete the branch).
4. **Resolve the defect this task fixed (Q20 — orchestrator-owned closure).** If
   the just-merged task `ledgerRefs` one or more `defects:<D>` (it is a fix task
   for D), check whether D is now fully fixed: collect D's fix-task set =
   `D.dependsOn` (filtered to tasks) UNION every task whose `ledgerRefs` include
   `defects:<D>` (the bidirectional link from the plan-flow, dedup'd). If EVERY
   task in that set is now `done`, close the defect:
   `update_item("defects", <D>, status: "resolved", fields: { fix: "<1-line:
   what landed across the fix tasks>" })`. If any fix task is still non-terminal,
   leave D `open` — a later merge-back closes it. The orchestrator OWNS this
   closure; the reviewer and worker never touch the defects ledger status.

### 8. Loop
After merge-back, RE-DERIVE the ready-set (step 1) — tasks unblocked by the
just-merged ones become ready. Continue passes until the ready-set is empty.

---

## Record the terminal review (one per task)
The reviewer writes NOTHING to the ledger. YOU record exactly ONE terminal
`reviews` item per task once it reaches a terminal review outcome (approved, or
blocked-on-question): `create_item("reviews", <taskMilestone>, status:
"go-ahead" | "revise", fields: { summary: "<reviewer's summary field, or
'<verdict>: <first line of rationale, truncated to ~80 chars>' if omitted>",
criticism: [...], new_questions: [...], ledgerRefs: ["tasks:<id>",
"goals:<G>"] })`. Use the reviewer's `summary` when present; otherwise
synthesize `'<verdict>: <first line of rationale, truncated to ~80 chars>'`.
This keeps the ledger to one review per task instead of one per criticism round.

## Milestone completion
`archive_milestone(<id>)` requires ALL items under the milestone to be terminal —
that includes its `defects` (terminal = `resolved`/`wontfix`), not just its
`tasks` (`done`/`abandoned`). So a milestone whose tasks are all `done` but that
still carries an `open` defect is NOT yet complete: archiving waits until the
defect reaches a terminal status too (it gets there via the orchestrator-owned
closure in §7.4 when its fix tasks all merge, or via the investigate-flow for an
out-of-scope defect filed in §3).

Note the asymmetry: a filed defect does NOT gate task merge-back (§3 file-and-
defer — tasks merge regardless), but it DOES gate milestone archival.

### Milestone auto-close+archive sweep (factored predicate)
After merge-back, run the **auto-close+archive sweep** over every milestone the
pass touched (and, in `/advance`, over the whole `milestones` ledger). This is
the single authoritative predicate — `/advance` (llm/commands/advance.md) states
the same rule and is the catch-all that also sweeps milestones whose goal the
user closed between runs.

A milestone `M` is **eligible to auto-close+archive** iff BOTH:
1. **every item under `M`** (across ALL ledgers — tasks, defects, reviews,
   questions, decisions, hypotheses, and the goal if any) is **terminal**; AND
2. if `M` is a **coordination milestone** (its items include a `goals` item),
   that **goal is itself terminal** (`done`/`abandoned`). A **work** milestone
   has no goal item, so condition 2 is vacuous for it.

**Mechanism (both conditions hold):** `update_milestone(M, status: "done")`
THEN `archive_milestone(M)` — `archive_milestone` refuses unless the
milestone-item itself is terminal, so the `status: "done"` step must come first.
Do NOT add any `dependsOn`-terminal precondition beyond the two above.

**Guard:** NEVER archive a coordination milestone whose goal is **non-terminal**,
even if all its current items are terminal — new follow-up scope may still add
items to it (e.g. a goal in `planned`/`building`, or one re-opened to
`clarifying`, must keep its coordination milestone open).

**Goal-vs-milestone asymmetry (explicit):** **GOALS NEVER auto-close** — the
orchestrator MUST NEVER transition a goal to a terminal status
(`building`→`done`); that is always the user's action (the G3-B / M16 invariant;
`planned`→`building` may stay automatic as it is non-terminal). **MILESTONES
ALWAYS may** auto-close+archive once eligible per the predicate above. So when
all of goal `G`'s work milestones are archived, the orchestrator REPORTS that
`G` is ready to close and instructs the user to set it `done` in the TUI/web —
and once the user DOES close `G`, the next sweep archives `G`'s now-eligible
coordination milestone automatically.

## Report to the user
Summarize the pass concisely:
- tasks **merged** this pass (id + resultCommit);
- tasks **blocked** on questions (id + the question ids to answer);
- tasks **failed**/skipped and why;
- whether any milestone was archived;
- whether goal `G` is **ready to close** (all work milestones archived) —
  instruct the user to close it in the TUI/web (set status to `done`);
- the next action: if anything is `blocked`, "answer the listed questions in the
  TUI/web, then run `/implement:advance` to resume"; if all done, say so.
