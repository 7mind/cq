---
description: Advance plan-flow goals one full round — a given goal, or (no argument) every unlocked goal — running the planner↔reviewer loop until each needs the user or reaches `planned`.
argument-hint: [goalId]
allowed-tools: mcp__ledger__*, mcp__ledger__get_reviewers, mcp__ledger__get_planners, Agent, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "optional goal id G ($ARGUMENTS); empty = advance all unlocked goals (clarifying/planning)"
  - "ledger state for each target goal: phase, Q&A history, latest review, work-milestone tasks"
  - "get_planners result: configured: bool, planners[] (harness/model/alias)"
  - "get_reviewers result: configured: bool, reviewers[] (harness/model/alias)"
outputs:
  - "planner ledger writes (questions / plan / revision / decision + planned) via plan-advance subagent or orchestrator persist"
  - "one aggregated reviews item per round (written by reviewer subagent or orchestrator)"
  - "auto-investigate: /cq:investigate:advance inline for each goal-linked actionable defect"
  - "per planner/reviewer: a summary log .cq/logs/<timestamp>-<agent-id>.md AND a raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl (pi:* → .cq/logs/raw/<ts>-pi-<alias>.md plain), BOTH written via `cq log put`"
  - "handoffs item (standalone only) and ledger git commit (standalone only)"
ioSchema:
  - "planner loop token: awaiting-answers | review-requested | completed | noop"
  - "single-planner fallback: plan-advance writes the ledger; orchestrator writes nothing for the plan"
  - "multi-planner path: orchestrator persists synthesized plan; candidate JSON: {milestones[], tasks[], rationale}"
  - "review verdict JSON: {summary, verdict, new_questions[], criticism[], defects[]}"
  - "auto-investigate stop predicates a-f (once-per-round, no-new-evidence, seeded/extended, non-converging, two dead rounds)"
```

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

> The auto-investigate phase runs `/cq:investigate:advance` **inline** (per K12 —
> a *command* may chain another command; a *subagent* still cannot). That phase,
> following llm/commands/cq/investigate/advance.md, writes the ledger (the
> investigate loop's own writes), and the broadened `allowed-tools`
> (`mcp__ledger__*`, `Read`/`Grep`/`Glob`) supports it. The OTHER ledger writes
> you make are: the **configured multi-planner** synthesized plan (step 1's
> JUDGE+SYNTHESIS → orchestrator-persist, sub-step 1b-v) and the **configured
> multi-reviewer** aggregated `reviews` item (step 2b-iii). In the
> **single-planner fallback** the `plan-advance` subagent writes the plan and in
> the **single-reviewer fallback** the `plan-reviewer` subagent writes the
> review, so an unconfigured round stays read-only-to-you.

## Auto-fetch the ledger ref at run START (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`** (NOT the default `fs`
backend), auto-fetch the orphan ledger branch from the configured remote ONCE at
the very start of the run, BEFORE selecting the target goal(s) below — so the
round reads the latest shared ledger state. When the backend is `fs` (the
default, or no `cq.toml`), SKIP this step entirely; it does NOTHING on the
filesystem backend. **Suppress this fetch when chained** under a wrapping flow
command (`/cq:advance` / `/<flow>:start` / `/<flow>:follow-up`) — the wrapper owns
the single run-START fetch (mirroring the at-stop handoff/commit suppression); run
it only on a STANDALONE `/cq:plan:advance` invocation.

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

## Select the target goal(s)

- **`$ARGUMENTS` is a goal id** → the target set is just that one goal.
- **`$ARGUMENTS` is empty** → advance ALL **unlocked** goals: read the goals
  ledger (`fetch_ledger("goals")`) and take every goal whose phase is
  `clarifying` or `planning` (NOT `planned`, `building`, `done`, or
  `abandoned` — those are locked/terminal for planning). If none qualify, report
  "no unlocked goals" and stop.

