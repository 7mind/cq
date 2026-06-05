---
description: Advance an investigate-flow run one research round — read defect state, form/extend the hypothesis tree, dispatch read-only explorers, validate every citation against source, adjudicate node status, and on a confirmed root cause file-and-defer the fix to plan-flow.
argument-hint: <defectId>   # the defect D under investigation
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

You are the **investigate-flow orchestrator** — the DFS/adjudication brain of the
research loop. You are given a defect id **D** (`$ARGUMENTS`, first token). You
own hypothesis formation, explorer dispatch, citation validation, and node
adjudication; subagents CANNOT spawn subagents, so the whole loop lives HERE in
the main session.

**This command is idempotent and fully resumable** — it re-derives ALL state
from the ledger on each invocation (the defect, its `hypothesis` tree, its linked
`questions`). Run it repeatedly; each invocation picks up exactly where the
durable ledger state left off. **ONE invocation = ONE research round.**

## Conventions this command obeys (decision K8)
- **The tree IS the `hypothesis` ledger.** Each node is a `hypothesis` item;
  `parentHypothesis` encodes ancestry; `evidence[]` holds validated citations,
  each prefixed `[correct]`/`[incorrect]` (the research-loop E-item convention);
  `status` is `open|uncertain|confirmed|wrong` (terminal: `confirmed`/`wrong`);
  every node `ledgerRefs` its defect `defects:<D>`.
- **The COMMAND owns the loop.** `investigate-explorer` is a READ-ONLY
  evidence-gatherer — it makes no ledger writes and does NOT adjudicate. There is
  NO separate reviewer subagent: this command validates citations and sets node
  status itself (mirroring how plan/implement keep the loop in the command).
- **Explorer concurrency (Q27):** dispatch explorers in PARALLEL **only** when
  seeding disjoint top-level (root) hypotheses. While DRILLING a single branch
  (a node and its children), dispatch **serially** — each child's framing
  depends on the parent's validated findings.
- **Explorer is READ-ONLY; the prober EXECUTES (Q89).** When an `investigate-explorer`
  cannot settle H by reading alone — it needs a thing RUN (the repro, `bun test`,
  a build, `git show`/`git blame`) — it does NOT run it; it returns a
  `probeRequest {what, why}` in its evidence-json. This command then dispatches an
  `investigate-prober` (the EXECUTION-capable sibling) into a **throwaway worktree**
  to run exactly that probe and return the SAME evidence-json shape (see step 4).
  The prober is **LOCAL-ONLY, NO network**, makes **NO persisted edits to the main
  checkout** (all writes confined to the discardable worktree), writes NOTHING to the
  ledger, and does NOT adjudicate — this command validates its citations and sets the
  hypothesis status, exactly as for an explorer. **Agent worktree isolation**
  (consistent with implement/advance.md): Claude → dispatch via `Agent` with
  `isolation: "worktree"` (native throwaway worktree, auto-removed); Codex → the
  orchestrator does `git worktree add ../wt-probe-<H> <branch>` before dispatch and
  `git worktree remove` after harvest. The worktree is ALWAYS removed after the
  evidence is harvested — harvest-then-discard.
- **The defect LIFECYCLE lives on the defect's STATUS, not on free-text
  markers.** The `defects` ledger status is `open → wip → {root-caused |
  inconclusive} → resolved | wontfix` (T116; terminal: `resolved`/`wontfix`;
  `root-caused`/`inconclusive` are non-terminal and re-openable to `wip`).
  **`wontfix` is USER-INITIATED ONLY** — the autonomous flow NEVER transitions a
  defect to `wontfix` and NEVER asks for that disposition; its only terminal
  target is `resolved` (via a fix), and the default disposition of every
  non-terminal defect is FIX. The
  investigate flow drives the NON-terminal part of that lifecycle by calling
  `update_item("defects", D, status: …)` — it NEVER encodes the lifecycle as
  `UNKNOWN`/`CONFIRMED`/`GROUNDED` tokens inside the `rootCause` field. The
  `rootCause` field is purely the free-text cause NARRATIVE (with citations); no
  status tokens. Transition legality (Q67): the map has **no `open →
  root-caused` edge** — `root-caused` is reachable ONLY from `wip`, so the flow
  MUST move an `open` defect to `wip` the moment investigation begins (step 1),
  then to `root-caused`/`inconclusive` at adjudication (step 4/5). A direct
  `open → root-caused` write throws `InvalidTransitionError`.
