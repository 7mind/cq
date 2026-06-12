---
description: Advance an implement-flow run one full pass — pick DAG-ready tasks, implement each in an isolated worktree, adversarially review, autonomously fix criticism, register user questions, and merge back in dependency order.
argument-hint: [milestoneId ...]   # optional; omit to resume the in-progress run
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "optional milestone ids ($ARGUMENTS); empty = all non-archived non-terminal milestones with non-terminal tasks"
  - "ledger task state: status, dependsOn, suggestedModel, open questions per task"
  - "git worktrees for in-progress tasks (idempotent resume)"
outputs:
  - "task status transitions: planned->wip->done (or blocked/open-question registered)"
  - "one reviews item per task (written by reviewer subagent or orchestrator)"
  - "merged commits on base branch via rebase-merge (conflict-resolver dispatched on conflict)"
  - "per worker/reviewer/conflict-resolver: a summary log .cq/logs/<timestamp>-<agent-id>.md AND a raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl, BOTH written via `cq log put`"
  - "handoffs item (standalone only) and ledger git commit (standalone only)"
ioSchema:
  - "ready-set: tasks status non-terminal and not blocked, all dependsOn done, milestone dependsOn satisfied, no open question"
  - "worker dispatch: isolation=worktree, branch=implement/<taskId>, up to N=8 concurrent"
  - "worker result JSON: {taskId, status, resultCommit, branch, filesTouched, checkSummary, summary, blockedReason?}"
  - "reviewer result JSON: {taskId, verdict, criticism[], questions[], defects[], rationale, summary?}"
  - "criticism loop: re-dispatch worker with prior criticism until verdict=approve or questions filed"
```

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
Each subagent ends its reply with a `### Session summary` block. **ALL log writes
go through `cq log put` under BOTH backends — never a direct `Write` to
`.cq/logs/`, and never `git add` a log file** (`cq log put` does redaction +
strict-JSONL validation IN the CLI, and under `git-object` commits the log to the
orphan ref itself; under `fs` it writes the file under `.cq/logs/`, which the
per-merge ledger checkpoint already carries). Stamp `<timestamp>` (`Bash`: `date
-u +%Y%m%d-%H%M%S`) once per returned subagent.

**Native `Agent` subagent (worker / reviewer / conflict-resolver).** Take
`<agent-id>` from the tool result, then:
1. **Locate its native transcript** at
   `~/.claude/projects/<slug>/<session>/subagents/agent-<agent-id>.jsonl` — the
   `<slug>` is derived from the ledger root path (Claude's project-dir slug; the
   absolute ledger-root path with `/` → `-`), and `<session>` =
   `$CLAUDE_CODE_SESSION_ID`.
2. **Pipe the transcript through `cq log put`** for redaction + strict-JSONL
   validation in the CLI:
   `cat <transcript> | cq log put --stdin --dest logs/raw/<timestamp>-<agent-id>.jsonl`.
3. **Write the summary** (a short header — task id, role, returned status/verdict
   — plus the verbatim `### Session summary` block) via `cq log put` to
   `logs/<timestamp>-<agent-id>.md` (e.g. compose the header+summary to a temp
   file or pipe via `--stdin --dest logs/<timestamp>-<agent-id>.md`).
4. **Record BOTH paths on the task item**: `sessionLogs +=` the
   `.cq/logs/<timestamp>-<agent-id>.md` summary path; `rawLogs +=` the
   `.cq/logs/raw/<timestamp>-<agent-id>.jsonl` raw path (§Record, §7.3).

**Absent transcript (older run / crash / non-Claude harness).** When the
`agent-<agent-id>.jsonl` file does not exist, do NOT fabricate a raw log: write an
explicit `raw transcript unavailable: <reason>` line in the summary-log HEADER
(via `cq log put` to `logs/<timestamp>-<agent-id>.md`) and proceed summary-only —
add ONLY the `.md` to `sessionLogs`, leave `rawLogs` un-extended for that subagent.

