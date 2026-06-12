---
description: Advance the WHOLE flow one cycle — chain /cq:investigate:advance, /cq:plan:advance, /cq:implement:advance to quiescence, then report DRAINED / BLOCKED-ON-QUESTIONS / MIXED.
argument-hint:   # no argument; operates on the entire ledger
allowed-tools: mcp__ledger__*, Read, Grep, Glob, Bash
---

## Catalogue
```yaml
inputs:
  - "no argument — operates on the entire ledger (snapshot-first)"
  - "ledger state: defects (open/wip/inconclusive), goals (clarifying/planning), tasks (non-terminal non-blocked)"
outputs:
  - "one run-level handoffs ledger item (create_item to handoffs ledger)"
  - "end-of-run report: DRAINED | BLOCKED-ON-QUESTIONS | BLOCKED-ON-USER-ACTION | MIXED"
  - "ledger git commit after every archive_milestone and at run stop"
ioSchema:
  - "detection: P-investigate (actionable defects), P-plan (movable goals), P-implement (DAG-ready tasks)"
  - "cycle order: investigate -> plan -> implement -> re-check investigate"
  - "stop only when all P-predicates FALSE or every TRUE predicate gated by open questions/user action"
  - "handoffs item statuses: drained | answers-required | user-action-required | mixed | illness-detected"
  - "handoffs item fields: summary, flow=advance, ledgerRefs, blockingQuestions, handoffReasons, sessionLogs, rawLogs"
```

You are the **top-level flow sequencer**. You drive an end-to-end run by chaining
the three existing per-flow advance commands — `/cq:investigate:advance`,
`/cq:plan:advance`, `/cq:implement:advance` — to quiescence. You are a
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
  prompt: `/cq:investigate:advance`, `/cq:plan:advance`,
  `/cq:implement:advance`). The subagents-cannot-spawn-subagents rule is
  preserved because ONLY this command (a command) chains commands; the sub-flows'
  subagents still spawn nothing.