> **NEVER FABRICATE A GOAL.** `plan:advance` only *advances goals that already
> exist* — goals are created solely by `/cq:plan` at the user's request. An empty
> goals ledger, or one whose goals are all `planned`/terminal, means there is
> **nothing to advance**: write a `drained` handoff and STOP. Do **not**
> `create_item("goals", …)`, `create_milestone`, or invent a
> "bootstrap"/"sample"/"exercise-the-flow" goal to have something to do — that is
> the classic empty-repo ill-state, a DEFECT, not progress. When there are no
> unlocked goals: STOP.
>
> **Narrow carve-out — the `/cq:advance` SEED stage (Q259 option A / D94).** There
> is exactly ONE sanctioned AUTONOMOUS goal creator: the `/cq:advance` **Seed
> stage** (cross-reference `commands/cq/advance.md` §The cycle, Seed stage). It
> creates goals ONLY for **defect-seeded** fix goals produced by the mechanical
> transform of a CONFIRMED root cause — `root-caused`, severity at/above the floor
> (critical/high), batch-capped (`SEED_BATCH_CAP` = 5 per pass), cluster-grouped
> (one batch → ONE goal), and back-linked (`goals:<G>` into each defect's
> `ledgerRefs`). That carve-out lives in `/cq:advance`, NOT here: **`plan:advance`
> ITSELF still NEVER creates a goal** — not even a defect-seeded one — and the
> empty-goals-ledger ill-state rule above stays FULLY in force. When there are no
> unlocked goals, `plan:advance` STOPS; it never seeds one to have work to do.

Run **the per-goal round below independently for EACH** target goal **G**. Treat
goals independently: one that stops at `awaiting-answers` is recorded and the
next goal still runs. After the per-goal planning round, run the
**auto-investigate phase** (below) on the defects that round filed. Then give the
per-goal report.

## The per-goal round (for one goal G)

> **DISPATCHING A SUBAGENT IS HARNESS-NEUTRAL.** Wherever a step below says
> "spawn the planner", "use the `Agent` tool with `subagent_type: <name>`", or
> "dispatch the `<name>` subagent", that is one action with a per-harness tool:
> - **claude** → the `Agent` tool: `Agent(subagent_type: "<name>", …)`.
> - **pi** → the `dispatch_agent` tool: `dispatch_agent(agent: "<name>",
>   task: "<the full prompt/goal-id + mode instruction>")` (registered by the
>   cq-subagent-dispatch extension; it runs the same cq agent as an isolated
>   child turn and returns its final text).
>
> Use whichever your harness (`CQ_HARNESS`) provides. **Do NOT hand-simulate the
> subagent's job inline** by reading and mutating the ledger yourself in place of
> a dispatch — that both skips the agent's state machine and is a primary cause
> of the read-only ill-loop below. If a step calls for a subagent, DISPATCH it.

