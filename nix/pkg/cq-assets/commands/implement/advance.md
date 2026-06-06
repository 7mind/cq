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

For a `pi:*` reviewer (§3b) there is no `Agent` id, so key its log by reviewer
alias: `Write docs/logs/<timestamp>-pi-<alias>-<taskId>.md` — a header (task id,
role `implement-reviewer (pi:<harness>:<model>)`, parsed verdict) plus the
reviewer's VERBATIM stdout (the raw, possibly fence-wrapped json). Capture this
even when its stdout was unparseable (so a failed external reviewer leaves a
trace). Include these `pi` log paths alongside the native reviewer logs in the
task's `sessionLogs` (§Record, §7.3).

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

### 3. Review each finished worker (multi-reviewer panel, reconciled)
For every worker that returned `status: "pass"`, run the **reviewer panel** for
that task (below) against its worktree diff (`base..HEAD`), passing the task
acceptance, the worker's structured result, the latest `bun run check` output,
and the round number. A worker that returned `status: "fail"` skips review and
goes straight to the criticism loop (its `blockedReason` is treated as round-0
criticism).

**3a. Resolve the reviewer panel (T172).** ONCE per pass, query
the ledger's reviewer list by calling the `mcp__ledger__get_reviewers` MCP
tool (the ledger MCP server is registered in `.mcp.json` as `ledger`;
it has no stdout-printing CLI, so this is an MCP-tool call, NOT a `Bash`
shellout). It returns `{ configured, reviewers: [{ harness, model, alias }] }`.
Apply any session-only override already in effect. Then:
- **`configured` is false (absent / unconfigured)** → the panel is the SINGLE
  native `implement-reviewer` Agent, exactly as before (`subagent_type:
  "implement-reviewer"`, most-capable model — `opus`). It already returns the
  terminal json the orchestrator records; nothing else changes. Skip 3b/3c.
- **`configured` is true** → the panel is the listed active reviewers; run them
  in PARALLEL per task (3b) and RECONCILE their verdicts (3c).

**3b. Launch the panel in PARALLEL (one batch per task).** For each active
reviewer in the resolved list, dispatch in a SINGLE message so they run
concurrently, keyed by `harness`:
- **`claude:*`** → native `implement-reviewer` Agent (`subagent_type:
  "implement-reviewer"`, model from the reviewer's `model`, else most-capable
  `opus`). It returns its structured json (the contract below) and writes
  nothing to the ledger.
- **`pi:*`** → `Bash` shellout to the `pi` CLI (T169 invocation, decision K30):
  `pi -p --no-tools --no-session --provider <P> --model <M> '<prompt>'`
  (grok-build → `--provider grok-build --model grok-build`; gpt-5.5 →
  `--provider openai-codex --model gpt-5.5`; map from the reviewer's
  `harness`/`model`/`alias`). The `<prompt>` feeds the SHARED `/cq:implement-review`
  rubric (`commands/cq/implement-review.md`, T174) PLUS the task acceptance, the
  worktree diff (`base..HEAD`), and the latest `bun run check` output. `pi` runs
  in default text mode; parse the (possibly fence-wrapped) json from its stdout.

Every reviewer — native `implement-reviewer` and the shared `/cq:implement-review`
rubric driving `pi` — returns the SAME byte-identical contract: `{ taskId,
verdict: "approve" | "disapprove", criticism: [], questions: [], defects: [...],
rationale, summary }`. Tag each parsed result with its source reviewer
(`harness:model`/`alias`) for the reconciliation step. If a `pi` shellout fails
to run or yields unparseable stdout, treat that reviewer as `disapprove` with a
`criticism` entry naming the failure (so a flaky external reviewer parks rather
than silently approves), and log its raw stdout (§Session logs).

**3c. RECONCILE the panel — STRICTEST-WINS + UNION (Q91).** Fold the panel's
per-reviewer json into ONE reconciled verdict that drives the criticism loop
(§4), the success gate (§6), and the single recorded `reviews` item (§Record):
- **Verdict (strictest-wins):** ANY reviewer `disapprove` → the reconciled
  verdict is `disapprove`. The reconciled verdict is `approve` ONLY when ALL
  reviewers `approve` AND the worker's latest `bun run check` is green.
- **Findings (union, source-tagged):** the reconciled `criticism[]`,
  `questions[]`, and `defects[]` are the UNION across all reviewers, each entry
  tagged with its source reviewer (`harness:model`/`alias`); dedup byte-identical
  entries from different reviewers into one entry that lists all its sources.