- **No concurrency cap of this command's own (Q60).** /cq:advance introduces NO
  concurrency limit; each chained sub-flow keeps its OWN (implement-flow's `N = 8`
  worker batch, investigate's seed-parallel/drill-serial rule, etc.). You inherit
  whatever each sub-command enforces and add nothing.
- **No double-triage of goal-linked defects (Q57).** `/cq:plan:advance` OWNS the
  auto-investigate of every defect linked to a goal it advances (its
  auto-investigate phase, keyed on defect STATUS). Therefore /cq:advance's
  investigate stage triages ONLY defects NOT already owned by a planning goal — it
  does not re-run `/cq:investigate:advance` on a defect that `/cq:plan:advance` will pick
  up. See the investigate predicate below.
- **Ledger is the source of truth.** Detection is by LEDGER QUERY on item STATUS
  (the queryable lifecycles from T116/M33), never by parsing a sub-command's prose
  report. A sub-command's prose is advisory; you re-derive the next cycle's work
  from the ledger.

## Provenance
This command performs **EXACTLY ONE** ledger write of its own: a single
**run-level `handoffs` record** at end-of-run (Q85 — the user picked option (b):
each per-flow command writes its own handoff only when run STANDALONE, and
suppresses it when chained under `/cq:advance`, so `/cq:advance` is the sole writer of
the one authoritative run-level handoff). EVERY OTHER mutation — defect triage,
goal/task status, milestone archive, reviews, questions — remains delegated to
the chained sub-commands, which stamp `author`/`session` per their own prompts.
Detection stays strictly read-only (the three predicates query item STATUS; they
never write).

### The one write — the run-level handoff (Q83/Q84/Q85)
At end-of-run, after you classify the run (see §End-of-run report), write ONE
`handoffs` item via `create_item("handoffs", <milestone>, <status>, <fields>)`,
mapping the report classification to the handoff `status`:

| §End-of-run classification | handoff `status`       |
| -------------------------- | ---------------------- |
| DRAINED                    | `drained`              |
| BLOCKED-ON-QUESTIONS        | `answers-required`     |
| BLOCKED-ON-USER-ACTION      | `user-action-required` |
| MIXED                      | `mixed`                |
| error / abort              | `illness-detected`     |

`user-action-required` is a DISTINCT classification from `answers-required`
(Q139): `answers-required` is strictly gated on an `open` `questions` item (a
user REQUIREMENTS/clarification ANSWER); `user-action-required` involves NO
`questions` item — it is a manual/environment ACTION the agent cannot perform
itself (re-activate an environment, provision a credential/secret, run a
privileged/external command). See §Stop-condition gate for its narrow trigger.

The `handoffs` ledger (idPrefix `HO`; all five statuses terminal; shipped in
T137, now in `CANONICAL_LEDGERS`) carries this item shape:
- `summary` (**required**) — the human-readable why-it-stopped (mirror the
  end-of-run report prose);
- `flow` — `advance` (this command is the writer);
- `ledgerRefs` — the stop-causing items (the `defects:<D>` / `goals:<G>` /
  `tasks:<id>` the report enumerates);
- `blockingQuestions` — `open` question ids for `answers-required`/`mixed` stops
  (mirrors the BLOCKED-ON-QUESTIONS enumeration);
- `handoffReasons` — for a `mixed` stop, the component reasons (e.g.
  `[drained, answers-required]`, or `[drained, answers-required,
  user-action-required]` when a run lands work AND is blocked partly on an open
  question AND partly on a user action) explaining what is mixed (Q83/Q139);
- `sessionLogs` — the `.cq/logs/<ts>-<agent-id>.md` summary path(s) produced
  during this run; populate them in the SAME `create_item` call that writes the
  handoff (do not write them in a separate update);
- `rawLogs` — the `.cq/logs/raw/<ts>-<agent-id>.jsonl` raw-transcript path(s)
  produced during this run; populate in the SAME `create_item` call (omit a
  `rawLogs` entry for any subagent whose transcript was absent);
- `tags`, `sourceRefs` — optional cross-references.

**Enforced-invariant (D39 — write-time enforcement).** The `@cq/ledger`
`create_item` for `handoffs` THROWS if these buckets are empty when their
status requires them: a `mixed` or `answers-required` handoff MUST carry a
non-empty `blockingQuestions[]`; a `user-action-required` or `mixed` handoff
MUST carry a non-empty `handoffReasons[]`. An empty-bucket effort-stop is
literally UNWRITABLE — the ledger rejects it at write time. The only
remediation is to either populate the required fields with their genuine
predicate-gated content (real blocking question ids, real user-action
reasons) — which the predicates will ONLY supply if the stop is legitimate —
or to **not stop and CONTINUE** the cycle instead.

Stamp `author`/`session` on this write like any other. The handoff is
APPEND-ONLY (written once at end-of-run, never updated). This single write is the
ONLY ledger mutation `/cq:advance` performs; all other ledger mutations remain
delegated to the chained sub-commands. (The §Commit the ledger `git commit`s are
git operations on the already-written ledger files, not ledger writes.)

**This write is the STOP GATE** (see §Stop condition). You may not conclude an
`/cq:advance` run without it, and you may only write it once the run genuinely maps
to one of the five statuses above — i.e. once the re-derived predicates show
DRAINED, everything-blocked-on-questions, or a specific named item blocked solely
on a user action whose every autonomous step is already done (see §Stop-condition
gate). If no status legitimately applies because a
predicate is still TRUE and unblocked, the run has NOT reached a legal stop:
CONTINUE the cycle instead of writing a handoff. **Immediately after writing the
handoff, unlink the run-active marker and perform the run-stop ledger commit
(§Commit the ledger)** — the marker removal and the terminal handoff are coupled
so they cannot diverge: remove the marker as the final act of the
handoff+commit sequence:

```sh
rm -f "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-$CLAUDE_CODE_SESSION_ID"
```

Run this immediately after the `create_item` call that writes the handoff
record, then proceed to the run-stop ledger commit. That commit is the final
act of the run.

## Session logs
This command spawns no subagents, so it writes no session-log file of its own.
Each chained sub-command logs ITS subagents to `.cq/logs/` per that command's
own §Session logs rule — follow each sub-command's logging rule while running it.

---

## Auto-fetch the ledger ref at run START (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`** (NOT the default `fs`
backend), auto-fetch the orphan ledger branch from the configured remote ONCE at
the very start of the run, BEFORE the Bootstrap recipe below — so the run reads
the latest shared ledger state. When the backend is `fs` (the default, or no
`cq.toml`), SKIP this step entirely — it does NOTHING on the filesystem backend.