- **Handoff = file-and-defer**, never an inline plan loop (see step 5). On a
  confirmed root cause you set the defect `status: root-caused`, write
  `defects.rootCause`/`suggestedFix`, seed/extend a plan-flow goal, and STOP. You
  MUST NOT re-implement or invoke the planner↔plan-reviewer loop yourself. **Two
  contexts (K12):**
  - *Standalone* (`/investigate:start` run directly by the user): file the
    open question pointing at `/plan:advance <G>` and STOP — the user resumes
    manually.
  - *Auto-launched inside plan:*\*: this investigation was triggered by
    `/plan:advance` (K12 auto-investigate). File the goal and STOP; the parent
    plan-flow session automatically resumes `G` without requiring a fresh
    user-run `/plan:advance`.

## Provenance (every ledger write)
On every `create_item` / `update_item`, pass `author` = your OWN model class
(derived from runtime identity, never hardcoded — Claude Opus 4.8 (1M) →
`"opus-4.8[1m]"`; Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` =
`$CLAUDE_CODE_SESSION_ID` (or the Codex equivalent; omit if unavailable).

## Session logs (after EVERY subagent returns)
Each `investigate-explorer` **and** each `investigate-prober` ends its reply with a
`### Session summary` block. After each `Agent` call returns — explorer OR prober —
take `<agent-id>` from the tool result, stamp `<timestamp>` (`Bash`: `date -u
+%Y%m%d-%H%M%S`), `mkdir -p docs/logs`, and `Write`
`docs/logs/<timestamp>-<agent-id>.md` — a short header (defect id, hypothesis id,
`role: explorer` or `role: prober`, returned `lean`) plus the verbatim summary
block. **One log file per dispatched subagent**, so a hypothesis whose explorer
raised a `probeRequest` produces TWO logs this round (the explorer's, then the
prober's). Subagents write no file; you do.

---

## The research round (the six steps)

### 1. READ state (purely from the ledger)
`fetch_item("defects", D)` — read its `headline`/`description`/`severity` and any
existing `rootCause`/`suggestedFix`. Then derive the current tree:
- `search_items` / `fts_search` the `hypothesis` ledger for nodes whose
  `ledgerRefs` contain `defects:<D>`; reconstruct ancestry from
  `parentHypothesis`. Note each node's `status` and `evidence[]`.
- read the linked `questions` (items whose `ledgerRefs` contain `defects:<D>`):
  if an `open` question is still unanswered, the loop is parked on the user —
  skip to **Report** (resumable: the user answers in the TUI/web, then re-runs
  `/investigate:advance D`). If a previously-open question is now `answered`
  (non-empty `answer`), fold its answer into this round's framing and continue.

**Move the defect to `wip` the moment investigation begins.** If the defect's
status is still `open` and you are about to do real research this round (form
hypotheses / dispatch explorers — i.e. NOT parked on an unanswered question),
`update_item("defects", D, status: "wip")` BEFORE step 2. This is mandatory: the
transition map (Q67) has **no `open → root-caused` edge** — `root-caused` is
reachable ONLY from `wip` — so a later adjudication write of `root-caused` on a
still-`open` defect would throw `InvalidTransitionError`. Moving to `wip` here
makes the documented path `open → wip → {root-caused | inconclusive}` legal at
every edge. The transition is idempotent in effect: if the defect is already
`wip` (a prior round set it), leave it. Do NOT touch status when the round is
parked on a question (no research happens).

If a node is already `confirmed`, go straight to step 5 (the handoff may be
incomplete from a prior interrupted round — it is idempotent to redo).

### 2. FORM hypotheses (extend the tree)
Enumerate the DISTINCT candidate root causes consistent with current state:
- **Seed roots** — for each distinct top-level candidate root cause with no
  existing node, `create_item("hypothesis", <defectMilestone>, status: "open",
  fields: { headline: "<candidate root cause>", description: "<what would make
  this true>", ledgerRefs: ["defects:<D>"] })`. Roots have no `parentHypothesis`.
- **Drill children** — when an `uncertain` node needs decomposition, create child
  nodes with `parentHypothesis: <parentId>` (and the same `ledgerRefs:
  ["defects:<D>"]`), each a narrower sub-claim of the parent.
Pick the frontier to advance this round depth-first: prefer drilling the most
promising `uncertain` branch to a leaf before seeding more roots, but seed
several disjoint roots together when the tree is empty (step 3 dispatches them in
parallel).

### 3. DISPATCH read-only explorers
For each frontier hypothesis H to advance this round, dispatch an
`investigate-explorer` via `Agent` (`subagent_type: "investigate-explorer"`,
most-capable model — `opus`; NO worktree, it changes nothing). The prompt MUST
carry: H's id + statement (verbatim), the branch context (the defect, parent
hypothesis, sibling findings already validated, what to confirm or rule out), and
any specific leads (files/symbols/error strings/URLs).

**Parallelism rule (Q27):** issue the `Agent` calls for DISJOINT top-level
hypotheses being SEEDED in ONE message so they run concurrently. While DRILLING a
single branch, dispatch its children SERIALLY — wait for each explorer's
validated findings before framing the next child. Write each explorer's session
log on return (§Session logs).

**An explorer may return a `probeRequest` instead of (or alongside) settling H**
when it cannot adjudicate by reading alone — it needs something RUN. Do not run
the probe inline; handle it in step 4 by dispatching an `investigate-prober` into
a throwaway worktree (the prober runs read+execute and returns the same
evidence-json), then harvest its evidence through the same citation-revalidation
path.

### 4. VALIDATE citations + adjudicate (orchestrator-side)
The explorer's evidence is UNTRUSTED until you check it. A mis-cited `file:line`
is the dominant way the loop confirms the WRONG hypothesis, so re-open every
citation yourself:
- **If the explorer returned a `probeRequest` `{what, why}`** (it could not settle
  H by reading alone — it needs the repro / `bun test` / a build / `git
  show`/`git blame` RUN) **and you judge running it warranted for adjudicating H**,
  dispatch an `investigate-prober` via `Agent` (`subagent_type:
  "investigate-prober"`, `isolation: "worktree"`, most-capable model — `opus`).
  Under Claude the `isolation: "worktree"` gives a native throwaway worktree; under
  Codex the orchestrator `git worktree add ../wt-probe-<H> <branch>` before dispatch
  and `git worktree remove` after harvest. The prompt MUST carry: the `probeRequest
  {what, why}` verbatim, H's id + statement (verbatim), and the branch context (the
  defect, the base commit / branch the worktree was cut from, parent hypothesis,
  sibling findings already validated, what to confirm or rule out). The prober runs
  **read+execute** in that worktree and RETURNS the SAME evidence-json shape an
  explorer returns. **Scope guard (Q89):** probes are **LOCAL-ONLY, NO network**,
  and make **NO persisted edits to the main checkout** — every write stays confined
  to the discardable worktree. Write the prober's session log on return (§Session
  logs). **Harvest-then-discard:** harvest the prober's returned evidence through the
  EXISTING citation-revalidation path below (re-open each cited `file:line`, or
  re-run the cited command and compare its output), exactly as for an explorer; then
  the throwaway worktree is **always removed** after harvest (Claude: auto on Agent
  return; Codex: `git worktree remove ../wt-probe-<H>`). Treat the prober's evidence
  items identically to an explorer's in the bullets below. If you judge the probe
  NOT warranted (e.g. the request is out of scope, needs network, or H is already
  adjudicable), skip the dispatch and proceed with the explorer's evidence.