- **Routing is unchanged on the reconciled result:** the unioned `questions[]`
  drive §5 (park the task as `blocked`); the unioned `criticism[]` (with empty
  reconciled `questions[]`) drives §4 (autonomous criticism loop); the unioned
  `defects[]` are file-and-defer below — INDEPENDENT of the verdict.
- **Invariants preserved on the RECONCILED result** (same as the single-reviewer
  case): an `approve` REQUIRES empty reconciled `criticism` + empty reconciled
  `questions` + green check; a `disapprove` REQUIRES non-empty reconciled
  `criticism` and/or `questions`. (A bare strictest-wins `disapprove` whose union
  is empty cannot occur, since the dissenting reviewer's own `disapprove` carries
  non-empty findings by its contract.)

Everywhere below, "the reviewer verdict" / "the reviewer's `criticism`" /
"the reviewer's `questions`" refer to this **reconciled** result.

**File the reviewer's `defects[]` (Q22/Q26, file-and-defer, K13).** A reviewer
return may carry a non-empty `defects[]` — OUT-OF-SCOPE or pre-existing faults
the reviewer noticed in the diff (entries `{ headline, description, severity,
suggestedFix? }`, see implement-reviewer T42). This is INDEPENDENT of the
verdict and never blocks the current in-scope task (Q26). For each entry,
`create_item("defects", <taskMilestone>, status: "open", fields: { headline,
description, severity: <reviewer's severity>, suggestedFix?, ledgerRefs:
["tasks:<id>", "goals:<G>"] })`. Record the triage context (task id, round,
reviewer rationale) in the defect's OWN `fields` (e.g. `description` or
`suggestedFix`). A filed defect is a fault **to be fixed in a separate task** —
its default disposition is FIX; it is NEVER a "candidate for fix or wontfix"
choice the flow puts to the user. **Do NOT file a `questions` item routing the
user to `/investigate:start <D>`, AND do NOT file a `questions` item asking
whether/how/when to fix it (fix-vs-wontfix, out-of-scope/pre-existing,
external-API or blast-radius disposition) (K13 — `questions` are reserved for
genuine user *requirements* decisions, not routing pointers and not
fix-disposition prompts; `wontfix` is user-initiated only).** The defect is self-contained: its
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
AND the RECONCILED reviewer verdict (§3c) is `approve` (empty unioned criticism
and questions). With a multi-reviewer panel this means EVERY active reviewer
approved AND the check is green (strictest-wins); a single dissenting
`disapprove` keeps the task out of merge-back. Only succeeded tasks proceed to
merge-back.

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
   "<merged sha>", completion: "<1-line: what landed>", sessionLogs:
   ["docs/logs/<ts>-<worker-agent-id>.md", ...] })` — include ALL session-log
   paths written for this task (worker + reviewer rounds) in the SAME
   `update_item` call that marks the task `done`; do NOT defer `sessionLogs` to
   a separate update. Then remove the worktree (Claude: auto; Codex: `git
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
The reviewers write NOTHING to the ledger. YOU record exactly ONE terminal
`reviews` item per task — from the RECONCILED verdict (§3c), NOT one per reviewer
— once it reaches a terminal review outcome (approved, or blocked-on-question):
`create_item("reviews", <taskMilestone>, status:
"go-ahead" | "revise", fields: { summary: "<reconciled summary, or
'<reconciled-verdict>: <first line of rationale, truncated to ~80 chars>' if
omitted>", criticism: [...], new_questions: [...], ledgerRefs: ["tasks:<id>",
"goals:<G>"], sessionLogs: ["docs/logs/<ts>-<reviewer-agent-id>.md", ...] })`.
The `criticism`/`new_questions` are the source-tagged UNION across the panel
(§3c); the `status` follows the reconciled verdict (`go-ahead` only when ALL
reviewers approved + green check, else `revise`). Include EVERY reviewer's
session-log path written for this task (the native-Agent logs and the `pi`
stdout logs, §Session logs) in the SAME `create_item` — do NOT defer them to a
separate update. With a single configured/unconfigured reviewer this collapses
to the prior behaviour. Use the reconciled `summary` when present; otherwise
synthesize `'<reconciled-verdict>: <first line of rationale, truncated to ~80
chars>'`. This keeps the ledger to one review per task instead of one per
reviewer or one per criticism round.

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