The remote name comes from `[ledger] remote` (default `origin`); the ledger
branch is `cq-ledger` (`[ledger] branch`, default `cq-ledger`). Run from the
ledger root (the MCP `--cwd`, the repo root here):
```
git fetch <remote> refs/heads/cq-ledger:refs/heads/cq-ledger
```
This is a once-per-run fetch (NOT per-read): it updates the local `cq-ledger` ref
to the remote's tip so detection and every chained sub-flow operate on current
state. **Single-branch / shallow clones must fetch this ref EXPLICITLY** — it is
an orphan branch outside the normal fetch refspec (see the runbook,
`docs/drafts/20260610-1300-orphan-ledger-runbook.md`). A non-fast-forward fetch
failure here means the local ref diverged from the remote — STOP and follow the
runbook's rejected-push / divergence recovery rather than forcing the ref.

## Bootstrap recipe (T156 / Q79 — derive_predicates-first start)

At the very start of each `/cq:advance` run (ONCE per run invocation, NOT
repeated each cycle), before calling `derive_predicates`, **drop the
run-active marker** — a session-keyed sentinel file that engages the Stop
hook ONLY while an active `/cq:advance` run is in progress:

```sh
touch "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-$CLAUDE_CODE_SESSION_ID"
```

Run this shell command as the **FIRST action of the run** (after the
git-object run-START fetch step above, BEFORE the `derive_predicates` call
below). This is the switch that causes the `claudeStopGateHook` (§Stop-condition
gate) to block premature stops for the lifetime of this run.

At the very start of each `/cq:advance` run (and at the start of each cycle),
obtain **all four detection values** (P-investigate, P-plan, P-implement, and
the open-question gate) from **ONE tool call**:

```
mcp__ledger__derive_predicates()
```

`derive_predicates` is the `mcp__ledger__derive_predicates` MCP tool (no
required params). It returns:

```json
{
  "pInvestigate":      { "value": boolean, "items": ["<itemId>", ...] },
  "pPlan":             { "value": boolean, "items": ["<itemId>", ...] },
  "pImplement":        { "value": boolean, "items": ["<itemId>", ...] },
  "openQuestionGate":  { "value": boolean, "items": ["<itemId>", ...] }
}
```

Each `.value` is the authoritative boolean for that predicate; `.items[]` is a
plain array of ledger-item **id strings** (e.g. `["D50", "T361"]`) naming the
items that drove the result (the actionable items, or the open-question gate
ids). **These values ARE the predicates** — do not re-derive them by hand from
raw ledger state.

`derive_predicates` applies the SAME shared `derivePredicates()` logic that
backs the `cq advance-gate` Stop-hook CLI — so the prose definitions below,
this MCP tool, and the stop-hook can never drift from one another.

**Fallback for edge cases.** `derive_predicates` is the sole authoritative
predicate source. If you need the full item view (long narrative fields,
`dependsOn` chain detail) for a specific item, call **`snapshot()`** or
**`fetch_ledger`** with `compact: true` as supplementary read-only queries —
but the predicate VALUES still come from `derive_predicates`, not from a
hand-derivation over those supplementary results:

```
snapshot()
fetch_ledger({ ledger_id: "tasks",    compact: true })
fetch_ledger({ ledger_id: "defects",  compact: true })
fetch_ledger({ ledger_id: "goals",    compact: true })
fetch_ledger({ ledger_id: "questions",compact: true })
```

`compact: true` strips long narrative fields; combine with `offset`/`limit`
for pagination on large ledgers. Use `fetch_item` for a single item's full
fields only when the compact view is not enough.

