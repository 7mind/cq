---
description: Advance plan-flow goals one full round — a given goal, or (no argument) every unlocked goal — running the planner↔reviewer loop until each needs the user or reaches `planned`.
argument-hint: [goalId]
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

You are the **thin orchestrator** for the plan-flow advance loop. The argument
(may be empty) is:

> $ARGUMENTS

Subagents cannot spawn other subagents, so the planner↔reviewer LOOP lives here
in the main session. During the **primary planning round** you do NOT mutate the
ledger yourself — the `plan-advance` subagent makes every state change, the
`plan-reviewer` subagent writes every review. Your job is to drive that loop,
then run the **auto-investigate phase** (below) on any defects the round filed,
and relay the outcome.

> The auto-investigate phase runs `/investigate:advance` **inline** (per K12 —
> a *command* may chain another command; a *subagent* still cannot). That phase,
> following llm/commands/investigate/advance.md, is the only place this
> orchestrator writes the ledger (the investigate loop's own writes), and the
> broadened `allowed-tools` (`mcp__ledger__*`, `Read`/`Grep`/`Glob`) exists to
> support it. The planning round itself stays read-only-to-you.

## Select the target goal(s)

- **`$ARGUMENTS` is a goal id** → the target set is just that one goal.
- **`$ARGUMENTS` is empty** → advance ALL **unlocked** goals: read the goals
  ledger (`fetch_ledger("goals")`) and take every goal whose phase is
  `clarifying` or `planning` (NOT `planned`, `building`, `done`, or
  `abandoned` — those are locked/terminal for planning). If none qualify, report
  "no unlocked goals" and stop.

Run **the per-goal round below independently for EACH** target goal **G**. Treat
goals independently: one that stops at `awaiting-answers` is recorded and the
next goal still runs. After the per-goal planning round, run the
**auto-investigate phase** (below) on the defects that round filed. Then give the
per-goal report.

## The per-goal round (for one goal G)

Loop the planner↔reviewer steps below until the planner returns a terminal token
(`awaiting-answers` / `completed` / `noop`). There is **NO hard iteration cap** —
the loop is bounded by the planner's state machine (it advances ONE step per
call toward a terminal phase) and, for the cross-command auto-investigate↔replan
axis, by the **concrete stop predicates** in the auto-investigate phase (cite
**K12**, which supersedes K8 pt3 and removed the former 4-iteration cap):

1. **Spawn the planner.** Use the `Agent` tool with
   `subagent_type: "plan-advance"`, passing the goal id (`$ARGUMENTS`) in the
   prompt. It performs EXACTLY ONE state-driven step against the goal and
   returns a single status token:
   - `awaiting-answers` — it filed (or left) `open` questions; the user must
     answer them. **Stop the loop.**
   - `review-requested` — it emitted or revised a plan. **Run the reviewer**
     (step 2), then continue the loop.
   - `completed` — the goal reached `planned` (or a terminal phase). **Stop.**
   - `noop` — nothing to do in the current state. **Stop.**

2. **Spawn the reviewer** (only on `review-requested`). Use the `Agent` tool
   with `subagent_type: "plan-reviewer"`, passing the goal id. It adversarially
   judges the emitted plan and WRITES a verdict item into the `reviews` ledger
   (`go-ahead` or `revise`). It returns a one-line pointer to the review id.
   Then **continue the loop** — the next `plan-advance` call reads that latest
   review and acts on it (revise the plan, ask new questions, or lock the
   decision and reach `planned`).

3. If the planner returned anything other than `review-requested`, **break**.

The loop terminates on the planner's terminal token; there is no numeric cap to
hit. If you observe the planner↔reviewer pair making no progress toward a
terminal phase (identical plan re-emitted and re-revised with no new criticism
resolved across consecutive iterations — a non-converging single-goal loop),
STOP and report it so the user can inspect the goal manually.

## Auto-investigate filed defects (after the per-goal round)