### Commit the ledger (after every milestone archive + at the standalone stop)
The ledger files are tracked git artifacts. Commit the ledger — and ONLY the
ledger (`docs/*.md` + `docs/archive` + `docs/logs`; NEVER `docs/ledgers.yaml`,
gitignored; NEVER code, which lands on task branches) — at TWO points:
- **After every `archive_milestone`** (the sweep above, and each merge-back
  archive): commit immediately, so each completed milestone is a durable
  checkpoint. This ALWAYS fires, even when chained under `/advance`.
- **At this pass's STOP**, right after the §Handoff record write — but ONLY when
  run STANDALONE. When CHAINED under `/advance`, SUPPRESS the at-stop commit
  (the wrapper owns the single run-stop commit, mirroring the handoff
  suppression). The per-archive commits above still fire either way.

Mechanism (run from the ledger root):
```
git add docs/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- docs/ || git commit -q -m "chore(ledger): /implement:advance — <Mxx archived | stop: <status>>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes the commit a NO-OP when nothing
changed (idempotent). Scope `git add` to the ledger artifacts only — never
`git add -A`.

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

---

## Handoff record (STANDALONE only — suppressed when chained)

> **Your stop is PROGRESS-bounded, never EFFORT-bounded.** Stop ONLY when this
> flow's own stop predicate fires — the READY-SET is empty, every remaining task
> is blocked on an `open` user question, or the criticism loop hit an ill-loop
> bailout — NEVER because the run is long, costly, used many worker waves,
> reached "a natural milestone", or the remaining work feels disproportionate.
> The handoff status you write is the gate: one of `drained` / `answers-required`
> / `mixed` / `illness-detected`, each requiring a real predicate condition —
> there is no status for an effort-based stop. If tempted to stop while a task is
> still READY (or a criticism round is still converging), CONTINUE. (See
> llm/commands/advance.md §Stop condition.)

Whether you write a `handoffs` record at your stop depends ENTIRELY on your
invocation context — there is **no env var or process signal** to read. You,
the executing agent, run both this command and (when chained) the wrapping
`/advance` command in the SAME inline session, so you already KNOW which
context you are in.

- **Run STANDALONE** (the user invoked `/implement:advance` directly, with no
  wrapping flow command): after the §Report, write ONE `handoffs` record for
  this stop — `create_item("handoffs", <milestone>, <status>, <fields>)` —
  mapping your end-of-pass classification to the handoff `status`:

  | This pass's stop                                                       | handoff `status`   |
  | ---------------------------------------------------------------------- | ------------------ |
  | ready-set drained, all reachable tasks merged / milestone(s) archived  | `drained`          |
  | task(s) `blocked` on an `open` reviewer/ill-loop question              | `answers-required` |
  | both at once — some tasks merged, others blocked on questions          | `mixed`            |
  | an ill-loop bailout / merge-conflict / invariant violation you could not get past | `illness-detected` |

  Field set (per `HANDOFFS_SCHEMA`; consistent with advance.md §Provenance):
  `summary` (**required** — the why-it-stopped prose, mirror the §Report);
  `flow` = `implement`; `ledgerRefs` = the stop-causing items (`tasks:<id>`,
  `goals:<G>`); `blockingQuestions` = the `open` question ids for an
  `answers-required`/`mixed` stop; `handoffReasons` = the component reasons for
  a `mixed` stop (e.g. `[drained, answers-required]`); `sessionLogs` = the
  `docs/logs/<ts>-<agent-id>.md` path(s) written this pass — populate them in
  the SAME `create_item` call. Stamp `author`/`session`. Append-only: written
  once at the stop, never updated. **Then commit the ledger** (§Commit the
  ledger, at-stop commit) — this is the final act of the standalone pass.

- **Run CHAINED INLINE by any wrapping flow command** (`/advance`, or a
  `/<flow>:start` that runs this pass inline):
  **SUPPRESS this handoff write** — AND suppress the at-stop ledger commit (the
  outermost wrapper owns both). The per-archive ledger commits (§Commit the
  ledger) still fire. The outermost wrapper owns the single
  authoritative run-level handoff and writes it once at its stop — `/advance`
  per its §Provenance (it is the sole `handoffs` writer for the whole run);
  a `/<flow>:start` writes it directly in its own §Handoff record step. You can
  tell you are in this context because the wrapping command explicitly chains you
  and its prompt instructs this suppression; a standalone invocation has no such
  wrapper. Suppressing here is what guarantees exactly ONE handoff per run —
  never a duplicate.