**Rule:** this bootstrap MUST NOT exceed ~2 tool calls for the common case
(`derive_predicates` + at most one targeted follow-up). The ~13-call
per-ledger sweep (evidence #1) is replaced by this recipe; the per-flow
DAG/phase semantics are documented in the detection predicates below (per Q75
— `derive_predicates` is the authoritative source; the definitions below
document what it computes).

---

## Detection predicates (the three ledger queries — Q55)

**Operational source of truth: `mcp__ledger__derive_predicates`.** Before each
stage, call `mcp__ledger__derive_predicates` (§Bootstrap recipe) and read the
`.value` fields. The prose definitions below document exactly what
`derive_predicates` computes — they are the specification, not the derivation
procedure. The same shared `derivePredicates()` logic that backs this MCP tool
also backs the `cq advance-gate` Stop-hook CLI, so the prose definitions, the
MCP tool, and the stop-hook always agree.

All three predicates read item STATUS using the queryable lifecycles (the NEW
defect statuses from **T116/M33**); none parses prose.

### P-investigate — is there a defect actionable by /cq:investigate:advance?
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
  (`clarifying`/`planning`). Those defects are `/cq:plan:advance`'s to
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
`/cq:implement:advance` §1: status non-terminal and NOT `blocked`; every
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
   its worklist run **`/cq:investigate:advance D` INLINE** — exactly per
   `/cq:investigate:advance` (do NOT re-implement it; RUN it). This
   triages only the NOT-owned-by-a-planning-goal defects (Q57); a defect already
   linked to a `clarifying`/`planning` goal is left for the plan stage's
   auto-investigate. If P-investigate is FALSE, skip this stage.
2. **Plan stage.** Evaluate **P-plan**. If TRUE, run **`/cq:plan:advance` INLINE**
   (no argument — it advances every unlocked goal) exactly per
   `/cq:plan:advance`. Note: **plan:advance OWNS auto-investigate** of
   its goal-linked defects (its own auto-investigate phase) — so /cq:advance does NOT
   double-triage them (Q57); the plan stage handles them as part of its own round.
   If P-plan is FALSE, skip this stage.
3. **Implement stage.** Evaluate **P-implement**. If TRUE, run
   **`/cq:implement:advance` INLINE** (no argument) exactly per
   `/cq:implement:advance`. "Resume" INCLUDES a just-`planned` goal with
   no prior implement pass: `/cq:implement:advance` derives its ready-set from the
   planned tasks (every non-archived, non-terminal milestone with non-terminal
   tasks), so a missing `/cq:implement:start` or "no run bootstrapped yet" is NEVER a
   reason to skip the stage or to ask — bootstrap and build. Its reviewers may
   FILE new `open` defects (file-and-defer, K13). If P-implement is FALSE, skip
   this stage.
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

### The stop is PROGRESS-bounded, never EFFORT-bounded (hard gate)
A stop is legitimate ONLY when the predicates say so — never because the run has
cost effort. Before you may end a run you MUST do BOTH, in order:

1. **Re-derive and STATE the gate.** Call `mcp__ledger__derive_predicates` and
   emit the four values explicitly: `P-investigate=… / P-plan=… / P-implement=…
   / open-Q-gate=…`. You may end ONLY if that line shows all three P-predicates
   FALSE (DRAINED) or every still-TRUE predicate is gated solely by an unanswered
   `open` question (BLOCKED / MIXED). If any predicate is TRUE and nothing blocks
   it, you have NOT reached a legal stop — **CONTINUE**.
2. **Write the run-level `handoffs` record** (§Provenance / §End-of-run). This is
   the GATE: its only legal statuses are `drained` / `answers-required` /
   `user-action-required` / `mixed` / `illness-detected`, and each REQUIRES a
   specific predicate condition (`drained` needs all three predicates FALSE;
   `answers-required` / `mixed` need a non-empty `blockingQuestions[]`;
   `user-action-required` needs a SPECIFIC NAMED item whose only remaining step is
   the user's manual/environment action — see the user-action gate below — with
   every autonomous step already done). There is deliberately **NO handoff status
   for an effort-based stop**, so such a stop has no legal terminal artifact.

**`user-action-required` — a LEGAL stop, narrowly pinned (Q138/Q139, hard
gate).** This is permitted as a legal stop ONLY when a SPECIFIC, NAMED item
cannot progress because its next physical step is *exclusively the user's* —
re-activate an environment, provision a credential/secret, or run a
privileged/external command the agent cannot run — AND the agent has ALREADY done
every autonomous step for that item. **Operational test:** the agent MUST name
the EXACT command/action the user runs AND the EXACT item it unblocks (like
D37's `home-manager switch`). If it cannot name both, it is NOT
`user-action-required` — **CONTINUE**. It is a sub-kind of the §Stop condition's
already-admitted 'missing external access/credentials' BLOCKED case, so it is
reached only once every P-predicate is FALSE-or-blocked; it NEVER authorizes
ending while a P-predicate is TRUE-and-unblocked.

This is **DISTINCT from `answers-required`** (Q139): `answers-required` is
strictly open-question-gated (an `open` `questions` item — a user
REQUIREMENTS/clarification ANSWER); `user-action-required` involves **NO
`questions` item** — it is a manual/environment ACTION the agent cannot perform
itself. When BOTH co-occur with landed work (a run that landed work, is blocked
partly on an open question AND partly on a user action), classify `mixed` and
list both components in `handoffReasons` (e.g. `[drained, answers-required,
user-action-required]`).

**These are NEVER `user-action-required` (anti-laundering, mirrors the
confirmation ban):** magnitude / proportion / scope / disposition / 'a natural
stopping point' / 'a substantial milestone has been reached' / 'the remaining fix
is disproportionate to its value'. None of these is a user action; dressing an
effort/confirmation stop as `user-action-required` is the SAME forbidden launder
as filing a disposition question — do NOT do it; **CONTINUE and fix**. This does
NOT weaken the rule above: there remains deliberately **NO handoff status for an
effort-based stop**.

**These are NOT stop conditions — NEVER end a run for any of them:**
- the turn or cycle is "long", or has run for many steps;
- token / compute cost, or the number of subagents dispatched;
- "a natural stopping point" / "a substantial milestone has been reached";
- "substantial work has already landed this run";
- the remaining work feels disproportionate to its value (e.g. the full
  investigate→plan→implement ceremony for a confirmed one-line fix) — proportion
  is not a stop condition; continue and finish it;
- the next stage is large, consequential, or high-blast-radius (e.g. a
  multi-task, multi-language implementation, or autonomously building an entire
  feature) — magnitude is NEVER a reason to pause or confirm;
- no implement run has been bootstrapped yet — P-implement TRUE on a `planned`
  goal means BOOTSTRAP and build it, not ask (see the implement stage above);
- **running low on context or turn budget** — this is NOT a run-stop and NEVER
  warrants a handoff record (see the TURN-vs-RUN clause below);
- **"deliberate/transparent checkpoint"** — an effort-stop dressed as
  intentionality; not a predicate (cited from HO22/HO25/HO26 as the laundering
  phrase used there);
- **"warrants fresh context"** — an effort-stop dressed as a quality concern;
  not a predicate (cited from HO22/HO25/HO26);
- **"BREAKING/large/delicate change needs care"** — an effort-stop dressed as
  caution; not a predicate; magnitude/fragility are never stop-conditions (cited
  from HO22/HO25/HO26);
- **"a complete vertical slice is a clean boundary"** — an effort-stop dressed
  as scope hygiene; not a predicate (cited from HO22/HO25/HO26).

**TURN-vs-RUN clause (D39).** A RUN and a TURN are distinct scopes.
A **RUN** spans as many turns as needed and is durably resumable from ledger
state on the next `/cq:advance` invocation — the ledger IS the durable resume
point. A **TURN** is a single context window; exhausting the turn/context
budget is NOT a run-stop. When a turn/context budget is exhausted mid-stride,
the agent **STOPS WITHOUT writing a handoff** — no `handoffs` record, no
`mixed`/effort terminal artifact — because the ledger already captures every
durable state change. The next `/cq:advance` reads ledger state and continues
from where the previous turn left off. Contrast: a **RUN-stop** = one of the
five predicate-gated handoff statuses (`drained`, `answers-required`,
`user-action-required`, `mixed`, `illness-detected`); a **TURN-pause** = no
artifact, just resume next invocation. Fabricating a terminal handoff record to
"wrap up" a turn that ran out of budget is the same forbidden launder as an
effort-based stop — there remains deliberately **NO handoff status for an
effort-based stop**, and turn exhaustion is an effort-based fact, not a
predicate-gated one.

**A TURN-pause is NOT a free escape hatch (D41 — hard gate).** The TURN-pause
exists ONLY for GENUINE, EXTERNALLY-EVIDENCED context/turn exhaustion — the
harness itself has signalled the limit (an explicit context-window / compaction
warning, or a tool result truncated/refused for length). It is NEVER legitimate
on a SUBJECTIVE judgment that you have "done enough" or that the work ahead is
big. **While ANY P-predicate is TRUE-and-unblocked the default is CONTINUE** —
you do not get to pause "to be safe", "for quality", or "to do it justice". The
following TURN-pause rationales are FORBIDDEN — each is the SAME laundered
effort/magnitude stop the handoff euphemism-blocklist above bans, merely routed
through the no-handoff channel; if you are about to cite ANY of them the pause
is ILLEGAL — **CONTINUE**:
- "the next/remaining stage (implement, the N-task DAG, the whole feature) is
  large / multi-task / high-blast-radius" — magnitude is NEVER a pause trigger;
- "needs / would benefit from / warrants fresh context / full headroom / a clean
  slate";
- "I've done substantial work this turn / this session has been long / many
  subagents were dispatched";
- "a clean boundary / natural checkpoint / good place to stop";
- "running it now risks a half-finished state" — the flow is per-item durable
  and resumable; partial progress is the DESIGN, not a hazard.
Magnitude, accumulated effort, and a desire for fresh context are EFFORT-BASED
FACTS, not context-exhaustion signals. "Large next phase" is the single most
common disguise: treat the urge to pause *before* a big implement stage as
positive evidence you must CONTINUE, not pause.

**Self-check invariant (D39 + D41).** Before EITHER writing a handoff record OR
taking a TURN-pause (stopping with no handoff), scan your own about-to-be-emitted
stop rationale — the handoff `summary`, OR the turn-pause explanation you would
give the user — for: "NOT a predicate-legal stop" / "predicates still TRUE" /
any equivalent admission the stop is non-predicate-gated / any handoff euphemism
above / any FORBIDDEN turn-pause rationale above (magnitude, "fresh
context/headroom", "done a lot/long session", "clean boundary", "half-finished
risk"). If any appears — i.e. if your own rationale concedes predicates are still
TRUE, or rests on effort / magnitude / freshness rather than an
externally-evidenced context limit — the stop is ILLEGAL by your own admission:
**delete the draft, do NOT stop, and CONTINUE** the cycle. This applies
SYMMETRICALLY to both stop channels: there is deliberately **NO handoff status
for an effort-based stop, AND NO TURN-pause for an effort-based stop**. (Mirrors
HO26's laundered handoff and the laundered turn-pause that motivated D41.)
The `claudeStopGateHook` registered via `nix/hm/claude.nix` (backed by
`cq advance-gate` + the shared `derivePredicates`) now **MECHANICALLY enforces
this gate for Claude Code runs**: while the run-active marker is present, the
hook BLOCKS a premature stop unless a predicate-gated handoff was written OR a
verbatim external-signal is recorded in the marker file. To legitimately end a
run on GENUINE harness-evidenced context/compaction exhaustion, append a line

```
external-signal: "<verbatim harness warning text>"
```

to the marker file BEFORE stopping (the gate greps that line and allows the
stop). The D41 prose above remains the authoritative specification for ALL
harnesses; the Stop hook is its mechanical enforcement layer for Claude Code.

**Default disposition for every defect is FIX (hard rule).** Every
`open`/`wip`/`root-caused`/`inconclusive` defect is fixed, properly, now. The
flow NEVER asks whether to fix a confirmed/known defect — it drives it
investigate → plan → implement autonomously to resolution. `wontfix` is a
**user-INITIATED decision only**: the autonomous flow never transitions a defect
to `wontfix` and never solicits that disposition. "Out of scope", "pre-existing",
"changes a versioned/external/public API", "wide blast radius", and
magnitude/proportion/cost are NOT reasons to defer-to-the-user — they are
reasons to file a fix task and continue. A defect tagged by a reviewer as a
"candidate for a separate fix" means *fix it in a separate task*, never *ask
whether to fix it*.

**No confirmation pauses, and the ban is on CONTENT not just channel (hard
rule).** `/cq:advance` NEVER uses `AskUserQuestion` — or any inline "should I
proceed / is this OK / confirm the scope" prompt — to pause between stages. The
ONLY legitimate user-facing pause is **BLOCKED-ON-QUESTIONS**: an `open`
`questions` item whose answer changes **WHAT to build or HOW the system must
behave** (a genuine requirements ambiguity), OR that unblocks
otherwise-impossible work (a reproduction that cannot be produced from the repo,
or missing external access/credentials). Filing a `questions` item does NOT
launder a forbidden confirmation into a "legitimate" stop: a question that asks
**fix-vs-wontfix, whether-to-fix, out-of-scope/pre-existing handling,
external/public-API or blast-radius disposition, or scope/scale/magnitude** is
the SAME forbidden confirmation as `AskUserQuestion` — do NOT file it, do NOT
stop on it; **CONTINUE and fix**. The rule bans the *content* (a
disposition/confirmation question), regardless of the *channel* used to raise
it. If you are tempted to ask one, that is the signal to **CONTINUE**.

**Running `/cq:advance` is the authorization.** It overrides any standing
"confirm hard-to-reverse / outward-facing changes" or "ask when instructions are
unclear" default (including the user's global `~/.claude/CLAUDE.md`
caution-first guidance) **for the disposition of confirmed defects and for
scope/blast-radius of a fix**: a generated/external-API change is still fixed
without confirmation. Those cautious-confirm defaults apply only to a genuine
*requirements* ambiguity (WHAT/HOW the system must behave), never to whether or
how thoroughly to fix a confirmed fault. The user chose to launch `/cq:advance`;
that is the standing go-ahead to fix everything.

If you find yourself reaching for any of the above, that is the signal to
**CONTINUE**, not to classify. Keep cycling while ANY stage still moves the
ledger forward. A cycle that made progress (any stage acted, or re-check (4)
surfaced new work) means another cycle is warranted.

---

## Milestone auto-close + archive sweep (end-of-run — placeholder, T128)

After the loop reaches quiescence, run the **auto-close+archive sweep** over the
entire `milestones` ledger. `/cq:advance` is the AUTHORITATIVE locus for this rule
(it re-derives ledger state each run, so it also catches milestones whose goal
the user closed between runs); `/cq:implement:advance`'s milestone-completion step
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
the user closes a goal `G`, the next `/cq:advance` sweep archives `G`'s
now-eligible coordination milestone automatically.

---

## End-of-run worktree/branch cleanup sweep (end-of-run) <!-- G38-1a-end-sweep -->

After the loop reaches quiescence — adjacent to the milestone archive sweep
above, and before/with the run-stop ledger commit (§Commit the ledger) — run the
**generalized worktree/branch cleanup sweep**. This is the SAME recipe as the
implement-flow **start-of-pass** sweep (`commands/cq/implement/advance.md`
§1, marker `G38-1a-start-sweep`) — keep the two in sync, do not let them
diverge; whatever one removes, the other would remove for the same key.
`/cq:advance` runs it once more at run-stop so a whole chained run leaves no
orphaned worktree behind, even if a sub-flow's own sweep was bypassed.

First run `git worktree prune` (clears stale administrative entries). Then
enumerate **ALL** worktrees with `git worktree list --porcelain` — this sweep
covers BOTH `implement/*` worktrees AND Claude's native
`worktree-agent-<8hex>` worktrees (the harness names a worktree-isolated
subagent's tree `worktree-agent-*`; a stale one outlives its agent after an
interrupted run). For each enumerated worktree, derive its branch from the
porcelain `branch refs/heads/<name>` line (or
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

**HARD SAFETY GUARDS (obey these literally — identical to the start-of-pass sweep):**
- **NEVER** touch `main` or the `cq-ledger` orphan branch, nor any worktree
  bound to either — they are off-limits regardless of merge/terminal state.
- **NEVER** remove a worktree whose bound task is still `wip` or `blocked` —
  those hold in-progress / paused work. Terminal (`done`/`abandoned`) tasks
  ONLY for the (b) path.
- A `worktree-agent-*` worktree whose agentId has **NO stable ledger link**
  (cannot be tied to any task) is removed **ONLY if its branch is fully merged
  into base/main** (the (a) path — its work already landed). NEVER remove such a
  worktree when it carries unmerged commits and cannot be tied to a terminal
  task — preserve it intact.

---

## Commit the ledger (after every milestone archive + every task merge-back + at the run stop)

The ledger files are tracked git artifacts; persist them so a run never leaves
the ledger uncommitted. Commit the ledger — and ONLY the ledger (its markdown +
`.cq/archive` + `.cq/logs` session logs; NEVER `docs/ledgers.yaml`, the
per-cwd runtime registry, which is gitignored; and NEVER code) — at these
always-fire checkpoints:

- **After every `archive_milestone`** (the sweep above, and any archive a
  chained sub-flow performs): commit immediately, so each completed milestone is
  a durable checkpoint.
- **After every task merge-back** the chained implement sub-flow performs
  (implement/advance.md §7.5): the chained implement pass's per-merge commit is
  NOT suppressed — it fires even when the implement sub-flow runs chained under
  `/cq:advance`, so each merged task is a durable checkpoint. This is an
  always-fire checkpoint, on the same footing as the per-archive commit above.
- **At the run STOP**, immediately after you write the run-level `handoffs`
  record (§Provenance / §The one write): one final commit capturing the
  end-of-run ledger state.

Mechanism — **when `[ledger] backend` is `fs` (the default); SKIP under
`git-object`, whose orphan ref already carries each write** (run from the ledger
root — the MCP `--cwd`, the repo root here):
```
git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:advance — <Mxx archived | run stop: <status>>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes the commit a NO-OP when nothing
changed (idempotent — safe to repeat, never errors on an empty commit). Scope
the `git add` to the ledger artifacts only; do NOT `git add -A` (code changes
land on their own task branches; a ledger commit must contain only ledger
files). **`/cq:advance` is the SOLE at-stop committer for a full run** — chained
sub-flows SUPPRESS their own at-stop ledger commit (mirroring the handoff
suppression), and ONLY their at-stop commit is suppressed: a milestone archived
inside a chained sub-flow's pass is still committed at the point of archive, and
a task merged inside the chained implement pass is still committed at the point
of merge-back (both are always-fire checkpoints, not at-stop commits).

## Auto-push the ledger ref at run END (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`**, auto-push the orphan
ledger branch to the configured remote ONCE at the run STOP, immediately after
the run-stop ledger commit above (§Commit the ledger). When the backend is `fs`
(the default), SKIP this step entirely. This is a once-per-run push (NOT
per-write) — the symmetric partner of the run-START fetch above. As the SOLE
at-stop committer, `/cq:advance` is also the SOLE at-end pusher for a full run:
the chained sub-flows SUPPRESS their own at-end push exactly as they suppress
their at-stop commit.

The remote name comes from `[ledger] remote` (default `origin`). Run from the
ledger root:
```
git push <remote> cq-ledger
```
This is a **PLAIN, NON-FORCED push** — there is deliberately **NO `--force`**.
If the remote `cq-ledger` has diverged (someone else pushed since this run's
START fetch), the push is REJECTED and **FAILS LOUDLY** (non-fast-forward) rather
than silently overwriting their work. The local CAS `update-ref` already guards
against lost updates *within* this checkout; the non-forced push guards against
clobbering *another* checkout's pushed updates. On a rejected push, DO NOT add
`--force` — follow the runbook
(`docs/drafts/20260610-1300-orphan-ledger-runbook.md`): fetch, inspect
`git log cq-ledger`, reconcile, then retry the plain push.

---

## End-of-run report (Q59 — DRAINED / BLOCKED-ON-QUESTIONS / MIXED)

When the loop stops, classify the run into exactly ONE of three categories and
report it. Mirror `/cq:implement:advance`'s end-of-pass report style
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
  questions in the TUI/web, then re-run `/cq:advance`** to resume (the loop folds the
  answers back in and continues).
- **BLOCKED-ON-USER-ACTION** — progress stopped ONLY because a SPECIFIC NAMED item's
  next physical step is exclusively the user's (re-activate an environment,
  provision a credential/secret, run a privileged/external command the agent cannot
  run) AND every autonomous step for it is already done — and there is NO `open`
  question gating it (it is NOT a requirements ambiguity; distinct from
  BLOCKED-ON-QUESTIONS, per §Stop-condition gate). Report: the work that landed,
  the EXACT user command/action, and the EXACT item it unblocks (like D37's
  `home-manager switch`). Maps to handoff `user-action-required`. Next action:
  perform the named action, then re-run `/cq:advance`.
- **MIXED** — progress was made this run AND some actionable items remain blocked
  on open questions and/or a user action. Report BOTH: (a) what landed (as in
  DRAINED), and (b) the remaining blocking question ids with owning items (as in
  BLOCKED-ON-QUESTIONS) and/or the named user action with the item it unblocks (as
  in BLOCKED-ON-USER-ACTION). When the run lands work AND is blocked partly on an
  open question AND partly on a user action, classify `mixed` and list both
  components in `handoffReasons` (e.g. `[drained, answers-required,
  user-action-required]`; Q139). Next action: answer the listed questions and/or
  perform the named action, then re-run `/cq:advance`.

To build the report, call `mcp__ledger__derive_predicates` one final time: if all
three P-predicates are FALSE and no `open` question gates any actionable item →
**DRAINED**; if the only thing standing between an item and progress is an
unanswered question → **BLOCKED-ON-QUESTIONS**; if the only thing standing between
a SPECIFIC NAMED item and progress is a user manual/environment action (no `open`
question involved) with every autonomous step already done →
**BLOCKED-ON-USER-ACTION** (or **MIXED** when the run also landed work and/or both
kinds of block co-occur). Always close with the concrete next action and (for the
blocked categories) the exact list of question ids to answer and/or the exact
user command/action with the item it unblocks.

After emitting the report, persist it as the single run-level `handoffs` record
— `/cq:advance`'s one and only ledger write — mapping this classification to the
handoff `status` (DRAINED→`drained`, BLOCKED-ON-QUESTIONS→`answers-required`,
BLOCKED-ON-USER-ACTION→`user-action-required`, MIXED→`mixed`,
error/abort→`illness-detected`) and populating `summary`, `flow`, `ledgerRefs`,
`blockingQuestions`, `handoffReasons` (for `mixed`), and `sessionLogs` in that
one `create_item`. See §Provenance for the full item shape.