> **FORWARD-PROGRESS INVARIANT — every loop iteration must change state or
> dispatch, else STOP.** Each pass of the loop below MUST do exactly one of:
> dispatch a subagent, or make a state-changing ledger WRITE (file a question,
> persist/revise a plan, lock a decision, record a review). Re-reading the ledger
> (`fetch_*` / `list_*` / `search_*` / `derive_predicates` / `snapshot`) is NOT
> progress. If you have reached a **terminal token** — `awaiting-answers` (an
> `open` question now exists), `completed`, or `noop` — **STOP the loop
> immediately** and write the handoff; do not re-read the ledger "to check", do
> not look for more to do. Two consecutive read-only iterations with no write and
> no dispatch means you are ill-looping: STOP and report where you are.

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
      orchestrator writes NOTHING for the plan this round.

      **Catalog-driven dispatch (G41, Q185 steps a–g) — the proof path.** Drive
      this `plan-advance` dispatch through the typed prompt-catalog MCP tools the
      ledger-mcp server added in T343 (`fetch_prompt` / `validate_input` /
      `validate_output`). The full sequence is:
      - **(a) fetch the prompt template.** Call `fetch_prompt("plan-advance")`
        for the role's `promptTemplate` plus its typed `inputSchema` /
        `outputSchema` (the dispatched-subagent payload — `plan-advance` is a
        dispatched subagent, so the schemas are present).
      - **(b) take its `inputSchema`.** Read the `inputSchema` off that
        `fetch_prompt` result — the input contract for the dispatch.
      - **(c) compose the input.** Build the input object against that schema:
        `{ goalId: "<G>" }` (`$ARGUMENTS`), with `candidateMode` omitted/false in
        this single-planner mode.
      - **(d) validate the input.** Call `validate_input("plan-advance", input)`.
        On `{ ok: false, errors }`, FIX the composed input and re-validate — do
        NOT dispatch an input the schema rejects.
      - **(e) run the subagent.** Dispatch the `Agent` (`subagent_type:
        "plan-advance"`) with the validated input rendered into the prompt
        (goal id + DEFAULT mode), as above.
      - **(f) await the output.** Capture the subagent's reply — its status token
        (and, for a candidate run, its candidate JSON).
      - **(g) validate the output.** Call `validate_output("plan-advance",
        output)` against the role's `outputSchema`. A validation failure is a
        contract breach to surface (log it, §Session logs), not silently dropped.

      **Degrade gracefully when the catalog tools are absent** (an older or
      embedded ledger-mcp server that predates T343 does not advertise
      `fetch_prompt` / `validate_input` / `validate_output`) — exactly like the
      `get_agent_models` / `get_planners` / `get_reviewers` tool-absence paths:
      when these tools are unavailable, SKIP steps (a)–(d) and (g) and fall
      straight through to the bare `Agent` dispatch (step (e)) on the prompt as
      authored. The validate steps are an ADDITIVE contract check, never a hard
      dependency — their absence never blocks the round.

      Take the returned token and go to **sub-step 1c** (read the token, drive
      the loop).

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
          `subagent_type: "plan-advance"`, `model: <the resolved planner token's
          bare-alias model, VERBATIM>`, passing the goal id AND **explicitly
          requesting CANDIDATE mode** per T14 (state it is "one of N parallel
          candidate planners" / "candidate mode" / "generate-N-then-judge"). In
          that mode the native planner grounds itself read-only and RETURNS its
          candidate-plan JSON as a fenced `json` block, writing **NOTHING** to any
          ledger and emitting no status token. Capture the parsed candidate. The
          token's `effort` is **N/A at `Agent` dispatch** — the Agent tool
          exposes no per-dispatch effort/reasoning param (T510; `effort` exists
          only as subagent-definition frontmatter) — record it for
          provenance/display only. **Model-scope precedence (Q253/R602):** in
          this CONFIGURED multi-planner path, the `[harness.claude].planners`
          PANEL config is what governs the `plan-advance` model dispatched here
          — `[agent_tiers]` governs ONLY the single-planner fallback (sub-step
          1a) and the agentsCatalogue display, never this panel path.
        - `pi:<model>` → shell out via `Bash` to the `pi` CLI using the confirmed
          **non-interactive** invocation from the **T169 spike (K30)**:
          `env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session --provider <P> --model <M> '<prompt>' </dev/null`
          (the combined `--model <P>/<M>` form also works; default `--mode text`
          emits the bare reply on stdout). Concrete provider/model pairs from K30:
          grok-build → `--provider grok-build --model grok-build`; gpt-5.5 →
          `--provider openai-codex --model gpt-5.5`. Both providers are
          OAuth-pre-authenticated. When the resolved planner token carries an
          `effort`, emit it as the R342 shorthand — `--model
          <provider>/<model>:<effort>` (e.g. `--model
          openai-codex/gpt-5.5:xhigh`); with no effort, the bare `--model
          <provider>/<model>` form. **The `env -u CODEX_COMPANION_SESSION_ID -u
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

      **Catalog-driven dispatch (G41 — plan-reviewer).** Drive this
      `plan-reviewer` dispatch through the same typed prompt-catalog MCP tools the
      `plan-advance` dispatch uses in sub-step 1a, MIRRORING that a–g sequence for
      the `plan-reviewer` role: **(a)** `fetch_prompt("plan-reviewer")` for its
      `promptTemplate` + typed `inputSchema`/`outputSchema` (present — a dispatched
      subagent); **(b–c)** compose the input against that `inputSchema`
      (`{ goalId: "<G>" }`); **(d)** `validate_input("plan-reviewer", input)`, fix
      and re-validate on `{ ok: false, errors }`; **(e)** dispatch the `Agent`
      (`subagent_type: "plan-reviewer"`) with the validated input rendered into the
      prompt; **(f–g)** await its reply and `validate_output("plan-reviewer",
      output)` against the role's `outputSchema` (a validation failure is a
      contract breach to surface, §Session logs). **Degrade gracefully when the
      catalog tools are absent** — exactly as sub-step 1a degrades for
      `plan-advance`: skip (a)–(d) and (g) and fall straight through to the bare
      `Agent` dispatch (e). The validate steps are an ADDITIVE contract check,
      never a hard dependency.

   2b. **Multi-reviewer path** (configured). Launch ALL active reviewers **in
      parallel** and collect each one's verdict JSON. In this mode NO reviewer
      writes the ledger — the orchestrator writes the single aggregated item
      (sub-step 2b-iii).
      - **i. Per-reviewer launch.** For each active reviewer token:
        - `claude:<model>` → an `Agent` tool call with
          `subagent_type: "plan-reviewer"`, `model: <the resolved reviewer
          token's bare-alias model, VERBATIM>`, passing the goal id AND
          instructing it to run in **configured mode** per T173: it RETURNS its
          verdict JSON and writes **NOTHING** to the `reviews` ledger (in
          configured mode the native reviewer is one of several, so it never
          writes — the only ledger writer is the orchestrator, sub-step
          2b-iii). Capture the returned `{ summary, verdict, new_questions,
          criticism, defects }`. The token's `effort` is **N/A at `Agent`
          dispatch** — the Agent tool exposes no per-dispatch effort/reasoning
          param (T510; `effort` exists only as subagent-definition frontmatter)
          — record it for provenance/display only. **Model-scope precedence
          (Q253/R602):** in this CONFIGURED multi-reviewer path, the
          `[harness.claude].reviewers` PANEL config is what governs the
          `plan-reviewer` model dispatched here — `[agent_tiers]` governs ONLY
          the single-reviewer fallback (sub-step 2a) and the agentsCatalogue
          display, never this panel path.
        - `pi:<model>` → shell out via `Bash` to the `pi` CLI using the
          confirmed **non-interactive** invocation from the **T169 spike (K30)**:
          `env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA pi -p --no-tools --no-session --provider <P> --model <M> '<prompt>' </dev/null`
          (the combined `--model <P>/<M>` form also works; default
          `--mode text` emits the bare reply on stdout). Concrete provider/model
          pairs from K30: grok-build → `--provider grok-build --model grok-build`;
          gpt-5.5 → `--provider openai-codex --model gpt-5.5`. Both providers are
          OAuth-pre-authenticated. When the resolved reviewer token carries an
          `effort`, emit it as the R342 shorthand — `--model
          <provider>/<model>:<effort>` (e.g. `--model
          openai-codex/gpt-5.5:xhigh`); with no effort, the bare `--model
          <provider>/<model>` form. **The `env -u CODEX_COMPANION_SESSION_ID -u
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
        - **Off-enum verdict ⇒ ABSTENTION (fail-loud, BEFORE reconcile).** After
          parsing the verdict contract, VALIDATE the `verdict` string against the
          closed plan-review enum `{go-ahead, revise}` (the literal enum in
          `commands/cq/plan-review.md`). If `verdict` is NOT EXACTLY `go-ahead`
          or `revise`, treat that reviewer as ABSTAINING — DROP it from the panel
          (not counted `go-ahead`, not counted `revise`), exactly as the
          abstention rule above drops an unparseable verdict, and LOG it with the
          reviewer's alias + the raw off-enum value + cause (§Session logs). Do
          NOT normalize or recover synonyms — an off-enum value is an ABSTENTION,
          NEVER a value to coerce into a canonical enum (silent coercion would
          defeat the fail-loud contract). This validation runs BEFORE the
          reconcile string-equality (ii) so an off-enum value can never reach
          reconcile.
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
> (`root-caused` is READY-TO-SEED and is the **`/cq:advance` Seed stage's**
> consumer — `commands/cq/advance.md` §The cycle, Seed stage, drains the unowned
> root-caused backlog via P-seed — NOT a fresh investigate target here;
> `resolved`/`wontfix` are terminal and EXCLUDED.)

(`fts_search`/`search_items` on the `defects` ledger filtered to
`(status:open OR status:wip OR status:inconclusive)` with a `goals:<G>`
ledgerRef; cross-check `fetch_item` as needed). This set — NOT the subagent's
summary — is the auto-investigate worklist for G.

### For each defect D in the worklist

Run **`/cq:investigate:advance D` INLINE** in this same main session, exactly per
llm/commands/cq/investigate/advance.md — **do NOT duplicate or re-implement that
logic; RUN it** (form/extend the hypothesis tree, dispatch read-only explorers,
validate citations, adjudicate). A *command* running another command's loop is
legal under K12; the subagents-cannot-spawn-subagents rule is preserved because
ONLY this orchestrator (a command) does the chaining — the `plan-advance` /
`plan-reviewer` subagents only FILE defects (T73), they never run
`/cq:investigate:advance`.

**When the defect reaches `status == root-caused`** (the READY-TO-SEED gate —
the inline `/cq:investigate:advance` pass sets that status when it adjudicates the
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

- **STILL auto-investigate** the filed defects — run `/cq:investigate:advance D`
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
    per `/cq:plan:advance` round.** Do not re-launch `/cq:investigate:advance D` a
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

## Research items the planner filed are driven by `/cq:advance`, NOT here (Q267)

The `plan-advance` planner subagent (`agents/plan-advance.md`) may file
`researches` items for EMPIRICAL unknowns — the Q267 triage rule: an
empirically-answerable unknown (which library / data structure / approach
performs best; a verifiable-by-experiment fact) becomes an `open` `researches`
item linked `goals:<G>` INSTEAD of a user question, while user questions stay
reserved for preference/requirements decisions. Those research items are **NOT
this orchestrator's to drive.** Unlike the defects the round files — which THIS
orchestrator auto-investigates INLINE (the auto-investigate phase above) — an
actionable `researches` item linked `goals:<G>` is driven by **`/cq:advance`'s
RESEARCH stage** (`commands/cq/advance.md` §The cycle → Research stage, which
runs `/cq:research:advance` on each actionable research). `/cq:plan:advance` does
**NOT** spawn research subagents itself and does NOT chain `/cq:research:advance`:
subagents-cannot-spawn-subagents holds (the planner subagent only FILES the
research), and the flow-level `/cq:advance` wrapper owns the research stage and
its P-research gate. Treat any filed research item as advisory context in the
§Report only; it is picked up by the next `/cq:advance` cycle's research stage.

## Session logs (after EVERY subagent returns)

Each subagent (planner and reviewer) ends its reply with a `### Session summary`
section. **ALL log writes go through `cq log put` under BOTH backends — never a
direct `Write` to `.cq/logs/`, and never `git add` a log file** (`cq log put`
does redaction + strict-JSONL validation IN the CLI, and under `git-object`
commits the log to the orphan ref itself; under `fs` it writes the file under
`.cq/logs/`, which the per-round ledger checkpoint already carries). Stamp
`<timestamp>` (`Bash`: `date -u +%Y%m%d-%H%M%S`) once per returned subagent.

**Native `Agent` subagent (planner / reviewer / `plan-synthesizer`).** Take
`<agent-id>` from the tool result, then:
1. **Locate its native transcript** at
   `~/.claude/projects/<slug>/<session>/subagents/agent-<agent-id>.jsonl` — the
   `<slug>` is derived from the ledger root path (Claude's project-dir slug; the
   absolute ledger-root path with `/` → `-`), and `<session>` =
   `$CLAUDE_CODE_SESSION_ID`.
2. **Pipe the transcript through `cq log put`** for redaction + strict-JSONL
   validation in the CLI:
   `cat <transcript> | cq log put --stdin --dest logs/raw/<timestamp>-<agent-id>.jsonl`.
3. **Write the summary** (a short header — which goal, which subagent/role, the
   returned status token or verdict — plus the verbatim `### Session summary`
   block) via `cq log put` to `logs/<timestamp>-<agent-id>.md` (e.g. compose the
   header+summary to a temp file or pipe via
   `--stdin --dest logs/<timestamp>-<agent-id>.md`).
4. **Record BOTH paths on the outcome item**: `sessionLogs +=` the
   `.cq/logs/<timestamp>-<agent-id>.md` summary path; `rawLogs +=` the
   `.cq/logs/raw/<timestamp>-<agent-id>.jsonl` raw path (on the goal for a
   planner / synthesis log, on the `reviews` item for a reviewer log — see the
   per-step routing below).

**Absent transcript (older run / crash / non-Claude harness).** When the
`agent-<agent-id>.jsonl` file does not exist, do NOT fabricate a raw log: write an
explicit `raw transcript unavailable: <reason>` line in the summary-log HEADER
(via `cq log put` to `logs/<timestamp>-<agent-id>.md`) and proceed summary-only —
add ONLY the `.md` to `sessionLogs`, leave `rawLogs` un-extended for that subagent.

**`pi:*` shellout (candidate planner / reviewer).** There is no native `Agent`
id and no `.jsonl` transcript — the verbatim shellout **stdout IS the raw log**.
Route it through `cq log put` to a PLAIN/markdown dest (NOT `.jsonl`):
`… | cq log put --stdin --dest logs/raw/<timestamp>-pi-<alias>.md` — the pi
reply's VERBATIM stdout (including the raw, pre-fence-strip text). Capture this
even when its stdout was unparseable (so a failed external planner/reviewer
leaves a trace). Also write a summary `.md` (header: which goal, the alias + `pi`
provider/model, and the parsed verdict for a reviewer or "candidate plan emitted"
for a planner) via `cq log put` to `logs/<timestamp>-pi-<alias>.md`. Add the
summary `.md` to the outcome item's `sessionLogs` and the raw
`logs/raw/<timestamp>-pi-<alias>.md` to its `rawLogs`.

**Populate `sessionLogs`+`rawLogs` on the outcome items** — the orchestrator owns
the goal's and the `reviews` item's log writes (the planner subagent updates the
goal's phase, but after its logs are written you, the orchestrator, must attach
the paths):
- **After the planner step returns** and you have written its log(s), call
  `update_item("goals", G, fields: { sessionLogs: [".cq/logs/<ts>-<agent-id>.md", ...], rawLogs: [".cq/logs/raw/<ts>-<agent-id>.jsonl", ...] })`
  to record the log path(s) on the goal item — both buckets in the SAME call.
  (Omit a `rawLogs` entry for any subagent whose transcript was absent.) This
  keeps the goal's session provenance without a separate pass.
  - In the **single-planner fallback (1a)** there is ONE `plan-advance` subagent
    log pair (the returned agent id) — record that `.md`+`.jsonl`.
  - In the **multi-planner path (1b)** record a log pair for EVERY candidate
    planner that ran this round (one `claude`-subagent `.md`+`.jsonl` pair per
    `claude:*` candidate planner, plus one `pi`-stdout summary `.md` + raw `.md`
    per `pi:*` candidate planner), and a log pair for the synthesis step if it
    ran as a `plan-synthesizer` subagent. Attach all those paths to the goal's
    `sessionLogs`/`rawLogs`.
- **After the review step completes** — single-reviewer fallback (2a) or
  multi-reviewer reconciliation (2b) — attach the log path(s) to the ONE
  `reviews` item the round produced:
  `update_item("reviews", <reviewId>, fields: { sessionLogs: [<summary path(s)>], rawLogs: [<raw path(s)>] })`.
  - In the **fallback (2a)** the native reviewer subagent created the review
    item; use the review id it reported (or look it up via `fts_search` on the
    reviews ledger for the just-created verdict), with the one `claude`-subagent
    `.md`+`.jsonl` pair.
  - In the **configured (2b)** path YOU created the aggregated review item
    (sub-step 2b-iii), so you already have its id; attach the log paths for
    **every** reviewer that ran this round (one `claude`-subagent `.md`+`.jsonl`
    pair per `claude:*` reviewer, plus one `pi`-stdout summary `.md` + raw `.md`
    per `pi:*` reviewer).

Do this for the planner step (the fallback subagent, or every candidate planner +
the synthesis step in the multi-planner path) AND every reviewer on every
iteration — one log pair per spawned subagent and per pi shellout, ALL via
`cq log put`. The inline `/cq:investigate:advance` pass logs its own
`investigate-explorer` subagents per llm/commands/cq/investigate/advance.md
(§Session logs) — follow that command's logging rule while running it.

## Report to the user

After running the round on every target goal, read each goal
(`fetch_item("goals", <G>)`) for its current phase and give a **per-goal**
summary line (when run with no argument, one line for each goal advanced):
- the goal's id + current phase (`clarifying` / `planning` / `planned` / …);
- what the user must do next:
  - `awaiting-answers` → "answer the N open questions for goal G in the TUI/web,
    then run `/cq:plan:advance G` again" (list the question ids);
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
  "run `/cq:plan:advance G′`".
- **parked on a question** — a stop predicate (d)/(e) or step-6 block fired; an
  `open` question was filed. "Answer question Qn in the TUI/web, then re-run."
- **no-new-evidence-stopped** — predicate (b): the tree gained no new
  `confirmed`/`[correct]` evidence, so D was not relaunched; another
  `/cq:investigate:advance D` round is warranted only if new leads emerge.
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
> everything parked on an `open` user question or a user action — NEVER because
> the run is long, costly, used many subagents, reached "a natural milestone", or
> the remaining work feels disproportionate. The handoff status you write is the
> gate: one of `drained` / `answers-required` / `user-action-required` / `mixed`
> / `illness-detected`, each requiring a real predicate condition — there is no
> status for an effort-based stop. If tempted to stop while progress is still
> possible, CONTINUE. (See llm/commands/cq/advance.md §Stop condition.)

Whether you write a `handoffs` record at your stop depends ENTIRELY on your
invocation context — there is **no env var or process signal** to read. You,
the executing agent, run both this command and (when chained) the wrapping
`/cq:advance` command in the SAME inline session, so you already KNOW which
context you are in.

- **Run STANDALONE** (the user invoked `/cq:plan:advance` directly, with no
  wrapping flow command): after the §Report, write ONE `handoffs` record for
  this stop — `create_item("handoffs", <milestone>, <status>, <fields>)` —
  mapping your end-of-round classification (across BOTH axes) to the handoff
  `status`:

  | This round's stop                                                                          | handoff `status`         |
  | ------------------------------------------------------------------------------------------ | ------------------------ |
  | every target goal reached `planned`/terminal, nothing left to advance                      | `drained`                |
  | one or more goals/defects `awaiting-answers` / parked on an `open` question                | `answers-required`       |
  | a SPECIFIC named goal/task whose only remaining step is exclusively the user's action      | `user-action-required`   |
  | both at once — some goals planned/drained, others awaiting answers and/or a user action    | `mixed`                  |
  | a stop predicate (a)/(c)–(f) bounded the pass / an invariant violation                    | `illness-detected`       |

  **`user-action-required` — narrow-pinning trigger (Q138/Q139).** This row
  applies ONLY when a SPECIFIC, NAMED goal or task cannot progress because its
  next physical step is *exclusively the user's* — re-activate an environment,
  provision a credential/secret, or run a privileged/external command the planner
  cannot run — AND the planner has ALREADY done every autonomous step for that
  item. **Operational test:** name the EXACT command/action the user must run AND
  the EXACT item it unblocks. If either cannot be named, it is NOT
  `user-action-required` — CONTINUE.

  **Distinct from `answers-required`:** `answers-required` is strictly gated on
  an `open` `questions` item (a requirements/clarification ANSWER from the user).
  `user-action-required` involves NO `questions` item — it is a
  manual/environment ACTION the planner cannot perform itself. When BOTH
  co-occur (a run that has also landed or is also blocked on an open question),
  classify `mixed` and list both components in `handoffReasons` (e.g.
  `[answers-required, user-action-required]` or `[drained, answers-required,
  user-action-required]`).

  Field set (per `HANDOFFS_SCHEMA`; consistent with cq/advance.md §Provenance):
  `summary` (**required** — the why-it-stopped prose, mirror the §Report);
  `flow` = `plan`; `ledgerRefs` = the stop-causing items (`goals:<G>`,
  `defects:<D>`); `blockingQuestions` = the `open` question ids for an
  `answers-required`/`mixed` stop; `handoffReasons` = the component reasons for
  a `mixed` stop (e.g. `[drained, answers-required]`), and for
  `user-action-required` carries the EXACT user action + item unblocked (the
  action is recorded here — NO new schema field is added; Q140); `sessionLogs` =
  the `.cq/logs/<ts>-<agent-id>.md` summary path(s) AND `rawLogs` = the
  `.cq/logs/raw/<ts>-<agent-id>.jsonl` (and `.cq/logs/raw/<ts>-pi-<alias>.md`)
  raw path(s) written this round — populate them in the SAME `create_item` call
  (omit a `rawLogs` entry for any subagent whose transcript was absent). Stamp
  `author`/`session`. Append-only: written
  once at the stop, never updated. (The auto-investigate sub-rounds this command
  chains do NOT each write a handoff — investigate/advance.md suppresses its own
  handoff whenever chained, so this one record covers the whole pass.) **Then
  commit the ledger** (§Commit the ledger): stage the ledger artifacts only and
  commit, so a standalone plan round never leaves the ledger uncommitted.

  **TURN-vs-RUN clause (D39).** A RUN and a TURN are distinct scopes. A **RUN**
  spans as many turns as needed and is durably resumable from ledger state on the
  next `/cq:plan:advance` invocation — the ledger IS the durable resume point. A
  **TURN** is a single context window; exhausting the turn/context budget is
  **NOT a run-stop**. When a turn/context budget is exhausted mid-stride, the
  agent **STOPS WITHOUT writing a handoff** — no `handoffs` record, no
  `mixed`/effort terminal artifact — because the ledger already captures every
  durable state change. The next `/cq:plan:advance` reads ledger state and
  continues from where the previous turn left off. Contrast: a **RUN-stop** = one
  of the five predicate-gated handoff statuses; a **TURN-pause** = no artifact,
  just resume next invocation. Fabricating a terminal handoff record to "wrap up"
  a turn that ran out of budget is the same forbidden launder as an effort-based
  stop — there is deliberately **NO handoff status for an effort-based stop**, and
  turn exhaustion is an effort-based fact, not a predicate-gated one.

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
  own admission: **delete the draft, do NOT stop, and CONTINUE** the planning round. A
  summary that contains "predicates still TRUE" is self-refuting; the correct
  action is to **delete** the draft entry and **CONTINUE**, never to file it. The
  following phrases, when used to justify a stop, are euphemisms for effort-based
  stops (cited from HO22/HO25/HO26 as laundering patterns found there); each is
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
  **not stop and CONTINUE** the planning round instead.

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

## Commit the ledger (after the planning-lock + at the standalone stop)
The ledger files are tracked git artifacts. Commit the ledger — and ONLY the
ledger (`.cq/*.md` + `.cq/archive` + `.cq/logs`; NEVER `docs/ledgers.yaml`,
gitignored; NEVER code) — at TWO points:

- **After the planning-lock** — immediately after a goal reaches `planned` (its
  decision locked + status `planned`; the planner's `completed` outcome at
  sub-step 1c). Commit right then, so a locked plan's milestones / tasks /
  locked-decision land in a durable checkpoint as soon as they exist. This
  checkpoint **ALWAYS fires, even when chained** under `/cq:advance` — it
  OVERRIDES the chained-suppression for THIS commit specifically (D43 part-b:
  otherwise a planning round that reaches `planned` while chained would leave
  the plan's milestones/tasks/locked-decision uncommitted). Use the mechanism
  below with a message like `chore(ledger): /cq:plan:advance — planned: <G>`.
- **At the standalone stop** — after the standalone handoff write. SUPPRESS this
  at-stop commit when chained (the wrapper owns the single run-stop commit). The
  after-planning-lock commit above still fires either way.

Mechanism — **when `[ledger] backend` is `fs` (the default); SKIP under
`git-object`, whose orphan ref already carries each write** (run from the ledger
root):
```
git add .cq/ 2>/dev/null  # ledger dir; .gitignore excludes ledgers.yaml + lockfiles/backups
git diff --cached --quiet -- .cq/ || git commit -q -m "chore(ledger): /cq:plan:advance — <planned: <G> | stop: <status>>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
The `git diff --cached --quiet` guard makes it a NO-OP when nothing changed
(idempotent). Scope `git add` to the ledger artifacts only — never `git add -A`.

## Auto-push the ledger ref at run END (git-object backend only — T355/Q194)

**When the ledger `[ledger]` backend is `git-object`**, auto-push the orphan
ledger branch to the configured remote ONCE at the STANDALONE stop, immediately
after the standalone at-stop ledger commit above. When the backend is `fs` (the
default), SKIP this step. This is a once-per-run push (NOT per-write) — the
symmetric partner of the run-START fetch. **SUPPRESS this push when chained**
(`/cq:advance` / `/<flow>:start` / `/<flow>:follow-up`) exactly as the at-stop
commit is suppressed — the outermost wrapper owns the single run-END push.

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