**`pi:*` shellout reviewer (§3b).** There is no native `Agent` id and no
`.jsonl` transcript — the verbatim shellout **stdout IS the raw log**. Route it
through `cq log put` to a PLAIN/markdown dest (NOT `.jsonl`):
`… | cq log put --stdin --dest logs/raw/<timestamp>-pi-<alias>.md` — the
reviewer's VERBATIM stdout (the raw, possibly fence-wrapped json). Capture this
even when its stdout was unparseable (so a failed external reviewer leaves a
trace). Also write a summary `.md` (header: task id, role `implement-reviewer
(pi:<harness>:<model>)`, parsed verdict) via `cq log put` to
`logs/<timestamp>-pi-<alias>-<taskId>.md`. Add the summary `.md` to the task's
`sessionLogs` and the raw `logs/raw/<timestamp>-pi-<alias>.md` to its `rawLogs`
(§Record, §7.3).

---

## Auto-fetch the ledger ref at run START (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`** (NOT the default `fs`
backend), auto-fetch the orphan ledger branch from the configured remote ONCE at
the very start of the run, BEFORE the first pass below — so the run reads the
latest shared ledger state. When the backend is `fs` (the default, or no
`cq.toml`), SKIP this step entirely; it does NOTHING on the filesystem backend.
**Suppress this fetch when chained** under a wrapping flow command (`/cq:advance`
/ `/cq:implement:start`) — the wrapper owns the single run-START fetch (mirroring
the at-stop handoff/commit suppression); run it only on a STANDALONE
`/cq:implement:advance` invocation.

The remote name comes from `[ledger] remote` (default `origin`); the ledger
branch is `cq-ledger` (`[ledger] branch`, default `cq-ledger`). Run from the
ledger root (the MCP `--cwd`):
```
git fetch <remote> refs/heads/cq-ledger:refs/heads/cq-ledger
```
**Single-branch / shallow clones must fetch this ref EXPLICITLY** — it is an
orphan branch outside the normal fetch refspec (see the runbook,
`docs/drafts/20260610-1300-orphan-ledger-runbook.md`). A non-fast-forward fetch
failure means the local ref diverged from the remote — STOP and follow the
runbook's divergence recovery rather than forcing the ref.

## The pass (repeat until no task is ready)

### 1. Derive the READY-SET (purely from the ledger)
For each target milestone, `list_milestone_items` and collect its `tasks`. Also
read the `questions` ledger items linked `tasks:<id>` and the milestones' own
`dependsOn`/`blockedBy`.

**Start-of-pass worktree prune sweep (G38-1a-start-sweep).** <!-- G38-1a-start-sweep -->
This is the SAME generalized cleanup recipe `/cq:advance` runs at run-stop
(`commands/cq/advance.md` §End-of-run worktree/branch cleanup sweep, marker
`G38-1a-end-sweep`) — keep the two in sync, do not let them diverge.
Before deriving the ready-set, prune orphaned and locked worktrees left by prior
interrupted runs. Run `git worktree prune` (clears stale administrative entries).
Then enumerate **ALL** worktrees under the implement worktree root with
`git worktree list --porcelain` — this sweep covers BOTH `implement/*` worktrees
AND Claude's native `worktree-agent-<8hex>` worktrees (the harness names a
worktree-isolated subagent's tree `worktree-agent-*`; a stale one outlives its
agent after an interrupted run). For each enumerated worktree, derive its branch
from the porcelain `branch refs/heads/<name>` line (or
`git -C <wt> rev-parse --abbrev-ref HEAD`).

REMOVE a worktree ONLY when the conservative **merged-OR-terminal safety key**
holds — i.e. its branch is EITHER:
- **(a) fully merged** into base/main — the branch appears in
  `git branch --merged <base>` (its work already landed); OR
- **(b) bound to a TERMINAL ledger task** — an `implement/<taskId>` whose
  `<taskId>` is `done` or `abandoned` in the ledger.

When the key holds, remove it (unlock first — a native worktree may be locked):
```
git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D <branch>
```
Finish the whole sweep with a closing `git worktree prune`.

**HARD SAFETY GUARDS (obey these literally):**
- **NEVER** touch `main` or the `cq-ledger` orphan branch, nor any worktree
  bound to either — they are off-limits regardless of merge/terminal state.
- **NEVER** remove a worktree whose bound task is still `wip` or `blocked` —
  those hold in-progress / paused work that §2 (dispatch) and §5
  (questions/blocked) rely on for resumption. Terminal (`done`/`abandoned`)
  tasks ONLY for the (b) path.
- A `worktree-agent-*` worktree whose agentId has **NO stable ledger link**
  (cannot be tied to any task) is removed **ONLY if its branch is fully merged
  into base/main** (the (a) path — its work already landed). NEVER remove such a
  worktree when it carries unmerged commits and cannot be tied to a terminal
  task — preserve it intact.

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
concurrently. Record each worker's session log on return via `cq log put` (§Session logs).