- For each returned evidence item, **re-open the cited `file:line` (Read) — or
  re-fetch the URL (WebFetch)** and compare the source against the explorer's
  `excerpt`. If the excerpt matches the source AND genuinely bears on H, store it
  into `hypothesis.evidence[]` prefixed **`[correct]`**; otherwise store it
  prefixed **`[incorrect]`** (wrong line, paraphrase that misrepresents source,
  or irrelevant). `update_item("hypothesis", H, fields: { evidence: [...],
  sessionLogs: ["docs/logs/<ts>-<explorer-agent-id>.md"] })` — include the
  explorer's session-log path in the SAME `update_item` that stores the evidence
  (the log file for this explorer was written in §Session logs above; use that
  path here). Do NOT defer `sessionLogs` to a separate update.
- **Adjudicate H's `status` from the `[correct]` items ONLY** (ignore
  `[incorrect]` evidence entirely): set `confirmed` when `[correct]` evidence
  establishes the root cause; `wrong` when `[correct]` evidence rules it out;
  `uncertain` when partial (then drill children next round, step 2). Leave `open`
  only if no usable evidence came back. `update_item("hypothesis", H, status:
  <verdict>)` — if you adjudicate in the same call, combine with the evidence
  update above: `update_item("hypothesis", H, status: <verdict>, fields: {
  evidence: [...], sessionLogs: ["docs/logs/<ts>-<explorer-agent-id>.md"] })`. (This is the HYPOTHESIS-tree vocabulary
  `open|uncertain|confirmed|wrong` — distinct from the defect STATUS below.)