After the planner↔reviewer round for goal **G** completes, auto-investigate the
defects that round filed — this is **Change A** per decision **K12** (supersedes
K8 pt3's handoff direction only; K8 pts 1/2/4/5 stay in force). Per **Q42**:
auto-launch **always when possible**.

### Worklist = LEDGER QUERY (authoritative — NOT prose-parse)

Derive the worklist from the **ledger**, not from the plan-advance subagent's
prose summary. The subagent emits a single advisory status token; its prose is
ADVISORY ONLY and MUST NOT be the source of truth. Query the ledger for:

> every `open` **defect** whose `ledgerRefs` link the just-advanced goal
> (`goals:<G>`) and that has **no terminal status** (not `resolved`/`wontfix`)

(`fts_search`/`search_items` on the `defects` ledger filtered to `status:open`
with a `goals:<G>` ledgerRef; cross-check `fetch_item` as needed). This set —
NOT the subagent's summary — is the auto-investigate worklist for G.

### For each defect D in the worklist

Run **`/investigate:advance D` INLINE** in this same main session, exactly per
llm/commands/investigate/advance.md — **do NOT duplicate or re-implement that
logic; RUN it** (form/extend the hypothesis tree, dispatch read-only explorers,
validate citations, adjudicate). A *command* running another command's loop is
legal under K12; the subagents-cannot-spawn-subagents rule is preserved because
ONLY this orchestrator (a command) does the chaining — the `plan-advance` /
`plan-reviewer` subagents only FILE defects (T73), they never run
`/investigate:advance`.

**On a confirmed root cause**, the inline `/investigate:advance` pass performs
its own file-and-defer handoff: it writes `defects.rootCause`/`suggestedFix` and
**seeds or extends a defect-seeded goal** G′ (`ledgerRefs: ["defects:<D>"]`,
created `planning`, never `clarifying` — K8 pt4). The orchestrator MAY then
**auto-resume planning on that defect-seeded goal G′ in the same session** — run
the per-goal round on G′ (it skips clarification, K8 pt4 — Q42 "always when
possible"). This is convergence (a confirmed cause flowing into reviewed fix
tasks), not a fresh investigate round (see stop predicate (c)).

### awaiting-answers + defects-filed interaction (explicit)

When the primary round for G ended **`awaiting-answers`** (the reviewer's
`new_questions` sent G back to `clarifying`) **WHILE the same review's
`defects[]` were filed**, the two are **ORTHOGONAL**: the filed defects concern
code correctness, NOT G's clarification. Therefore:

- **STILL auto-investigate** the filed defects — run `/investigate:advance D`
  for each, exactly as above. The pending user questions on G do not block
  investigating D.
- **Do NOT auto-resume PLANNING** on a goal parked in `clarifying`. Whether that
  is G itself or a defect-seeded goal G′ that is sitting in `clarifying` on open
  questions, planning resumes **only after the user answers**. Auto-resume is
  permitted only for a defect-seeded goal that is `planning` (clarify-skipped per
  K8 pt4), never one parked on user questions.

### STOP BOUNDARY — concrete predicates (NO hard cap)

There is **NO fixed numeric cap** on the auto-investigate↔replan chain. K12
**removed** the former 4-iteration cap; the generic single-worktree
"no-progress" signals alone do NOT bound this cross-command axis. Instead, apply
**model-judged ill-loop detection** with the CONCRETE, operationally-pinned stop
predicates below. **When ANY predicate holds, STOP auto-relaunching, file an
`open` `questions` item to the user (ledgerRef the defect, and the goal where
relevant), and report it** — these predicates REPLACE the numeric cap:

(a) **Once per round.** Each filed defect D is auto-investigated **AT MOST ONCE
    per `/plan:advance` round.** Do not re-launch `/investigate:advance D` a
    second time within the same round.

(b) **No new evidence ⇒ no relaunch.** Do NOT re-launch on D if its `hypothesis`
    tree gained **NO new `confirmed` node and NO new `[correct]` evidence** since
    the previous round. (Re-running with nothing new cannot make progress.)

(c) **Seeded/extended ⇒ stop and report.** Once a `confirmed` root cause has
    **seeded or extended its defect-seeded goal**, STOP the investigate axis and
    report. Planning then resumes on that seeded goal — that is **convergence,
    not a new investigate round.** (Auto-resume of the seeded goal's *planning*
    is the per-goal round above, governed by K8 pt4, not another investigate
    pass.)

(d) **Non-converging cycle ⇒ stop and park.** A defect cycling
    `open → investigated → replanned → open` **WITHOUT convergence** — i.e.
    re-confirmed with **no NEW fix tasks**, or an **identical re-planned task
    set** to the prior round — STOP and park it on a user question.

(e) **Two dead rounds ⇒ stop and park.** **Two consecutive
    no-adjudicable-evidence rounds** for the same defect (the investigate pass
    came back unable to confirm/rule out anything from available evidence twice
    in a row) → STOP and park it on a user question.

(f) **Bounded per pass.** The per-pass budget is governed by (a)–(e): there is
    no fixed numeric cap, but each defect is bounded (once-per-round, requires
    new confidence to relaunch, stops on convergence or on a non-converging /
    dead cycle), so the pass provably converges.

## Session logs (after EVERY subagent returns)

Each subagent (planner and reviewer) ends its reply with a `### Session summary`
section. After each `Agent` call returns, persist that summary so the run leaves
a durable trace (the subagents are read-only and write nothing themselves):

1. Take `<agent-id>` from the `Agent` tool result (the returned agent id).
2. Stamp `<timestamp>` yourself: `date -u +%Y%m%d-%H%M%S` via `Bash`.
3. `Bash`: `mkdir -p docs/logs` (the dir is tracked via `.gitkeep`).
4. `Write` `docs/logs/<timestamp>-<agent-id>.md` containing a short header
   (which goal, which subagent/role, the returned status token or verdict) and
   the verbatim `### Session summary` block the subagent emitted.

Do this for the planner AND the reviewer on every iteration — one log file per
spawned subagent. The inline `/investigate:advance` pass logs its own
`investigate-explorer` subagents per llm/commands/investigate/advance.md
(§Session logs) — follow that command's logging rule while running it.

## Report to the user

After running the round on every target goal, read each goal
(`fetch_item("goals", <G>)`) for its current phase and give a **per-goal**
summary line (when run with no argument, one line for each goal advanced):
- the goal's id + current phase (`clarifying` / `planning` / `planned` / …);
- what the user must do next:
  - `awaiting-answers` → "answer the N open questions for goal G in the TUI/web,
    then run `/plan:advance G` again" (list the question ids);
  - `completed` → "plan approved and locked; goal G is now `planned`" (point to
    the milestones/tasks and the locked decision);
  - `noop` → why there was nothing to do.

Then, for the **auto-investigate phase**, add a line per defect D in the worklist
covering its outcome and the next action:
- **confirmed → seeded goal** — root cause confirmed; defect-seeded goal G′
  created/extended (ledgerRef `defects:<D>`). If G′ was auto-resumed and reached
  `planned`, say so (point to the fix tasks); else: "run `/plan:advance G′`".
- **parked on a question** — a stop predicate (d)/(e) or step-6 block fired; an
  `open` question was filed. "Answer question Qn in the TUI/web, then re-run."
- **no-new-evidence-stopped** — predicate (b): the tree gained no new
  `confirmed`/`[correct]` evidence, so D was not relaunched; another
  `/investigate:advance D` round is warranted only if new leads emerge.
- **ill-loop-stopped** — predicate (a)/(c)/(d)/(e)/(f) bounded the pass; state
  which predicate held and the filed question.

When no argument was given, finish with a one-line roll-up covering BOTH axes
(e.g. "3 goals advanced: 1 planned, 2 awaiting answers; 2 defects
auto-investigated: 1 confirmed→seeded goal, 1 parked on a question").