**Catalog-driven dispatch (G41 — implement-worker).** Drive each
`implement-worker` dispatch through the typed prompt-catalog MCP tools the
ledger-mcp server added in T343 (`fetch_prompt` / `validate_input` /
`validate_output`), MIRRORING the a–g sequence `commands/cq/plan/advance.md`
sub-step 1a established for `plan-advance`: **(a)** `fetch_prompt("implement-worker")`
for its `promptTemplate` + typed `inputSchema`/`outputSchema` (present — a
dispatched subagent); **(b–c)** compose the input against that `inputSchema`
(`{ taskId, headline, description, acceptance, worktreePath, branch, baseCommit,
priorCriticism? }`); **(d)** `validate_input("implement-worker", input)`, fix and
re-validate on `{ ok: false, errors }`; **(e)** dispatch the `Agent`
(`subagent_type: "implement-worker"`, resolved `model`, `isolation: "worktree"`)
with the validated input rendered into the prompt; **(f–g)** await its result and
`validate_output("implement-worker", output)` against the role's `outputSchema`
(a validation failure is a contract breach to surface, §Session logs). **Degrade
gracefully when the catalog tools are absent** (an older / embedded ledger-mcp
that predates T343) — skip (a)–(d) and (g) and fall straight through to the bare
`Agent` dispatch (e). The validate steps are an ADDITIVE contract check, never a
hard dependency — their absence never blocks the pass.

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
  `env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session --provider <P> --model <M> '<prompt>' </dev/null`
  (grok-build → `--provider grok-build --model grok-build`; gpt-5.5 →
  `--provider openai-codex --model gpt-5.5`; map from the reviewer's
  `harness`/`model`/`alias`). **The `env -u CODEX_COMPANION_SESSION_ID -u
  CLAUDE_PLUGIN_DATA … </dev/null` wrapper is REQUIRED, not cosmetic:** launched
  from inside this session pi inherits the codex-inline companion env and BLOCKS
  INDEFINITELY on the companion handshake when that companion is down (a real,
  output-less hang — verified); stripping that env and detaching stdin makes pi
  run standalone and FAST-FAIL on real errors instead — a quota-exhausted /
  unauthorized provider then exits non-zero with the error on stderr and empty
  stdout (e.g. openrouter `402 Insufficient credits`, exit 1, ~2s), which the
  abstention rule (3c) catches. The `<prompt>` feeds the SHARED `/cq:implement-review`
  rubric (`commands/cq/implement-review.md`, T174) PLUS the task acceptance, the
  worktree diff (`base..HEAD`), and the latest `bun run check` output. `pi` runs
  in default text mode; parse the (possibly fence-wrapped) json from its stdout.

**Catalog-driven dispatch (G41 — implement-reviewer).** Drive each NATIVE
`claude:*` `implement-reviewer` `Agent` dispatch (3a single-native fallback and
each `claude:*` panel member in 3b) through the typed prompt-catalog MCP tools,
MIRRORING the a–g sequence `commands/cq/plan/advance.md` sub-step 1a established
for `plan-advance`: **(a)** `fetch_prompt("implement-reviewer")` for its
`promptTemplate` + typed `inputSchema`/`outputSchema` (present — a dispatched
subagent); **(b–c)** compose the input against that `inputSchema` (`{ taskId,
acceptance, worktreePath, branch, baseCommit, workerResult, round,
priorCriticism? }`); **(d)** `validate_input("implement-reviewer", input)`, fix
and re-validate on `{ ok: false, errors }`; **(e)** dispatch the `Agent`
(`subagent_type: "implement-reviewer"`, most-capable `opus`); **(f–g)** await its
verdict and `validate_output("implement-reviewer", output)` against the role's
`outputSchema` (a validation failure is a contract breach to surface, §Session
logs). **Degrade gracefully when the catalog tools are absent** — skip (a)–(d)
and (g) and fall straight through to the bare `Agent` dispatch (e). The validate
steps are an ADDITIVE contract check, never a hard dependency. (The `pi:*` panel
members are EXTERNAL shellouts driving the shared `/cq:implement-review` rubric,
not `Agent` dispatches of this catalog role — they are out of this catalog
validate-in/out path; their stdout-json is parsed and reconciled as 3b/3c
describe.)