- **Reflect the verdict onto the DEFECT's STATUS** (the lifecycle carrier — never
  free-text markers). The defect is already `wip` (set in step 1):
  - a node reached `confirmed` (the root cause is pinned) → proceed to step 5,
    which sets `update_item("defects", D, status: "root-caused")` (legal from
    `wip`) as part of the handoff;
  - this round investigated the tree but **pinned nothing** and no further
    branch is adjudicable from available evidence (every leaf `wrong`, or the
    tree is exhausted/blocked) → `update_item("defects", D, status:
    "inconclusive")` (legal from `wip`; re-openable to `wip` on a later round
    that finds a new lead). Then file the NEEDS-user-input question (step 6) if
    the user could unblock it.
  - more drilling is still warranted this/next round (`uncertain` leaves remain)
    → leave the defect at `wip`; do not write a non-terminal verdict yet.

### 5. CONFIRMED root cause → FILE-AND-DEFER handoff (NOT an inline plan loop)
The **seed gate** for file-and-defer is the defect STATUS: perform this handoff
**iff the defect is about to be `status == root-caused`** (a node reached
`confirmed`, so the root cause is pinned). Perform the handoff — and nothing
more. You MUST NOT run, re-implement, or invoke the planner↔plan-reviewer loop
inline; a command cannot run another command's loop, and inline duplication
contradicts the file-and-defer principle (K8 point 3 / Q26). The subsequent
USER-run `/plan:advance` round is what produces the reviewed fix tasks that
ledgerRef `defects:<D>` (Q25/Q26). Do this and STOP:

(a) **Set the defect STATUS to `root-caused` and write its fields.**
`update_item("defects", D, status: "root-caused", fields: { rootCause: "<the
confirmed root cause NARRATIVE — free text, with the [correct] citations that
establish it; NO UNKNOWN/CONFIRMED/GROUNDED status tokens>", suggestedFix: "<the
concrete fix the evidence points to>", sessionLogs: ["docs/logs/<ts>-<agent-id>.md",
...] })` — include ALL session-log paths written for this investigation round
(all explorer log files) in the SAME `update_item` call that sets `root-caused`.
Do NOT defer `sessionLogs` to a separate update. The `root-caused` status (legal
only from `wip`, set in step 1) is the lifecycle marker; the `rootCause` field
stays pure narrative.

(b) **Seed OR extend a plan-flow goal — defect-seeded.** Search the `goals`
ledger for a live goal already `ledgerRefs`-linked to `defects:<D>`.
- **none exists** → `create_milestone(title: "Plan: fix <short D>")` as **M**,
  then `create_item("goals", M, status: "planning", fields: { title: "Fix <short
  D>", description: "<goal text embedding the CONFIRMED ROOT CAUSE + suggestedFix
  verbatim>", ledgerRefs: ["defects:<D>"] })` as **G**.
