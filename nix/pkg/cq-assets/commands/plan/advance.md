---
description: Advance plan-flow goals one full round — a given goal, or (no argument) every unlocked goal — running the planner↔reviewer loop until each needs the user or reaches `planned`.
argument-hint: [goalId]
allowed-tools: mcp__ledger__*, mcp__ledger__get_reviewers, mcp__ledger__get_planners, Agent, Write, Bash, Read, Grep, Glob
---

You are the **thin orchestrator** for the plan-flow advance loop. The argument
(may be empty) is:

> $ARGUMENTS

Subagents cannot spawn other subagents, so the planner↔reviewer LOOP lives here
in the main session. The **primary planning round** is itself **pluggable**
(step 1's *resolve-planners* sub-step): in the **single-planner fallback** the
native `plan-advance` subagent makes every goal/plan state change itself (you
write nothing — today's path, UNCHANGED); in the **configured multi-planner**
path you, the orchestrator, launch ALL active planners in parallel as
candidate-emitters (claude `plan-advance` in CANDIDATE mode + `pi:*` shellouts —
each RETURNS a candidate-plan JSON and writes nothing), run the **JUDGE+SYNTHESIS**
step that folds the strongest candidate together with the valuable parts of the
others into ONE synthesized plan, and then YOU — the orchestrator — are the ONLY
writer that persists that one plan to the ledger. The **review** step is likewise
pluggable (step 2): in the **single-reviewer fallback** the native `plan-reviewer`
subagent writes the one review itself (you write nothing); in the **configured
multi-reviewer** path you, the orchestrator, write the SINGLE aggregated
`reviews` item that reconciles all reviewers' verdicts (the native reviewers
return JSON and write nothing). Your job is to drive that loop, then run the
**auto-investigate phase** (below) on any defects the round filed, and relay the
outcome.

> The auto-investigate phase runs `/investigate:advance` **inline** (per K12 —
> a *command* may chain another command; a *subagent* still cannot). That phase,
> following llm/commands/investigate/advance.md, writes the ledger (the
> investigate loop's own writes), and the broadened `allowed-tools`
> (`mcp__ledger__*`, `Read`/`Grep`/`Glob`) supports it. The OTHER ledger writes
> you make are: the **configured multi-planner** synthesized plan (step 1's
> JUDGE+SYNTHESIS → orchestrator-persist, sub-step 1b-v) and the **configured
> multi-reviewer** aggregated `reviews` item (step 2b-iii). In the
> **single-planner fallback** the `plan-advance` subagent writes the plan and in
> the **single-reviewer fallback** the `plan-reviewer` subagent writes the
> review, so an unconfigured round stays read-only-to-you.

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

1. **Advance the plan** (spawn the planner). The planner step is **pluggable**,
   structurally mirroring the pluggable reviewer step (step 2) but with the
   **Q100 generate-N-then-JUDGE+SYNTHESIS** reconciliation model (NOT the
   reviewer's strictest-wins/union). Resolve which planners run, run them, and —
   in the multi-planner path — synthesize one plan and persist it yourself. The
   step yields the SAME single status token regardless of path; the loop reads
   that token below.

   1. **Resolve the active planner set.** Call the ledger MCP `get_planners`
      tool (registered in `.mcp.json`; returns
      `{ configured: boolean, planners: [{ harness, model, alias }] }`,
      `harness` ∈ {`claude`, `pi`} — mirrors `get_reviewers`).
      - If the tool is **absent** (server not registered) or it returns
        `configured: false` (no `cq.toml`, or an empty `[planners]` list), take
        the **single-planner fallback** (sub-step 1a — today's path, UNCHANGED).
      - If it returns `configured: true`, take the **multi-planner path**
        (sub-step 1b), AND honor any **session-only planner override** the user
        stated this run via `/cq:planners` (T16): an in-memory override
        supersedes the `cq.toml` default for THIS run only (it is never
        persisted) — use the overridden active set in place of `get_planners`'
        `planners` when one is in effect (exactly as `/cq:reviewers` overrides the
        reviewer set for step 2).

   1a. **Single-planner fallback** (unconfigured / tool absent — UNCHANGED
      behaviour: this is today's default plan-advance subagent path). Use the
      `Agent` tool with `subagent_type: "plan-advance"`, passing the goal id
      (`$ARGUMENTS`) in the prompt. The native `plan-advance` runs in its DEFAULT
      single-planner state-machine mode (it is NOT told it is a candidate): it
      performs EXACTLY ONE state-driven step against the goal, **writes the
      ledger itself** (files questions / emits or revises the plan / locks the
      decision and reaches `planned`), and returns a single status token. The
      orchestrator writes NOTHING for the plan this round. Take that returned
      token and go to **sub-step 1c** (read the token, drive the loop).

   1b. **Multi-planner path** (configured) — **generate-N-then-JUDGE+SYNTHESIS**
      (Q100/Q101). Launch ALL active planners **in parallel** as
      candidate-emitters (each RETURNS a candidate-plan JSON and writes NOTHING),
      then synthesize ONE plan and persist it YOURSELF. The native planner
      subagents and `pi:*` planners do **not** write the ledger in this path — the
      ORCHESTRATOR is the only writer (Q101), so `pi:*` planners (which cannot call
      MCP tools) participate fully as pure candidate-emitters.
      - **i. Per-planner launch (fan-out).** For each active planner token,
        dispatch it in CANDIDATE MODE and capture its candidate-plan JSON. The
        shared candidate-JSON contract is the one in `agents/plan-advance.md`'s
        **CANDIDATE mode** section: `{ milestones: [{ title, dependsOn? }], tasks:
        [{ headline, description, acceptance, suggestedModel, milestone,
        dependsOn?, ledgerRefs }], rationale }` (references are by
        title/headline, and each task's `milestone` names the work-milestone it
        attaches under). Every planner emits this SAME shape, so candidates are
        directly comparable.
        - `claude:<model>` → an `Agent` tool call with
          `subagent_type: "plan-advance"`, passing the goal id AND **explicitly
          requesting CANDIDATE mode** per T14 (state it is "one of N parallel
          candidate planners" / "candidate mode" / "generate-N-then-judge"). In
          that mode the native planner grounds itself read-only and RETURNS its
          candidate-plan JSON as a fenced `json` block, writing **NOTHING** to any
          ledger and emitting no status token. Capture the parsed candidate.
        - `pi:<model>` → shell out via `Bash` to the `pi` CLI using the confirmed
          **non-interactive** invocation from the **T169 spike (K30)**:
          `env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session --provider <P> --model <M> '<prompt>' </dev/null`
          (the combined `--model <P>/<M>` form also works; default `--mode text`
          emits the bare reply on stdout). Concrete provider/model pairs from K30:
          grok-build → `--provider grok-build --model grok-build`; gpt-5.5 →
          `--provider openai-codex --model gpt-5.5`. Both providers are
          OAuth-pre-authenticated. **The `env -u CODEX_COMPANION_SESSION_ID -u
          CLAUDE_PLUGIN_DATA … </dev/null` wrapper is REQUIRED, not cosmetic:**
          launched from inside this session pi inherits the codex-inline
          companion env and BLOCKS INDEFINITELY on the companion handshake when
          that companion is down (a real, output-less hang — verified); stripping
          that env and detaching stdin makes pi run standalone and FAST-FAIL on
          real errors instead — a quota-exhausted / unauthorized provider then
          exits non-zero with the error on stderr and empty stdout (e.g.
          openrouter `402 Insufficient credits`, exit 1, ~2s), which the
          abstention rule above catches. Feed it the **goal context** (the goal's
          title/description/grounding, its answered-question history, and any
          existing work-milestone tasks — the same material the native candidate
          planner reads) PLUS the **candidate-plan JSON contract** above, instructing
          it to emit EXACTLY that shape and nothing else. **Strip any code fence**
          before parsing — `pi` may wrap the JSON in a triple-backtick ` ```json `
          block. Capture the parsed candidate object.
        Collect the candidate plans from the planners that returned a usable
        candidate. **A planner that fails to return a usable candidate ABSTAINS**
        — a `pi` shellout that exits non-zero, emits empty stdout, or yields
        stdout that does not parse (after fence-strip) into the candidate
        contract, OR a `claude:*` candidate planner that returns no / garbled
        json — is DROPPED (logged with its alias + cause, §Session logs); the
        synthesis (ii) proceeds over the SURVIVING candidates. **No wall-clock
        timeout is imposed** (abstention keys ONLY on a RETURNED failure —
        non-zero exit, empty, or unparseable; a genuinely hung shellout is an
        operational stall to handle directly, never a silent abstention).
        **Quorum floor:** if EVERY configured planner abstained, fall back to the
        single-planner native path (sub-step 1a — the `plan-advance` subagent
        writes the plan) and REPORT that the configured planner panel was
        unavailable (which aliases abstained + why); the round never blocks on an
        unavailable panel and never synthesizes from zero candidates.
        Distinguish an abstention (a FAILURE to respond) from a deliberate empty
        candidate: if a SURVIVING candidate comes back with empty
        `milestones`/`tasks` and a `rationale` explaining the goal cannot be
        planned yet (still needs user clarification), that is a VALID signal —
        treat it as this step falling through to `awaiting-answers` (sub-step 1c).
      - **ii. JUDGE + SYNTHESIS (Q100 — fold-in, NOT pick-best-discard-rest).**
        Run a synthesis step — either inline as the orchestrator, or via a
        dedicated `plan-synthesizer` subagent (an `Agent` call) — over the N
        candidate plans. The judge **PICKS a strongest base candidate** (the one
        whose decomposition, sequencing, and `rationale` best achieve the goal's
        `description`) AND, **critically, FOLDS IN the valuable parts of the
        non-best candidates**: where a non-best planner contributed a milestone, a
        task, a sharper acceptance criterion, a better dependency edge, or a
        consideration the base candidate missed, INCORPORATE it into the result.
        The judge MUST NOT blindly discard the non-best candidates — when a
        non-best planner contributed something important, it is folded in. The
        output is ONE **synthesized plan** in the same candidate-JSON shape
        (milestones + tasks with title/headline references + rationale),
        reconciling milestone titles and task headlines, de-duplicating
        overlapping tasks, and keeping the union of genuinely-distinct work.
      - **iii. Orchestrator persists the ONE synthesized plan (Q101 — all writes
        are the orchestrator's).** YOU (the orchestrator), not any planner, write
        the synthesized plan to the ledger, exactly as the default single-planner
        mode would persist a plan (so `pi:*` planners — which never touch MCP —
        participate fully). Resolve the candidate's by-title/by-headline
        references to real ids as you persist:
        - `create_milestone(title, dependsOn?)` for each synthesized work
          milestone (resolve `dependsOn` titles → the `W…` ids you just created),
          and record those ids on the goal:
          `update_item("goals", G, fields: { milestones: [...] })` (preserve any
          ids already in `fields.milestones`, append the new ones).
        - `create_item("tasks", Wᵢ, status: "planned", fields: { headline,
          description, acceptance, suggestedModel, dependsOn?, ledgerRefs:
          ["goals:<G>"] })` for each synthesized task under its named work
          milestone `Wᵢ` (resolve `dependsOn` headlines → the `T…` ids). For a
          DEFECT fix task carry `"defects:<D>"` in `ledgerRefs` too, and write the
          bidirectional `defects.dependsOn` back-link, exactly as
          `agents/plan-advance.md` **Defect-aware planning** prescribes.
        - Transition the goal `update_item("goals", G, status: "planning")` (from
          `clarifying`) so it enters review, and persist a short grounding summary
          if the synthesis surfaced one. Stamp `author`/`session` on every write.
        After persisting, the step's status token is `review-requested` (a plan
        now exists and awaits the reviewer). Go to **sub-step 1c**.
      - The synthesized plan now lives in the ledger exactly as a single-planner
        plan would, so it enters the **SAME reviewer loop (step 2) UNCHANGED** —
        the pluggable reviewer step judges it identically whether it came from the
        single-planner fallback or this multi-planner synthesis.

   1c. **Read the status token and drive the loop.** Whichever path ran — fallback
      (1a, token from the subagent) or multi-planner synthesis (1b, token derived
      from the persisted outcome: `review-requested` after a plan was written,
      `awaiting-answers` if every candidate reported the goal still needs
      clarification, `completed`/`noop` if no planning step was possible) — act on
      the single status token:
      - `awaiting-answers` — questions are `open` (filed by the fallback subagent,
        or — when the multi-planner step could not yet plan — by a default
        single-planner pass you run to file them; candidate-mode planners file
        nothing). The user must answer them. **Stop the loop.**
      - `review-requested` — a plan was emitted or revised (by the fallback
        subagent, or by your multi-planner synthesis persist). **Run the reviewer**
        (step 2), then continue the loop.
      - `completed` — the goal reached `planned` (plan locked), or was already in a
        post-planning phase (`building`/`done`) when the step ran (no further
        planning step possible). **Stop.** The planner never auto-closes a goal to
        `done`; `building→done` is always the user's action.
      - `noop` — nothing to do in the current state. **Stop.**

2. **Review the plan** (only on `review-requested`). The review step is
   **pluggable**: a configurable set of reviewers may judge the plan in parallel
   and have their verdicts reconciled into ONE `reviews` item. Resolve which
   reviewers run, run them, reconcile, then continue the loop.

   1. **Resolve the active reviewer set.** Call the ledger MCP
      `get_reviewers` tool (registered in `.mcp.json`; returns
      `{ configured: boolean, reviewers: [{ harness, model, alias }] }`,
      `harness` ∈ {`claude`, `pi`}).
      - If the tool is **absent** (server not registered) or it returns
        `configured: false` (no `cq.toml`), take the **single-reviewer
        fallback** (sub-step 2a).
      - If it returns `configured: true`, take the **multi-reviewer path**
        (sub-step 2b), AND honor any **session-only reviewer override** the user
        stated this run via `/cq:reviewers` (T177): an in-memory override
        supersedes the `cq.toml` default for THIS run only (it is never
        persisted) — use the overridden active set in place of `get_reviewers`'
        `reviewers` when one is in effect.

   2a. **Single-reviewer fallback** (unconfigured / tool absent — UNCHANGED
      behaviour). Use the `Agent` tool with `subagent_type: "plan-reviewer"`,
      passing the goal id. In this mode the native `plan-reviewer` (T173) runs in
      its **fallback mode** and WRITES the verdict item into the `reviews` ledger
      itself (`go-ahead` or `revise`) — exactly today's path; the orchestrator
      writes NO reviews item. It returns a one-line pointer to the review id.
      Then go to **sub-step 2c** (continue the loop). EXACTLY ONE `reviews` item
      is written this round (by the reviewer).

   2b. **Multi-reviewer path** (configured). Launch ALL active reviewers **in
      parallel** and collect each one's verdict JSON. In this mode NO reviewer
      writes the ledger — the orchestrator writes the single aggregated item
      (sub-step 2b-iii).
      - **i. Per-reviewer launch.** For each active reviewer token:
        - `claude:<model>` → an `Agent` tool call with
          `subagent_type: "plan-reviewer"`, passing the goal id AND instructing
          it to run in **configured mode** per T173: it RETURNS its verdict JSON
          and writes **NOTHING** to the `reviews` ledger (in configured mode the
          native reviewer is one of several, so it never writes — the only
          ledger writer is the orchestrator, sub-step 2b-iii). Capture the
          returned `{ summary, verdict, new_questions, criticism, defects }`.
        - `pi:<model>` → shell out via `Bash` to the `pi` CLI using the
          confirmed **non-interactive** invocation from the **T169 spike (K30)**:
          `env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session --provider <P> --model <M> '<prompt>' </dev/null`
          (the combined `--model <P>/<M>` form also works; default
          `--mode text` emits the bare reply on stdout). Concrete provider/model
          pairs from K30: grok-build → `--provider grok-build --model grok-build`;
          gpt-5.5 → `--provider openai-codex --model gpt-5.5`. Both providers are
          OAuth-pre-authenticated. **The `env -u CODEX_COMPANION_SESSION_ID -u
          CLAUDE_PLUGIN_DATA … </dev/null` wrapper is REQUIRED** (same reason as
          the planner shellout in sub-step 1b-i: pi otherwise blocks indefinitely
          on the codex-inline companion handshake; stripping the env makes it
          fast-fail on real errors — e.g. a quota-exhausted provider exits
          non-zero with the error on stderr — which the abstention rule above
          catches). Feed it the **shared `/cq:plan-review` rubric
          prompt** (`commands/cq/plan-review.md`, T173) plus the goal/plan
          context (the goal's title/description/grounding, its Q&A history, and
          the emitted work-milestone tasks — the same material the native
          reviewer reads). Its stdout-json contract is the rubric's:
          `{ summary, verdict: "go-ahead"|"revise", new_questions: [],
          criticism: [], defects: [...] }`. **Strip any code fence** before
          parsing — `pi` may wrap the JSON in a triple-backtick ` ```json `
          block. Capture the parsed object.
        - **Abstention (no timeout).** A reviewer that fails to return a usable
          verdict ABSTAINS — a `pi` shellout that exits non-zero / emits empty
          stdout / yields stdout that does not parse (after fence-strip) into the
          verdict contract, or a `claude:*` reviewer that returns no / garbled
          json — is DROPPED from the panel (not counted `go-ahead`, not counted
          `revise`), logged with its alias + cause (§Session logs). No wall-clock
          timeout: abstention keys ONLY on a RETURNED failure; a hung shellout is
          an operational stall, not a silent abstention. Reconcile (ii) over the
          reviewers that DID return a usable verdict.
      - **ii. Reconcile (Q91) — STRICTEST-WINS + tagged UNION, over SURVIVORS.**
        Combine the SURVIVING reviewers' verdicts (abstainers excluded from BOTH
        the verdict and the union) into one:
        - **Quorum floor (all-abstain fallback):** if EVERY configured reviewer
          abstained (zero usable verdicts), fall back to the **single-reviewer
          path (sub-step 2a)** — the native `plan-reviewer` in its fallback mode
          writes the verdict itself, so SKIP 2b-iii — and REPORT that the
          configured panel was unavailable (which aliases abstained + why). The
          round NEVER blocks on an unavailable panel and never writes a verdict
          from zero usable reviews.
        - **Verdict:** `revise` if ANY surviving reviewer returned `revise`;
          `go-ahead` ONLY if ALL surviving reviewers returned `go-ahead`.
        - **Findings:** UNION every surviving reviewer's `new_questions`, `criticism`, and
          `defects`. **Prefix each finding with its source reviewer's alias**
          (e.g. `[grok] …`, `[opus] …`) so provenance survives the merge.
          De-duplicate obvious near-identical findings across reviewers, but bias
          to KEEP — when in doubt, retain both. (For `defects` objects, tag the
          `headline`.)
      - **iii. Orchestrator writes the ONE aggregated `reviews` item.** YOU (the
        orchestrator), not any reviewer, write the single reconciled verdict:
        `create_item("reviews", M, status: <reconciled verdict>, fields: {
        summary: "<one-line reconciled verdict>", new_questions: [<tagged
        union>], criticism: [<tagged union>], defects: [<tagged union>],
        ledgerRefs: ["goals:<G>"] })` (M = the goal's coordination milestone).
        **Preserve the invariant:** a `revise` must carry non-empty
        `new_questions` and/or `criticism` (those are what `revise` acts on);
        STRICTEST-WINS guarantees this because any reviewer that voted `revise`
        contributed at least one such finding. Stamp `author`/`session`. This is
        the SINGLE `reviews` item for the round.

   2c. **Continue the loop.** Either way — fallback (2a) or reconciled (2b) —
      EXACTLY ONE `reviews` item now exists for this round (no double-write).
      **Continue the loop**: the next `plan-advance` call reads that latest
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
ADVISORY ONLY and MUST NOT be the source of truth. Query the ledger by defect
**STATUS** (T116's queryable lifecycle, not a prose marker):

> every **defect** whose `ledgerRefs` link the just-advanced goal (`goals:<G>`)
> and whose `status` is still **ACTIONABLE** — `open`, `wip`, or `inconclusive`.
> (`root-caused` is READY-TO-SEED, handled by the seed gate below — NOT a fresh
> investigate target; `resolved`/`wontfix` are terminal and EXCLUDED.)

(`fts_search`/`search_items` on the `defects` ledger filtered to
`(status:open OR status:wip OR status:inconclusive)` with a `goals:<G>`
ledgerRef; cross-check `fetch_item` as needed). This set — NOT the subagent's
summary — is the auto-investigate worklist for G.

### For each defect D in the worklist

Run **`/investigate:advance D` INLINE** in this same main session, exactly per
llm/commands/investigate/advance.md — **do NOT duplicate or re-implement that
logic; RUN it** (form/extend the hypothesis tree, dispatch read-only explorers,
validate citations, adjudicate). A *command* running another command's loop is
legal under K12; the subagents-cannot-spawn-subagents rule is preserved because
ONLY this orchestrator (a command) does the chaining — the `plan-advance` /
`plan-reviewer` subagents only FILE defects (T73), they never run
`/investigate:advance`.

**When the defect reaches `status == root-caused`** (the READY-TO-SEED gate —
the inline `/investigate:advance` pass sets that status when it adjudicates the
defect's root cause, superseding the former rootCause-marker prose gate), that
pass performs its own file-and-defer handoff: it writes
`defects.rootCause`/`suggestedFix` and **seeds or extends a defect-seeded goal**
G′ (`ledgerRefs: ["defects:<D>"]`, created `planning`, never `clarifying` — K8
pt4). The orchestrator MAY then
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
5. **Populate `sessionLogs` on the outcome items** — the orchestrator owns the
   goal's `sessionLogs` write (the planner subagent updates the goal's phase,
   but after its log is written you, the orchestrator, must attach the path):
   - **After the planner step returns** and you have written its log file(s),
     call
     `update_item("goals", G, fields: { sessionLogs: ["docs/logs/<ts>-<agent-id>.md"] })`
     to record the log path(s) on the goal item. This keeps the goal's session
     provenance without a separate pass.
     - In the **single-planner fallback (1a)** there is ONE `plan-advance`
       subagent log (the returned agent id) — record that path.
     - In the **multi-planner path (1b)** record a log for EVERY candidate planner
       that ran this round (one `claude`-subagent log file per `claude:*`
       candidate planner, plus one `pi`-stdout log file per `pi:*` candidate
       planner — same treatment as the multi-reviewer logs below), and a log for
       the synthesis step if it ran as a `plan-synthesizer` subagent. Attach all
       those paths to the goal's `sessionLogs`.
   - **After the review step completes** — single-reviewer fallback (2a) or
     multi-reviewer reconciliation (2b) — attach the log path(s) to the ONE
     `reviews` item the round produced:
     `update_item("reviews", <reviewId>, fields: { sessionLogs: [<log path(s)>] })`.
     - In the **fallback (2a)** the native reviewer subagent created the review
       item; use the review id it reported (or look it up via `fts_search` on
       the reviews ledger for the just-created verdict), with the one
       `claude`-subagent log path.
     - In the **configured (2b)** path YOU created the aggregated review item
       (sub-step 2b-iii), so you already have its id; attach the log paths for
       **every** reviewer that ran this round (one `claude`-subagent log file per
       `claude:*` reviewer, plus one `pi`-stdout log file per `pi:*` reviewer).

   For each **`pi:*` reviewer OR `pi:*` candidate planner** (no `Agent` result,
   so no returned agent id), write a log file the same way:
   `<timestamp>-pi-<alias>.md` under `docs/logs/`, containing a short header
   (which goal, the alias + `pi` provider/model, and the parsed verdict for a
   reviewer or "candidate plan emitted" for a planner) and the **verbatim
   captured stdout** (including the raw, pre-fence-strip text). This makes each pi
   shellout's reply a durable trace exactly like the subagent summaries.

Do this for the planner step (the fallback subagent, or every candidate planner +
the synthesis step in the multi-planner path) AND every reviewer on every
iteration — one log file per spawned subagent and per pi shellout. The inline `/investigate:advance` pass logs
its own `investigate-explorer` subagents per llm/commands/investigate/advance.md
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
    the milestones/tasks and the locked decision); if the goal was already
    `building` or `done` when the planner ran (no planning step needed), report
    the current phase and note that implementation is in progress or already
    complete — the user closes `building→done` via the TUI/web;
  - `noop` → why there was nothing to do.

Then, for the **auto-investigate phase**, add a line per defect D in the worklist
covering its outcome and the next action:
- **root-caused → seeded goal** — defect reached `status == root-caused`;
  defect-seeded goal G′ created/extended (ledgerRef `defects:<D>`). If G′ was
  auto-resumed and reached `planned`, say so (point to the fix tasks); else:
  "run `/plan:advance G′`".
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

---

## Handoff record (STANDALONE only — suppressed when chained)

> **Your stop is PROGRESS-bounded, never EFFORT-bounded.** Stop ONLY when this
> flow's own stop predicate fires — a terminal planner token (`awaiting-answers`
> / `completed` / `noop`), the auto-investigate stop predicates (a)–(f), or
> everything parked on an `open` user question — NEVER because the run is long,
> costly, used many subagents, reached "a natural milestone", or the remaining
> work feels disproportionate. The handoff status you write is the gate: one of
> `drained` / `answers-required` / `mixed` / `illness-detected`, each requiring a
> real predicate condition — there is no status for an effort-based stop. If
> tempted to stop while progress is still possible, CONTINUE. (See
> llm/commands/cq/advance.md §Stop condition.)

Whether you write a `handoffs` record at your stop depends ENTIRELY on your
invocation context — there is **no env var or process signal** to read. You,
the executing agent, run both this command and (when chained) the wrapping
`/cq:advance` command in the SAME inline session, so you already KNOW which
context you are in.

- **Run STANDALONE** (the user invoked `/plan:advance` directly, with no
  wrapping flow command): after the §Report, write ONE `handoffs` record for
  this stop — `create_item("handoffs", <milestone>, <status>, <fields>)` —
  mapping your end-of-round classification (across BOTH axes) to the handoff
  `status`:

  | This round's stop                                                          | handoff `status`   |
  | -------------------------------------------------------------------------- | ------------------ |
  | every target goal reached `planned`/terminal, nothing left to advance      | `drained`          |
  | one or more goals/defects `awaiting-answers` / parked on an `open` question | `answers-required` |
  | both at once — some goals planned/drained, others awaiting answers          | `mixed`            |
  | a stop predicate (a)/(c)–(f) bounded the pass / an invariant violation      | `illness-detected` |

  Field set (per `HANDOFFS_SCHEMA`; consistent with cq/advance.md §Provenance):
  `summary` (**required** — the why-it-stopped prose, mirror the §Report);
  `flow` = `plan`; `ledgerRefs` = the stop-causing items (`goals:<G>`,
  `defects:<D>`); `blockingQuestions` = the `open` question ids for an
  `answers-required`/`mixed` stop; `handoffReasons` = the component reasons for
  a `mixed` stop (e.g. `[drained, answers-required]`); `sessionLogs` = the
  `docs/logs/<ts>-<agent-id>.md` path(s) written this round — populate them in
  the SAME `create_item` call. Stamp `author`/`session`. Append-only: written
  once at the stop, never updated. (The auto-investigate sub-rounds this command
  chains do NOT each write a handoff — investigate/advance.md suppresses its own
  handoff whenever chained, so this one record covers the whole pass.) **Then
  commit the ledger** (§Commit the ledger): stage the ledger artifacts only and
  commit, so a standalone plan round never leaves the ledger uncommitted.

- **Run CHAINED INLINE by any wrapping flow command** (`/cq:advance`, or a
  `/<flow>:start` / `/<flow>:follow-up` that runs this pass inline):
  **SUPPRESS this handoff write** — AND suppress the at-stop ledger commit (the
  outermost wrapper owns both). The outermost wrapper owns the single
  authoritative run-level handoff and writes it once at its stop — `/cq:advance`
  per its §Provenance (it is the sole `handoffs` writer for the whole run);
  a `/<flow>:start` or `/<flow>:follow-up` writes it directly in its own
  §Handoff record step. You can tell you are in this context because the
  wrapping command explicitly chains you and its prompt instructs this
  suppression; a standalone invocation has no such wrapper. Suppressing here is
  what guarantees exactly ONE handoff per run — never a duplicate.

## Commit the ledger (standalone stop)
After the standalone handoff write, persist the ledger to git — and ONLY the
ledger (`docs/*.md` + `docs/archive` + `docs/logs`; NEVER `docs/ledgers.yaml`,
gitignored; NEVER code):
```
git add docs/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- docs/ || git commit -q -m "chore(ledger): /plan:advance — <stop: <status>>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed.
SUPPRESS this commit when chained (the wrapper owns the single run-stop commit).