Every reviewer — native `implement-reviewer` and the shared `/cq:implement-review`
rubric driving `pi` — returns the SAME byte-identical contract: `{ taskId,
verdict: "approve" | "disapprove", criticism: [], questions: [], defects: [...],
rationale, summary }`. Tag each parsed result with its source reviewer
(`harness:model`/`alias`) for the reconciliation step. **A reviewer that fails
to return a usable verdict ABSTAINS** — a `pi` shellout that exits non-zero,
emits empty stdout, or yields stdout that does not parse (after fence-strip)
into the verdict contract, OR a native `claude:*` reviewer that returns no /
garbled json — is DROPPED from the panel for this task: it is NOT counted as
`approve` and NOT counted as `disapprove` (an abstention is a panel-membership
change, not a vote). Log its raw stdout + the abstention reason (alias + cause)
per §Session logs, and proceed to reconcile over the reviewers that DID return a
usable verdict. **No wall-clock timeout is imposed** (decision: abstention keys
ONLY on a RETURNED failure — non-zero exit, empty, or unparseable; a genuinely
hung shellout surfaces as an operational stall to handle directly, never a
silent abstention). A quota-exhausted / unauthorized / unavailable reviewer
therefore drops out and the available reviewers still gate the task — it does
NOT block a task the rest of the panel approved.

**3c. RECONCILE the panel — STRICTEST-WINS + UNION (Q91).** Fold the panel's
per-reviewer json into ONE reconciled verdict that drives the criticism loop
(§4), the success gate (§6), and the single recorded `reviews` item (§Record):
- **Reconcile over SURVIVORS (abstainers excluded).** The panel for
  reconciliation is the reviewers that returned a usable verdict in 3b; any that
  ABSTAINED (failed / empty / unparseable) is excluded from BOTH the verdict and
  the union — it is not a vote.
- **Quorum floor (all-abstain fallback).** If EVERY configured reviewer
  abstained (zero usable verdicts), fall back to the SINGLE native
  `implement-reviewer` Agent (`subagent_type: "implement-reviewer"`, `opus`) —
  the always-available default — and use its verdict as the reconciled result;
  REPORT that the configured panel was unavailable this pass (which aliases
  abstained + why). The flow NEVER blocks on an unavailable panel and NEVER
  approves with zero successful reviewers.
- **Off-enum verdict ⇒ ABSTENTION (fail-loud, BEFORE reconcile).** After
  parsing the verdict contract, VALIDATE the `verdict` string against the
  closed implement-review enum `{approve, disapprove}` (the literal enum in
  `commands/cq/implement-review.md`). If `verdict` is NOT EXACTLY `approve`
  or `disapprove`, treat that reviewer as ABSTAINING — DROP it from the panel
  (not counted `approve`, not counted `disapprove`), exactly as the
  abstention rule above drops an unparseable verdict, and LOG it with the
  reviewer's alias + the raw off-enum value + cause (§Session logs). Do
  NOT normalize or recover synonyms — an off-enum value is an ABSTENTION,
  NEVER a value to coerce into a canonical enum (silent coercion would
  defeat the fail-loud contract). This validation runs BEFORE the
  strictest-wins reconcile match (§3c) so an off-enum value can never reach
  reconcile.