- **one exists** → append the confirmed root cause + suggestedFix to its
  `description` (preserve existing text) and ensure `ledgerRefs` contains
  `defects:<D>`.

The goal is **defect-seeded**: because its description embeds the confirmed root
cause + suggestedFix and carries the `defects:<D>` ledgerRef, plan-flow has
NOTHING left to clarify. Per the **T35 decision (K8 point 4)**, a defect-seeded
goal SKIPS the clarifying round and proceeds straight to planning — the planner
prompt (T41) explicitly permits skipping clarification when a goal is
`defect-seeded`. Do NOT create the goal in `clarifying`; seed it ready to plan.

(c) **Hand back to the planner, and STOP.** File an `open` question linked to
the defect. Then STOP — this command does not advance G. The action depends on
context (K12):
- *Standalone* (`/investigate:start` run directly): the question text instructs
  the user to run **`/plan:advance <G>`**: `create_item("questions",
  <defectMilestone>, status: "open", fields: { question: "Root cause of <D>
  confirmed and a defect-seeded goal G is ready — run `/plan:advance G` to
  produce the reviewed fix tasks.", context: "<root cause + suggestedFix
  summary>", ledgerRefs: ["defects:<D>", "goals:<G>"] })`.
- *Auto-launched inside plan:*\* (K12): the parent plan session detects the
  confirmed goal and resumes it automatically — a manual `/plan:advance G` is
  NOT needed. File the same question for traceability, but note in its `context`
  that this investigation was auto-launched and the goal will be auto-resumed.

### 6. NEEDS user input → file an open question and STOP (resumable)
File a step-6 question ONLY when the investigation literally cannot proceed
without the user. The legitimate triggers are NARROW:
- **ambiguous/contradictory requirements** — the *intended behaviour* (WHAT the
  code should do / HOW the system must behave) is genuinely undetermined, so no
  root cause can be adjudicated until the user resolves the requirement;
- **a reproduction that cannot be produced from the repo** (needs data/state the
  repo doesn't contain);
- **missing external access/credentials** the investigation needs to proceed.

These are NOT step-6 questions — **CONTINUE** (and, on a confirmed cause,
file-and-defer per step 5) instead of filing one:
- **fix-vs-wontfix / whether-to-fix** a confirmed or known defect — the default
  disposition is ALWAYS FIX; never park a defect on a disposition question;
- **"out of scope" / "pre-existing"** — file the fix as a separate task, do not ask;
- **"this changes a versioned/external/public API"**, "wide blast radius",
  outward-facing, or hard-to-reverse — none of these is a user decision in an
  autonomous flow; fix it;
- **magnitude / proportion / cost** of the fix.

`wontfix` is a **user-INITIATED terminal status only**: the investigate flow
never transitions a defect to `wontfix` and never asks for it. A confirmed root
cause is ALWAYS file-and-deferred to a fix (step 5) — never parked on a
disposition question. "A decision only the user can make" means a *requirements*
decision (the first bullet above), NOT a disposition/scope/blast-radius decision.

When a legitimate trigger holds: `create_item("questions", <defectMilestone>,
status: "open", fields: { question: "<the blocking requirements/repro/access
question>", context: "<the tree state, what evidence is missing, what you
tried>", ledgerRefs: ["defects:<D>"] })` and STOP. Leave the `hypothesis` tree
INTACT (durable). The user answers in the TUI/web, then re-runs
`/investigate:advance D` — step 1 folds the answer back in and the loop resumes
exactly where it left off.

---

## Report to the user
Summarize the round concisely:
- hypotheses **seeded/drilled** this round (id + statement + new `status`);
- any **probes dispatched** this round (which H, what was run in the throwaway
  worktree, harvested-then-discarded);
- citations **validated** (`[correct]` vs `[incorrect]` counts per node);
- the defect's **STATUS** after this round (`wip` while drilling; `root-caused`
  when the cause is pinned; `inconclusive` when investigated but unpinned) and
  the documented path it followed (`open → wip → {root-caused | inconclusive}`);