- **Verdict (strictest-wins, over survivors):** ANY surviving reviewer
  `disapprove` → the reconciled verdict is `disapprove`. The reconciled verdict
  is `approve` ONLY when ALL surviving reviewers `approve` AND the worker's
  latest `bun run check` is green.
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
user to `/cq:investigate <D>`, AND do NOT file a `questions` item asking
whether/how/when to fix it (fix-vs-wontfix, out-of-scope/pre-existing,
external-API or blast-radius disposition) (K13 — `questions` are reserved for
genuine user *requirements* decisions, not routing pointers and not
fix-disposition prompts; `wontfix` is user-initiated only).** The defect is self-contained: its
`ledgerRefs` link it to the task and goal, and `/cq:investigate` accepts a
bare defect id (`^D\d+$` resume path) so any open defect is directly actionable
via ledger query without a pointer question. **Implement:* does NOT auto-launch
investigate inline (Q43) — that is plan:*'s responsibility, since implement:* is
an execution flow, not a planning flow. The filed defect will be triaged by the
next /cq:plan:advance cycle's auto-investigate phase, or by a direct user
/cq:investigate <D>.** Do NOT block, fail, or re-dispatch the current task on
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
answers. The user answers in the TUI/web, then re-runs `/cq:implement:advance` to
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
   **Catalog-driven dispatch (G41 — implement-conflict-resolver).** Drive this
   dispatch through the typed prompt-catalog MCP tools, MIRRORING the a–g sequence
   `commands/cq/plan/advance.md` sub-step 1a established for `plan-advance`:
   **(a)** `fetch_prompt("implement-conflict-resolver")` for its `promptTemplate`
   + typed `inputSchema`/`outputSchema` (present — a dispatched subagent);
   **(b–c)** compose the input against that `inputSchema` (`{ taskId, headline?,
   description?, worktreePath, branch, baseCommit, conflictingFiles, baseSideNote?
   }`); **(d)** `validate_input("implement-conflict-resolver", input)`, fix and
   re-validate on `{ ok: false, errors }`; **(e)** dispatch the `Agent`
   (`subagent_type: "implement-conflict-resolver"`, most-capable `opus`,
   `isolation: "worktree"`); **(f–g)** await its result and
   `validate_output("implement-conflict-resolver", output)` against the role's
   `outputSchema` (a validation failure is a contract breach to surface, §Session
   logs). **Degrade gracefully when the catalog tools are absent** — skip (a)–(d)
   and (g) and fall straight through to the bare `Agent` dispatch (e). The
   validate steps are an ADDITIVE contract check, never a hard dependency.
3. On a clean rebase (or resolved conflict) → fast-forward merge into the base,
   set `update_item("tasks", <id>, status: "done", fields: { resultCommit:
   "<merged sha>", completion: "<1-line: what landed>", sessionLogs:
   [".cq/logs/<ts>-<worker-agent-id>.md", ...], rawLogs:
   [".cq/logs/raw/<ts>-<worker-agent-id>.jsonl", ...] })` — include ALL
   summary-log paths (`sessionLogs`) AND all raw-transcript paths (`rawLogs`)
   written for this task (worker + reviewer rounds, §Session logs) in the SAME
   `update_item` call that marks the task `done`; do NOT defer `sessionLogs` /
   `rawLogs` to a separate update. (Omit a `rawLogs` entry for any subagent whose
   transcript was absent — that subagent is summary-only per §Session logs.) Then tear down the worktree <!-- G38-1a-post-done-cleanup -->
   (both Claude and Codex paths — run explicitly immediately after the `done`
   ledger write above):
   ```
   branch=$(git -C <wt> rev-parse --abbrev-ref HEAD); git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D "$branch"; git worktree prune
   ```
   **Why explicit?** Native `isolation: worktree` only auto-removes worktrees
   that have NO new commits since creation. A worker that committed its task IS
   changed, so the native teardown silently skips it — leaving the worktree and
   branch locked on disk. This was the source of ~140 stale locked worktrees
   accumulating under `.claude/worktrees/`. The explicit sequence above derives
   the actual branch name from the worktree itself (covering both the Codex
   `implement/<taskId>` and the native `worktree-agent-<8hex>` naming paths
   symmetrically), unlocks the worktree, removes it, deletes the derived branch,
   and prunes the worktree list.
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
5. **Commit the ledger after every task merge-back (ALWAYS fires, even when
   chained).** Right after the §7.3 `done` write (and the §7.4 defect closure,
   if any), commit the ledger artifacts — once per merged task — so a long
   chained run does NOT accrue a large uncommitted ledger between archives. This
   checkpoint OVERRIDES the chained-suppression: it fires under `/cq:advance`
   too, exactly like the after-archive commit. Use the idempotent commit form
   (ledger artifacts only — see §Commit the ledger). **When `[ledger] backend`
   is `fs` (the default); SKIP under `git-object`, whose orphan ref already
   carries each write:**
   ```
   git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
   git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:implement:advance — merged <Txx>

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
   ```

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
"goals:<G>"], sessionLogs: [".cq/logs/<ts>-<reviewer-agent-id>.md", ...],
rawLogs: [".cq/logs/raw/<ts>-<reviewer-agent-id>.jsonl",
".cq/logs/raw/<ts>-pi-<alias>.md", ...] })`.
The `criticism`/`new_questions` are the source-tagged UNION across the panel
(§3c); the `status` follows the reconciled verdict (`go-ahead` only when ALL
reviewers approved + green check, else `revise`). Include EVERY reviewer's
summary-log path (`sessionLogs`) AND raw-log path (`rawLogs`) written for this
task (the native-Agent `.md`+`.jsonl` pairs and the `pi` summary `.md` + raw
`.md` stdout logs, §Session logs) in the SAME `create_item` — do NOT defer them
to a separate update. (Omit a `rawLogs` entry for any reviewer whose transcript
was absent.) With a single configured/unconfigured reviewer this collapses
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
pass touched (and, in `/cq:advance`, over the whole `milestones` ledger). This is
the single authoritative predicate — `/cq:advance` (llm/commands/cq/advance.md) states
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

### Commit the ledger (after every task merge-back + after every milestone archive; at-stop only standalone)
The ledger files are tracked git artifacts. Commit the ledger — and ONLY the
ledger (`.cq/*.md` + `.cq/archive` + `.cq/logs`; NEVER `docs/ledgers.yaml`,
gitignored; NEVER code, which lands on task branches) — at THREE points, of
which TWO ALWAYS fire (even chained) and ONE is suppressed when chained:
- **(ALWAYS) After every task merge-back** (§7.5): commit immediately once per
  merged task, right after its `done` write + defect closure, so a long chained
  run does NOT accrue a large uncommitted ledger between archives. This ALWAYS
  fires, even when chained under `/cq:advance` — the chained-suppression does
  NOT apply to this checkpoint.
- **(ALWAYS) After every `archive_milestone`** (the sweep above, and each
  merge-back archive): commit immediately, so each completed milestone is a
  durable checkpoint. This ALWAYS fires, even when chained under `/cq:advance`.
- **(SUPPRESSED WHEN CHAINED) At this pass's STOP**, right after the §Handoff
  record write — but ONLY when run STANDALONE. When CHAINED under `/cq:advance`,
  SUPPRESS the at-stop commit (the wrapper owns the single run-stop commit,
  mirroring the handoff suppression). The two ALWAYS-fire checkpoints above
  (after every task merge-back + after every milestone archive) still fire
  either way.

Mechanism — **when `[ledger] backend` is `fs` (the default); SKIP under
`git-object`, whose orphan ref already carries each write** (run from the ledger
root — same idempotent form at every checkpoint, only the `-m` message differs):
```
git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:implement:advance — <merged <Txx> | <Mxx> archived | stop: <status>>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes the commit a NO-OP when nothing
changed (idempotent). Scope `git add` to the ledger artifacts only — never
`git add -A`.

### Auto-push the ledger ref at run END (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`**, auto-push the orphan
ledger branch to the configured remote ONCE at the STANDALONE pass STOP,
immediately after the standalone at-stop ledger commit above. When the backend
is `fs` (the default), SKIP this step. This is a once-per-run push (NOT
per-write, NOT per-merge-back) — the symmetric partner of the run-START fetch.
**SUPPRESS this push when chained** (`/cq:advance` / `/cq:implement:start`)
exactly as the at-stop commit is suppressed — the outermost wrapper owns the
single run-END push.

The remote name comes from `[ledger] remote` (default `origin`). Run from the
ledger root:
```
git push <remote> cq-ledger
```
This is a **PLAIN, NON-FORCED push** — deliberately **NO `--force`**. If the
remote `cq-ledger` has diverged since this run's START fetch, the push is
REJECTED and **FAILS LOUDLY** (non-fast-forward) rather than silently
overwriting. The local CAS `update-ref` already guards against lost updates
within this checkout; the non-forced push guards against clobbering another
checkout's pushed updates. On a rejected push, DO NOT add `--force` — follow the
runbook (`docs/drafts/20260610-1300-orphan-ledger-runbook.md`): fetch, inspect
`git log cq-ledger`, reconcile, then retry the plain push.

## Report to the user
Summarize the pass concisely:
- tasks **merged** this pass (id + resultCommit);
- tasks **blocked** on questions (id + the question ids to answer);
- tasks **failed**/skipped and why;
- whether any milestone was archived;
- whether goal `G` is **ready to close** (all work milestones archived) —
  instruct the user to close it in the TUI/web (set status to `done`);
- the next action: if anything is `blocked`, "answer the listed questions in the
  TUI/web, then run `/cq:implement:advance` to resume"; if all done, say so.

---

## Handoff record (STANDALONE only — suppressed when chained)