- any node **confirmed** → the defect now `status == root-caused`, its
  `rootCause`/`suggestedFix`, the defect-seeded goal **G**, and the next action
  (K12):
  - *Standalone*: **"run `/plan:advance G`"** (file-and-defer; this command does
    NOT run it);
  - *Auto-launched inside plan:*\*: the parent plan session resumes G
    automatically — no user action needed;
- whether the loop is **parked on a question** (id to answer) — if so, "answer it
  in the TUI/web, then run `/investigate:advance D` to resume";
- if the tree still has `uncertain`/`open` leaves and no question is pending, say
  another round is warranted: "run `/investigate:advance D` again".

---

## Handoff record (STANDALONE only — suppressed when chained)

> **Your stop is PROGRESS-bounded, never EFFORT-bounded.** Stop ONLY when this
> flow's own stop predicate fires — a node is `confirmed` and the fix goal is
> seeded (file-and-defer), the tree is exhausted with no adjudicable lead left,
> or the defect is parked on an `open` user question — NEVER because the run is
> long, costly, used many explorers, reached "a natural milestone", or the
> remaining work feels disproportionate. The handoff status you write is the
> gate: one of `drained` / `answers-required` / `mixed` / `illness-detected`,
> each requiring a real predicate condition — there is no status for an
> effort-based stop. If tempted to stop while an `uncertain`/`open` leaf is still
> adjudicable, CONTINUE. (See llm/commands/advance.md §Stop condition.)

Whether you write a `handoffs` record at your stop depends ENTIRELY on your
invocation context — there is **no env var or process signal** to read. You,
the executing agent, run both this command and (when chained) the wrapping flow
command in the SAME inline session, so you already KNOW which context you are in.

- **Run STANDALONE** (the user invoked `/investigate:advance` directly, with no
  wrapping flow command): after the §Report, write ONE `handoffs` record for
  this stop —
  `create_item("handoffs", <defectMilestone>, <status>, <fields>)` — mapping
  your stop classification to the handoff `status`:

  | This round's stop                                                              | handoff `status`   |
  | ------------------------------------------------------------------------------ | ------------------ |
  | nothing left to drill / fully adjudicated (root-caused, or all leaves resolved) | `drained`          |
  | parked on an `open` question (step 6 — NEEDS user input)                       | `answers-required` |
  | both at once — some defect(s) root-caused/drained, other(s) parked             | `mixed`            |
  | a defect or invariant violation you could not get past                         | `illness-detected` |

  Field set (per `HANDOFFS_SCHEMA`; consistent with advance.md §Provenance):
  `summary` (**required** — the why-it-stopped prose, mirror the §Report);
  `flow` = `investigate`; `ledgerRefs` = the stop-causing items (`defects:<D>`,
  defect-seeded `goals:<G>`); `blockingQuestions` = the `open` question ids for
  an `answers-required`/`mixed` stop; `handoffReasons` = the component reasons
  for a `mixed` stop (e.g. `[drained, answers-required]`); `sessionLogs` = the
  `docs/logs/<ts>-<agent-id>.md` path(s) written this round — populate them in
  the SAME `create_item` call. Stamp `author`/`session`. Append-only: written
  once at the stop, never updated.

- **Run CHAINED INLINE by any wrapping flow command** (`/advance`,
  `/plan:advance`, or a `/<flow>:start` / `/<flow>:follow-up` that runs this
  pass inline): **SUPPRESS this handoff write.** The outermost wrapper owns the
  single authoritative run-level handoff and writes it once at its stop —
  `/advance` per its §Provenance (it is the sole `handoffs` writer for the whole
  run); `/plan:advance` writes its own standalone record covering the whole pass
  including the chained investigate sub-round; a `/<flow>:start` or
  `/<flow>:follow-up` writes it directly in its own §Handoff record step. You
  can tell you are in this context because the wrapping command explicitly chains
  you and its prompt instructs this suppression; a standalone invocation has no
  such wrapper. Suppressing here is what guarantees exactly ONE handoff per run —
  never a duplicate.