> **Your stop is PROGRESS-bounded, never EFFORT-bounded.** Stop ONLY when this
> flow's own stop predicate fires — the READY-SET is empty, every remaining task
> is blocked on an `open` user question, or the criticism loop hit an ill-loop
> bailout — NEVER because the run is long, costly, used many worker waves,
> reached "a natural milestone", or the remaining work feels disproportionate.
> The handoff status you write is the gate: one of `drained` / `answers-required`
> / `user-action-required` / `mixed` / `illness-detected`, each requiring a real
> predicate condition — there is no status for an effort-based stop. If tempted
> to stop while a task is still READY (or a criticism round is still converging),
> CONTINUE. (See llm/commands/cq/advance.md §Stop condition.)

Whether you write a `handoffs` record at your stop depends ENTIRELY on your
invocation context — there is **no env var or process signal** to read. You,
the executing agent, run both this command and (when chained) the wrapping
`/cq:advance` command in the SAME inline session, so you already KNOW which
context you are in.

- **Run STANDALONE** (the user invoked `/cq:implement:advance` directly, with no
  wrapping flow command): after the §Report, write ONE `handoffs` record for
  this stop — `create_item("handoffs", <milestone>, <status>, <fields>)` —
  mapping your end-of-pass classification to the handoff `status`:

  | This pass's stop                                                       | handoff `status`   |
  | ---------------------------------------------------------------------- | ------------------ |
  | ready-set drained, all reachable tasks merged / milestone(s) archived  | `drained`          |
  | task(s) `blocked` on an `open` reviewer/ill-loop question              | `answers-required` |
  | a SPECIFIC task whose next physical step is exclusively the user's — provision a credential, re-activate an environment, or run a privileged/external command the agent cannot run — AND every autonomous step for that task is already done; name the exact command/action AND the exact item it unblocks (if you cannot name both, it is NOT this status — CONTINUE); this is a user ACTION, not a question answer — no `open` `questions` item is required | `user-action-required` |
  | both at once — some tasks merged/drained, others blocked on a question and/or a user action; list both components in `handoffReasons` (e.g. `[drained, answers-required, user-action-required]`) | `mixed`            |
  | an ill-loop bailout / merge-conflict / invariant violation you could not get past | `illness-detected` |

  Field set (per `HANDOFFS_SCHEMA`; consistent with advance.md §Provenance):
  `summary` (**required** — the why-it-stopped prose, mirror the §Report);
  `flow` = `implement`; `ledgerRefs` = the stop-causing items (`tasks:<id>`,
  `goals:<G>`); `blockingQuestions` = the `open` question ids for an
  `answers-required`/`mixed` stop; `handoffReasons` = the
  component reasons for a `mixed` stop (e.g. `[drained, answers-required]` or
  `[drained, answers-required, user-action-required]`; Q140); `sessionLogs` = the
  `.cq/logs/<ts>-<agent-id>.md` summary path(s) AND `rawLogs` = the
  `.cq/logs/raw/<ts>-<agent-id>.jsonl` raw-transcript path(s) written this pass —
  populate them in the SAME `create_item` call (omit a `rawLogs` entry for any
  subagent whose transcript was absent). Stamp `author`/`session`. Append-only: written
  once at the stop, never updated. **Then commit the ledger** (§Commit the
  ledger, at-stop commit) — this is the final act of the standalone pass.

  **TURN-vs-RUN clause (D39).** A RUN and a TURN are distinct scopes. A **RUN**
  spans as many turns as needed and is durably resumable from ledger state on the
  next `/cq:implement:advance` invocation — the ledger IS the durable resume
  point. A **TURN** is a single context window; exhausting the turn/context
  budget is **NOT a run-stop**. When a turn/context budget is exhausted
  mid-stride, the agent **STOPS WITHOUT writing a handoff** — no `handoffs`
  record, no `mixed`/effort terminal artifact — because the ledger already
  captures every durable state change. The next `/cq:implement:advance` reads
  ledger state and continues from where the previous turn left off. Contrast: a
  **RUN-stop** = one of the five predicate-gated handoff statuses; a
  **TURN-pause** = no artifact, just resume next invocation. Fabricating a
  terminal handoff record to "wrap up" a turn that ran out of budget is the same
  forbidden launder as an effort-based stop — there is deliberately **NO handoff
  status for an effort-based stop**, and turn exhaustion is an effort-based fact,
  not a predicate-gated one.

  **A TURN-pause is NOT a free escape hatch (D41 — hard gate).** The TURN-pause
  exists ONLY for GENUINE, EXTERNALLY-EVIDENCED context/turn exhaustion (an
  explicit harness context-window / compaction warning, or a tool result
  truncated/refused for length) — NEVER a SUBJECTIVE judgment that you have
  "done enough" or that the work ahead is big. While this command's stop
  predicate has not fired the default is **CONTINUE**; you do not get to pause
  "to be safe", "for quality", or "to do it justice". FORBIDDEN TURN-pause
  rationales (each the SAME laundered effort/magnitude stop the euphemism
  blocklist bans, merely via the no-handoff channel — citing ANY makes the pause
  ILLEGAL, CONTINUE): "the next/remaining work is large / multi-task /
  high-blast-radius"; "needs / warrants fresh context / full headroom / a clean
  slate"; "I've done substantial work this turn / long session / many subagents";
  "a clean boundary / natural checkpoint"; "running it now risks a half-finished
  state" (the flow is per-item durable — partial progress is the DESIGN).
  Magnitude, accumulated effort, and a desire for fresh context are EFFORT-BASED
  FACTS, not context-exhaustion signals.

  **Euphemism blocklist + self-check invariant (D39 + D41).** Before EITHER
  writing a handoff record OR taking a TURN-pause (stopping with no handoff), scan
  your own about-to-be-emitted stop rationale — the handoff `summary` OR the
  turn-pause explanation you would give the user — for the phrases "NOT a
  predicate-legal stop", "predicates still TRUE", any equivalent admission the
  stop is non-predicate-gated, OR any FORBIDDEN turn-pause rationale above
  (magnitude, "fresh context/headroom", "done a lot / long session", "clean
  boundary", "half-finished risk"). If any appears — i.e. if your own rationale
  concedes **predicates still TRUE**, or rests on effort / magnitude / freshness
  rather than an externally-evidenced context limit — the stop is ILLEGAL by your
  own admission: **delete the draft, do NOT stop, and CONTINUE** the pass. A summary
  that contains "predicates still TRUE" is self-refuting; the correct action is
  to **delete** the draft entry and **CONTINUE**, never to file it. The following
  phrases, when used to justify a stop, are euphemisms for effort-based stops
  (cited from HO22/HO25/HO26 as laundering patterns found there); each is
  explicitly forbidden as a stop rationale — if any appears in a candidate
  `summary`, treat it as evidence of "predicates still TRUE" and **delete** and
  **CONTINUE**:
  - **"deliberate/transparent checkpoint"** — an effort-stop dressed as intentionality;
  - **"warrants fresh context"** — an effort-stop dressed as a quality concern;
  - **"BREAKING/large/delicate change needs care"** — an effort-stop dressed as caution;
  - **"a complete vertical slice is a clean boundary"** — an effort-stop dressed as scope hygiene.

  **Enforced-invariant (D39 — write-time enforcement).** The `@cq/ledger`
  `create_item` for `handoffs` THROWS if these buckets are empty when their
  status requires them: a `mixed` or `answers-required` handoff MUST carry a
  non-empty `blockingQuestions[]`; a `user-action-required` or `mixed` handoff
  MUST carry a non-empty `handoffReasons[]`. An empty-bucket effort-stop is
  literally UNWRITABLE — the ledger rejects it at write time. The only
  remediation is to either populate the required fields with their genuine
  predicate-gated content (real blocking question ids, real user-action reasons)
  — which the predicates will ONLY supply if the stop is legitimate — or to
  **not stop and CONTINUE** the pass instead.

- **Run CHAINED INLINE by any wrapping flow command** (`/cq:advance`, or a
  `/<flow>:start` that runs this pass inline):
  **SUPPRESS this handoff write** — AND suppress the at-stop ledger commit (the
  outermost wrapper owns both). The per-archive ledger commits (§Commit the
  ledger) still fire. The outermost wrapper owns the single
  authoritative run-level handoff and writes it once at its stop — `/cq:advance`
  per its §Provenance (it is the sole `handoffs` writer for the whole run);
  a `/<flow>:start` writes it directly in its own §Handoff record step. You can
  tell you are in this context because the wrapping command explicitly chains you
  and its prompt instructs this suppression; a standalone invocation has no such
  wrapper. Suppressing here is what guarantees exactly ONE handoff per run —
  never a duplicate.
