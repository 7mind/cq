---
description: Advance plan-flow goals one full round — a given goal, or (no argument) every unlocked goal — running the planner↔reviewer loop until each needs the user or reaches `planned`.
argument-hint: [goalId]
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}
{{cq:fragment:operational-tool-vocabulary}}
{{cq:fragment:inline-command-recursion}}


## Catalogue
```yaml
inputs:
  - "optional goal id G ($ARGUMENTS); empty = advance all unlocked goals (clarifying/planning)"
  - "ledger state for each target goal: phase, Q&A history, latest review, work-milestone tasks"
  - 'get_config({"section":"planners"}) result: configured: bool, planners[] (harness/model/alias)'
  - 'get_config({"section":"reviewers"}) result: configured: bool, reviewers[] (harness/model/alias)'
outputs:
  - "one guarded claim per planning round (claim_plan), released by the round's terminal operation"
  - "default planner: typed PlanStepResult applied by the ORCHESTRATOR via the matching guarded mutation (release_plan_claim pause/abandon, publish_plan_draft, finalize_plan), with defectsToFile supplied as the SAME operation's reviewDefects"
  - "configured planner panel: ONE synthesized draft manifest persisted by the ORCHESTRATOR via publish_plan_draft"
  - "one aggregated reviews item per round (written by reviewer subagent or orchestrator), stamped with the exact current draft identity"
  - "auto-investigate: CQ::investigate/advance inline for each goal-linked actionable defect"
  - "per planner/reviewer: a summary log .cq/logs/<timestamp>-<agent-id>.md AND a raw transcript .cq/logs/raw/<timestamp>-<agent-id>.jsonl (pi:* → .cq/logs/raw/<ts>-pi-<alias>.md plain), BOTH written via `cq log put`"
  - "handoffs item (standalone only)"
ioSchema:
  - "planner loop token: awaiting-answers | awaiting-research | review-requested | completed | noop"
  - "claim: claim_plan BEFORE any planner dispatch (configured or default); the round ends with the claim released (pause / abandon / finalize)"
  - "single-planner fallback: plan-advance RETURNS a typed PlanStepResult {mode:default, action, payload?, grounding?, defectsToFile?} and writes NOTHING; the orchestrator validates the whole result and applies it"
  - "multi-planner path: candidates keep the DAG JSON {milestones[], tasks[], rationale}; the orchestrator synthesizes ONE keyed manifest and publishes it"
  - "review verdict JSON: {summary, verdict, new_questions[], criticism[], defects[]}"
  - "auto-investigate stop predicates a-f (once-per-round, no-new-evidence, seeded/extended, non-converging, two dead rounds)"
```

You are the **thin orchestrator** for the plan-flow advance loop. The argument
(may be empty) is:

> $ARGUMENTS

Subagents cannot spawn other subagents, so the planner↔reviewer LOOP lives here
in the main session. **You CLAIM the goal's planning round BEFORE any planner
dispatch** (T854 / G99 / D134: `claim_plan` fences the round against concurrent
planners — the H117 stale-writer race — and moves the goal to `planning`), and
the claim stays active across the round's publish/review iterations until ONE
terminal operation releases it (a pause, an abandon, or a finalize). The
**primary planning round** is itself **pluggable** (step 1's *resolve-planners*
sub-step): in the **single-planner fallback** the native `plan-advance`
subagent decides ONE state-driven action and RETURNS it as a typed
**PlanStepResult** — writing NOTHING — and YOU validate the whole result and
apply it through the ONE matching guarded mutation (`release_plan_claim` /
`publish_plan_draft` / `finalize_plan`), supplying the result's `defectsToFile`
batch to that SAME operation (`reviewDefects`) for atomic idempotent filing; in
the **configured multi-planner** path you launch ALL active planners in
parallel as candidate-emitters (each RETURNS a candidate task-DAG and writes
nothing), run the **JUDGE+SYNTHESIS** step that folds the strongest candidate
together with the valuable parts of the others into ONE synthesized keyed
manifest, and publish that one manifest YOURSELF through `publish_plan_draft`.
The **review** step is likewise pluggable (step 2): in the **single-reviewer
fallback** the native `plan-reviewer` subagent writes the one review itself and
returns the same structured verdict (you write nothing but the draft-binding
stamp and logs); in the **configured multi-reviewer** path you, the
orchestrator, write the SINGLE aggregated `reviews` item that reconciles all
reviewers' structured verdicts (the reviewers return JSON and write nothing).
Your job is to drive that loop, then run the
**auto-investigate phase** (below) on any defects the round filed, and relay the
outcome.

> The auto-investigate phase runs `CQ::investigate/advance` **inline** (per K12 —
> a *command* may chain another command; a *subagent* still cannot). That phase,
> following llm/commands/cq/investigate/advance.md, writes the ledger (the
> investigate loop's own writes), and the broadened `allowed-tools`
> (`ledger::*`, `Read`/`Grep`/`Glob`) supports it. The OTHER ledger writes
> you make are: the guarded plan mutations (claim / publish / release /
> finalize — the ONLY writers of the goal's managed plan state, the draft
> DAG, the pause questions/researches, and the filed review defects), the
> review's draft-binding stamp + log attachments, the goal's `grounding` and
> session-log fields (unmanaged), and the **configured multi-reviewer**
> aggregated `reviews` item (step 2b-iii). In the **single-reviewer fallback**
> the `plan-reviewer` subagent writes the review itself.

**Mutation response rule:** Every ledger mutation below returns only its fixed
acknowledgement (allocated id, current status, canonicalized reference fields,
timestamps, and provenance), never a full entity. Use acknowledgement ids
directly; issue an explicit full read only when later reasoning needs narrative
fields.

## Select the target goal(s)

- **`$ARGUMENTS` is a goal id** → the target set is just that one goal.
- **`$ARGUMENTS` is empty** → advance ALL **unlocked** goals: read the goals
  ledger (`fetch_ledger({ ledger_id: "goals", projection: "compact" })`) and
  take every goal whose phase is `clarifying` or `planning` (NOT `planned`,
  `building`, `done`, or `abandoned` — those are locked/terminal for planning).
  This is the checked unbounded-read exception: target selection requires the
  complete active-goal snapshot in one response. If none qualify, report "no
  unlocked goals" and stop.

> **NEVER FABRICATE A GOAL.** `plan:advance` only *advances goals that already
> exist* — goals are created solely by `CQ::plan` at the user's request. An empty
> goals ledger, or one whose goals are all `planned`/terminal, means there is
> **nothing to advance**: write a `drained` handoff and STOP. Do **not**
> `create_item("goals", …)`, `create_milestone`, or invent a
> "bootstrap"/"sample"/"exercise-the-flow" goal to have something to do — that is
> the classic empty-repo ill-state, a DEFECT, not progress. When there are no
> unlocked goals: STOP.
>
> **Narrow carve-out — the `CQ::advance` SEED stage (Q259 option A / D94).** There
> is exactly ONE sanctioned AUTONOMOUS goal creator: the `CQ::advance` **Seed
> stage** (cross-reference `commands/cq/advance.md` §The cycle, Seed stage). It
> creates goals ONLY for **defect-seeded** fix goals produced by the mechanical
> transform of a CONFIRMED root cause — `root-caused`, severity at/above the floor
> (critical/high), batch-capped (`SEED_BATCH_CAP` = 5 per pass), cluster-grouped
> (one batch → ONE goal), and back-linked (`goals:<G>` into each defect's
> `ledgerRefs`). That carve-out lives in `CQ::advance`, NOT here: **`plan:advance`
> ITSELF still NEVER creates a goal** — not even a defect-seeded one — and the
> empty-goals-ledger ill-state rule above stays FULLY in force. When there are no
> unlocked goals, `plan:advance` STOPS; it never seeds one to have work to do.

Run **the per-goal round below independently for EACH** target goal **G**. Treat
goals independently: one that stops at `awaiting-answers` is recorded and the
next goal still runs. After the per-goal planning round, run the
**auto-investigate phase** (below) on the defects that round filed. Then give the
per-goal report.

## The per-goal round (for one goal G)

{{cq:fragment:subagent-dispatch}}

> **FORWARD-PROGRESS INVARIANT — every loop iteration must change state or
> dispatch, else STOP.** Each pass of the loop below MUST do exactly one of:
> dispatch a subagent, or make a state-changing ledger WRITE (claim, publish a
> draft, release a pause, finalize, record a review). Re-reading the ledger
> (`fetch_*` / `list_*` / `search_*` / `derive_predicates` / `snapshot`) is NOT
> progress. If you have reached a **terminal token** — `awaiting-answers` (an
> `open` question now exists), `awaiting-research` (an active research wait now
> exists), `completed`, or `noop` — **STOP the loop
> immediately** and write the handoff; do not re-read the ledger "to check", do
> not look for more to do. Two consecutive read-only iterations with no write and
> no dispatch means you are ill-looping: STOP and report where you are.

Loop the planner↔reviewer steps below until the planner step yields a terminal
token (`awaiting-answers` / `awaiting-research` / `completed` / `noop`). There is
**NO hard iteration cap** —
the loop is bounded by the planner's state machine (it advances ONE decision per
dispatch toward a terminal phase) and, for the cross-command auto-investigate↔replan
axis, by the **concrete stop predicates** in the auto-investigate phase (cite
**K12**, which supersedes K8 pt3 and removed the former 4-iteration cap):

1. **Advance the plan** (claim, dispatch, apply). The planner step is
   **pluggable**, structurally mirroring the pluggable reviewer step (step 2)
   but with the **Q100 generate-N-then-JUDGE+SYNTHESIS** reconciliation model
   (NOT the reviewer's strictest-wins/union). Whatever path runs, the step has
   THREE phases: **claim the round FIRST** (no planner ever runs against an
   unclaimed goal), **dispatch** the planner(s), and **apply** the outcome
   through the ONE matching guarded plan mutation. The step yields the SAME
   single status token regardless of path; the loop reads that token below.

   1. **Resolve the active planner set.** Call the ledger MCP `get_config({"section":"planners"})`
      tool (registered in `.mcp.json`; returns
      `{ configured: boolean, planners: [{ harness, model, alias }] }`,
      `harness` ∈ {`claude`, `pi`} — mirrors `get_config({"section":"reviewers"})`).
      - If the tool is **absent** (server not registered) or it returns
        `configured: false` (no `cq.toml`, or an empty `[planners]` list), take
        the **single-planner fallback** (sub-step 1a).
      - If it returns `configured: true`, take the **multi-planner path**
        (sub-step 1b), AND honor any **session-only planner override** the user
        stated this run via `CQ::planners` (T16): an in-memory override
        supersedes the `cq.toml` default for THIS run only (it is never
        persisted) — use the overridden active set in place of `get_config({"section":"planners"})`'
        `planners` when one is in effect (exactly as `CQ::reviewers` overrides the
        reviewer set for step 2).

   2. **Pre-claim gate — never claim a goal that is already waiting.** Read the
      goal (`fetch_item({ ledger_id: "goals", item_id: <G>, projection: "full" })`)
      and its linked questions (`list_milestone_items({ milestone_id: M,
      projection: "compact" })`, `questions` items whose `fields.ledgerRefs`
      contains `"goals:<G>"`). BEFORE claiming:
      - **An `open` linked question exists** → the goal is WAITING FOR ANSWERS.
        Do NOT claim, do NOT dispatch. The step's token is `awaiting-answers` —
        **stop the loop** for this goal (a question filed mid-round between the
        gate and the dispatch is the defensive case the planner's own
        `awaiting` action covers).
      - **The goal carries ACTIVE research waits** — its
        `fields.waitingResearches` names one-or-more `RS…` ids of which AT
        LEAST ONE is still `open` / `wip` / `inconclusive` on the `researches`
        ledger → the round is RESEARCH-PARKED. Do NOT claim, do NOT dispatch.
        The step's token is `awaiting-research` — **stop the loop** for this
        goal. Planning resumes only when EVERY waited research is `concluded`
        or `abandoned` (or has left the active view — missing or archived);
        the claim's own `research-wait-active` conflict enforces the same
        table, so a race here fails safe, never corrupts.

   3. **Claim the round (BEFORE any planner dispatch).** Generate a fresh
      `claimRequestId` (a uuid, e.g. `Bash: cat /proc/sys/kernel/random/uuid`)
      and a fresh `ownerFenceToken` (≥128 bits of base64url, ≥22 chars, e.g.
      `Bash: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`), then call
      `claim_plan({ goalId: <G>, purpose: "initial", claimRequestId,
      ownerFenceToken, expectedGeneration: <the goal's current
      fields.planGeneration as a number, or null when absent>, author, session })`.
      - On `ok: true`: capture `claimId`, `generation`, and the echoed
        `ownerFenceToken` from the acknowledgement. **The token appears ONLY in
        this acknowledgement** — keep it in memory for this round's later
        operations; NEVER write it into a log, summary, handoff, or ledger
        field. A `replayed: true` result is the normal recovery of a lost
        claim response — proceed with the SAME captured values.
      - On `claim-active` → another planner already owns this goal's round
        (the fence working as designed — the goal also surfaces on the
        report-only `planBusy` predicate companion). Do NOT dispatch, do NOT
        retry: **skip this goal this run** and report it as busy.
      - On `research-wait-active` → the pre-claim gate raced a wait that is
        still active: token `awaiting-research`, **stop the loop** for this
        goal.
      - On `stale-generation` → the goal's generation moved under you (another
        session claimed and released between your read and your claim). Re-read
        the goal and retry ONCE with its current generation; if it recurs,
        skip the goal and report the race.
      - On `goal-terminal` / `goal-phase-conflict` → the goal left the
        claimable phases under you (e.g. finalized by the other session, or a
        `building` goal — a `planned` goal needing MORE scope is the
        `purpose: "follow-up"` claim path, wired by T855/T856, not this
        command). Skip it and report the phase.
      - On `claim-request-reused` / `owner-fence-mismatch` → you fatally
        confused a claim retry: STOP the round and report; never improvise a
        third claim identity.

   1a. **Single-planner fallback** (unconfigured / tool absent). The claim from
      sub-step 3 holds the round. Dispatch the native `plan-advance` subagent in
      its DEFAULT mode — it performs EXACTLY ONE state-driven decision against
      the claimed goal and RETURNS a typed **PlanStepResult**, writing NOTHING.
      YOU then validate the whole result and apply it through the ONE matching
      guarded mutation.

      **Dispatch.** Use the `CQ_SUBAGENT` tool with `role: "plan-advance"`,
      passing the goal id in the prompt (DEFAULT mode — do NOT request
      candidate mode). The subagent reads the goal's state (it is `planning`
      under your claim) and returns the fenced-json PlanStepResult as the last
      content of its reply — `mode: "default"`, one `action` of
      `questions | researches | draft | finalize | awaiting | noop`, the
      payload fields that action requires, an optional `grounding` string, and
      an optional orthogonal `defectsToFile` batch. Strip any prose around the
      fenced block before parsing.

      **Catalog-driven dispatch (G41 — plan-advance) — the proof path.** Drive
      this `plan-advance` dispatch through the typed prompt-catalog output
      validator the ledger-mcp server added in T343. **T975 removed the two
      parent-side steps that were pure duplication for a NATIVE Claude dispatch:
      the old step (a) prompt-template fetch (`bun run gen-agents` already bakes
      the identical role prompt into `agents/plan-advance.md`, which the harness
      injects at the child's system boundary — the parent's fetched copy launched
      nothing) and the old step (d) input round-trip. The surviving steps KEEP
      their original letters**, so (a) and (d) are simply absent:
      - **(b–c) compose the input.** Build the input object against the role's
        typed `inputSchema` (the dispatched-subagent contract the catalog holds
        server-side): `{ goalId: "<G>" }`, with `candidateMode` omitted/false in
        this single-planner mode.
      - **(e) run the subagent.** Dispatch the `CQ_SUBAGENT` (`role:
        "plan-advance"`) with that composed input rendered into the prompt
        (goal id + DEFAULT mode), as above.
      - **(f) await the output.** Capture the subagent's reply and parse the
        fenced-json PlanStepResult out of it.
      - **(g) validate the output.** Call `validate_output("plan-advance",
        output)` against the role's `outputSchema` — the WHOLE result must
        validate (exactly one action, that action's required payload, no extra
        fields, a schema-valid `defectsToFile` when present). A validation
        failure is a contract breach: log it (§Session logs) and treat the
        dispatch as failed — apply NOTHING from an invalid result (never apply
        a valid prefix), release the claim with `release_plan_claim` kind
        `abandon` (reason: the contract breach), and stop the loop for this
        goal.

      **Degrade gracefully when the catalog output validator is absent** (an
      older or embedded ledger-mcp server that predates T343 does not advertise
      it) — exactly like the `get_config({"section":"agent_models"})` / `get_config({"section":"planners"})` /
      `get_config({"section":"reviewers"})` tool-absence paths: when that tool is unavailable, SKIP
      step (g) and fall straight through to the bare `CQ_SUBAGENT` dispatch
      (step (e)) on the prompt as authored, applying the SAME closed contract by
      hand: an object with
      exactly `mode: "default"`, an `action` in the six-value enum, the payload
      that action requires (`questions` min 1 for `questions`; `researches`
      min 1 for `researches`; a complete `manifest` for `draft`; `finalize:
      { reviewId, decision }` for `finalize`; NO payload for
      `awaiting`/`noop`), optional `grounding`, and an optional `defectsToFile:
      { reviewId: "R<n>", defects: [{ key, headline, severity ∈
      low|medium|high|critical, ... }] }`. The validate step is an ADDITIVE
      contract check, never a hard dependency — its absence never blocks the
      round.

      **Apply the validated result through the ONE matching guarded mutation.**
      Every call carries `goalId`, the captured `claimId` / `generation` /
      `ownerFenceToken`, a FRESH `operationId` per NEW intended operation (a
      uuid — REUSE it only when retrying the SAME intended operation after a
      lost response: same `operationId` + same payload replays the identical
      acknowledgement, allocated ids and all; same `operationId` + a CHANGED
      payload conflicts `idempotency-key-reused`, so mint a fresh id for a
      genuinely new operation), the result's `defectsToFile` (when present) as
      `reviewDefects` — filed ATOMICALLY with the action — and
      `author`/`session`. The ONE tokenless call is `kind: "abandon"`: the
      schema REJECTS `ownerFenceToken` on an abandon (the exact public
      `claimId` + `generation` pair is its fence), while `kind: "pause"`
      releases, `publish_plan_draft`, and `finalize_plan` all REQUIRE the
      token:
      - `questions` →
        `release_plan_claim({ kind: "pause", ..., effect: { kind: "questions",
        questions: <result.questions> }, reviewDefects: <result.defectsToFile?> })`.
        The pause files the questions `open` (linked `goals:<G>`), returns the
        goal to `clarifying`, and releases the claim. Token:
        `awaiting-answers`. **Stop the loop.**
      - `researches` →
        `release_plan_claim({ kind: "pause", ..., effect: { kind: "researches",
        researches: <result.researches> }, reviewDefects: <result.defectsToFile?> })`.
        The pause files the researches `open` (linked `goals:<G>`), persists
        them as the goal's `waitingResearches` (replacing any prior set), keeps
        the goal in `planning`, and releases the claim. Token:
        `awaiting-research`. **Stop the loop** — the CQ::advance research stage
        drives the filed researches; planning resumes once none remain active.
      - `draft` →
        `publish_plan_draft({ ..., manifest: <result.manifest>, reviewDefects:
        <result.defectsToFile?> })`. The publish materializes the COMPLETE draft
        (superseding any prior un-finalized draft), keeps every draft task
        NON-actionable, and keeps the claim ACTIVE. If the result carried a
        `grounding` string, persist it on the goal
        (`update_item("goals", G, fields: { grounding: <result.grounding> })` —
        an unmanaged field, so a raw update is legal on a managed goal). Token:
        `review-requested`. **Run the reviewer** (step 2), then continue the
        loop — the next dispatch reads the new review and acts on it.
      - `finalize` → first read the goal's current draft identity
        (`fields.planCurrentDraft.identity.revision`), then
        `finalize_plan({ ..., reviewId: <result.finalize.reviewId>,
        draftRevision: <that current revision>, decision:
        <result.finalize.decision>, reviewDefects: <result.defectsToFile?> })`.
        The finalize creates the `locked` decision (linked `goals:<G>` +
        `reviews:<R>`), finalizes the EXACT current draft as the goal's ONLY
        executable manifest (`goal.milestones` := the finalized manifest's
        milestone ids), moves the goal to `planned`, and releases the claim.
        Token: `completed`. **Stop.**
      - `awaiting` / `noop` →
        `release_plan_claim({ kind: "abandon", ..., reason: "planner returned
        <action> — nothing to apply this round", reviewDefects:
        <result.defectsToFile?> })`. The abandon releases the claim without
        creating effect items (any `defectsToFile` still files atomically).
        Token: `awaiting-answers` for `awaiting`, `noop` for `noop`. **Stop.**
      On an `ok: false` conflict from the APPLY call:
      `idempotency-key-reused` → retry ONCE with a FRESH `operationId`;
      `owner-fence-mismatch` / `claim-not-active` / `stale-claim` /
      `stale-generation` → the claim was lost or superseded mid-round (another
      session recovered it): STOP the round and report — never re-claim and
      improvise over someone else's round; a `review-*` conflict on `finalize`
      → the review binding is wrong for the current draft: STOP and report the
      mismatch (step 2's draft-binding stamp is what keeps this unreachable in
      a clean round).

   1b. **Multi-planner path** (configured) — **generate-N-then-JUDGE+SYNTHESIS**
      (Q100/Q101) under the SAME active claim from sub-step 3. Launch ALL active
      planners **in parallel** as candidate-emitters (each RETURNS a
      candidate-plan JSON and writes NOTHING), then synthesize ONE keyed
      manifest and publish it YOURSELF through `publish_plan_draft`. The native
      planner subagents and `pi:*` planners do **not** write the ledger in this
      path — the ORCHESTRATOR is the only writer (Q101), so `pi:*` planners
      (which cannot call MCP tools) participate fully as pure
      candidate-emitters.
      - **i. Per-planner launch (fan-out).** For each active planner token,
        dispatch it in CANDIDATE MODE and capture its candidate-plan JSON. The
        shared candidate-JSON contract is the one in `agents/plan-advance.md`'s
        **CANDIDATE mode** section (UNCHANGED — configured candidates retain
        the DAG schema): `{ milestones: [{ title, dependsOn? }], tasks:
        [{ headline, description, acceptance, suggestedModel, milestone,
        dependsOn?, ledgerRefs }], rationale }` (references are by
        title/headline, and each task's `milestone` names the work-milestone it
        attaches under). Every planner emits this SAME shape, so candidates are
        directly comparable.
        - `claude:<model>` → an `CQ_SUBAGENT` tool call with
          `role: "plan-advance"`, `model: <the resolved planner token's
          bare-alias model, VERBATIM>`, passing the goal id AND **explicitly
          requesting CANDIDATE mode** per T14 (state it is "one of N parallel
          candidate planners" / "candidate mode" / "generate-N-then-judge"). In
          that mode the native planner grounds itself read-only and RETURNS its
          candidate-plan JSON as a fenced `json` block, writing **NOTHING** to any
          ledger and emitting no status token. Capture the parsed candidate. The
          token's `effort` is **N/A at `CQ_SUBAGENT` dispatch** — the CQ_SUBAGENT tool
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
        single-planner native path (sub-step 1a — under the SAME already-held
        claim; the `plan-advance` subagent's typed result is applied by you) and
        REPORT that the configured planner panel was
        unavailable (which aliases abstained + why); the round never blocks on an
        unavailable panel and never synthesizes from zero candidates.
        Distinguish an abstention (a FAILURE to respond) from a deliberate empty
        candidate: if a SURVIVING candidate comes back with empty
        `milestones`/`tasks` and a `rationale` explaining the goal cannot be
        planned yet (still needs user clarification), that is a VALID signal —
        release the claim with a `questions` pause when you hold concrete
        questions to file (mint a `questions` effect from the candidates'
        rationales), else with an `abandon` release, and treat the step as
        `awaiting-answers` (sub-step 1c).
      - **ii. JUDGE + SYNTHESIS (Q100 — fold-in, NOT pick-best-discard-rest).**
        Run a synthesis step — either inline as the orchestrator, or via a
        dedicated `plan-synthesizer` subagent (an `CQ_SUBAGENT` call) — over the N
        candidate plans. The judge **PICKS a strongest base candidate** (the one
        whose decomposition, sequencing, and `rationale` best achieve the goal's
        `description`) AND, **critically, FOLDS IN the valuable parts of the
        non-best candidates**: where a non-best planner contributed a milestone, a
        task, a sharper acceptance criterion, a better dependency edge, or a
        consideration the base candidate missed, INCORPORATE it into the result.
        The judge MUST NOT blindly discard the non-best candidates — when a
        non-best planner contributed something important, it is folded in. The
        output is ONE **synthesized keyed manifest** in the guarded publish
        schema (`{ milestones: [{ key, title, description?, dependsOn?,
        blockedBy? }], tasks: [{ key, milestoneKey, headline, description?,
        acceptance?, suggestedModel?, sourceRefs?, tags?, dependsOn?,
        blockedBy? }] }`), reconciling milestone titles and task headlines,
        de-duplicating overlapping tasks, and keeping the union of
        genuinely-distinct work. The candidate→manifest mapping is MECHANICAL:
        mint a client `key` slug per milestone and per task; map each
        title/headline `dependsOn` entry to `{ "kind": "draft-milestone" |
        "draft-task", "key": <the referenced entry's key> }`; carry an
        already-persisted `"researches:<RS>"` `dependsOn` token as `{
        "kind": "ledger", "ref": "researches:<RS>" }` verbatim; and map any
        `defects:<D>` candidate `ledgerRefs` entries into the task's
        `sourceRefs` (the guarded publish links every task to the goal
        itself).
      - **iii. Orchestrator publishes the ONE synthesized draft (Q101 — all
        writes are the orchestrator's).** YOU (the orchestrator), not any
        planner, publish the synthesized manifest through the guarded mutation
        under the SAME claim:
        `publish_plan_draft({ goalId: <G>, claimId, generation, operationId:
        <fresh uuid>, ownerFenceToken, manifest: <the synthesized keyed
        manifest>, reviewDefects: <the latest review's validated defect batch,
        when this publish is a REVISION consuming that review — derived exactly
        as the fallback's defectsToFile (receipt-check, then the T843
        preflight); omitted for a first draft>, author, session })`. The
        publish materializes the COMPLETE draft (superseding any prior
        un-finalized draft) and keeps the claim ACTIVE. Persist a short
        `grounding` summary on the goal if the synthesis surfaced one (an
        unmanaged field — raw `update_item` is legal). Handle the apply
        conflicts exactly as sub-step 1a prescribes (`idempotency-key-reused` →
        fresh `operationId`, retry once; lost-claim conflicts → STOP and
        report).
        After publishing, the step's status token is `review-requested` (a
        draft now exists and awaits the reviewer). Go to **sub-step 1c**.
      - The synthesized draft now lives in the ledger exactly as a
        single-planner draft would, so it enters the **SAME reviewer loop (step
        2) UNCHANGED** — the pluggable reviewer step judges it identically
        whether it came from the single-planner fallback or this multi-planner
        synthesis.

   1c. **Read the status token and drive the loop.** Whichever path ran — fallback
      (1a, token derived from the applied guarded operation) or multi-planner
      synthesis (1b, `review-requested` after the publish, `awaiting-answers`
      when the candidates reported the goal unplannable) — act on the single
      status token:
      - `awaiting-answers` — `open` questions now exist on the goal (filed by
        your `questions` pause, or pre-existing when the pre-claim gate fired).
        The user must answer them; the claim is released. **Stop the loop.**
      - `awaiting-research` — the round is parked on filed or pre-existing
        `waitingResearches` (at least one still `open`/`wip`/`inconclusive`);
        the claim is released. **Stop the loop** — the CQ::advance research
        stage drives the researches; the next plan round runs when none remain
        active.
      - `review-requested` — a draft was published or revised (by your fallback
        apply, or by your multi-planner synthesis publish); the claim stays
        ACTIVE. **Run the reviewer** (step 2), then continue the loop.
      - `completed` — the goal reached `planned` (plan finalized behind a
        go-ahead review and a locked decision; the claim is released). **Stop.**
        The planner never auto-closes a goal to `done`; `building→done` is
        always the user's action.
      - `noop` — nothing to do in the current state; the claim is released.
        **Stop.**

2. **Review the plan** (only on `review-requested`). The review step is
   **pluggable**: a configurable set of reviewers may judge the plan in parallel
   and have their verdicts reconciled into ONE `reviews` item. Resolve which
   reviewers run, run them, reconcile, then continue the loop.

   1. **Resolve the active reviewer set.** Call the
      `ledger::get_config({"section":"reviewers"})` MCP tool (registered in `.mcp.json`; returns
      `{ configured: boolean, reviewers: [{ harness, model, alias }] }`,
      `harness` ∈ {`claude`, `pi`}).
      - If the tool is **absent** (server not registered) or it returns
        `configured: false` (no `cq.toml`), take the **single-reviewer
        fallback** (sub-step 2a).
      - If it returns `configured: true`, take the **multi-reviewer path**
        (sub-step 2b), AND honor any **session-only reviewer override** the user
        stated this run via `CQ::reviewers` (T177): an in-memory override
        supersedes the `cq.toml` default for THIS run only (it is never
        persisted) — use the overridden active set in place of `get_config({"section":"reviewers"})`'
        `reviewers` when one is in effect.

   2a. **Single-reviewer fallback** (unconfigured / tool absent — UNCHANGED
      behaviour). Use the `CQ_SUBAGENT` tool with `role: "plan-reviewer"`,
      passing the goal id. In this mode the native `plan-reviewer` (T173) runs in
      its **fallback mode** and WRITES the verdict item into the `reviews` ledger
      itself (`go-ahead` or `revise`) — exactly today's path; the orchestrator
      writes NO reviews item. It also RETURNS the same structured
      `{ summary, verdict, new_questions, criticism, defects }` object required
      by the prompt-catalog sidecar; a review-id pointer is not a valid return.

      **Snapshot the review frontier BEFORE dispatch.** Read
      `list_milestone_items({ milestone_id: M, projection: "compact" })`, retain
      only `reviews` items whose `fields.ledgerRefs` contains exactly
      `"goals:<G>"`, parse each `R<n>` id's numeric suffix, and record the
      highest suffix as the snapshot frontier (use `0` when none exist). This
      snapshot MUST precede the reviewer dispatch.

      **Catalog-driven dispatch (G41 — plan-reviewer).** Drive this
      `plan-reviewer` dispatch through the same typed prompt-catalog output
      validator the `plan-advance` dispatch uses in sub-step 1a, MIRRORING that
      surviving-step sequence for the `plan-reviewer` role (T975 removed the
      parent-side (a) prompt-template fetch and (d) input round-trip there and
      here alike): **(b–c)** compose the input against the role's typed
      `inputSchema` (`{ goalId: "<G>" }`); **(e)** dispatch the `CQ_SUBAGENT`
      (`role: "plan-reviewer"`) with that composed input rendered into the
      prompt; **(f–g)** await its reply and `validate_output("plan-reviewer",
      output)` against the role's `outputSchema` (a validation failure is a
      contract breach to surface, §Session logs). **Degrade gracefully when the
      catalog output validator is absent** — exactly as sub-step 1a degrades for
      `plan-advance`: skip (g) and fall straight through to the bare
      `CQ_SUBAGENT` dispatch (e). When that tool is absent, manually
      apply the identical closed contract: an object with exactly `summary:
      string`, `verdict: "go-ahead"|"revise"`, `new_questions: string[]`,
      `criticism: string[]`, and `defects: object[]`; every defect has exactly
      `headline: non-empty string`, `severity:
      "low"|"medium"|"high"|"critical"`, optional string `rootCause`, and
      optional string `suggestedFix`. Also enforce the verdict/bucket invariant.
      An invalid return is a contract failure, never a pointer fallback.

      **Recover and reconcile the direct write AFTER dispatch.**

      1. Re-read
         `list_milestone_items({ milestone_id: M, projection: "full" })`.
         Retain goal-linked `reviews` items as above whose numeric `R<n>` suffix
         is greater than the snapshot frontier. Require exactly ONE new goal-linked review above the snapshot frontier.
         Zero means the
         reviewer returned without its required write; multiple means it
         violated single-review-per-round. Either condition is an invariant
         failure. Do NOT identify the new review by summary, status, timestamps,
         or prose, and do not search for it: an older stale review may carry the
         same summary.
      2. Validate the returned structured verdict in full. Reconstruct EVERY
         returned defect object in exact T843 property order — `headline`,
         `severity`, optional `rootCause`, optional `suggestedFix` — so any
         sidecar-valid input key order normalizes to the same structured value.
         Then decode the recovered review's ENTIRE persisted
         `fields.defects: string[]` batch. Every entry must parse to an object
         matching the structured sidecar. Reconstruct each persisted object in
         the same T843 property order and require compact `JSON.stringify` to
         reproduce the persisted string byte-for-byte.
      3. Construct canonical returned and persisted verdict objects in exact
         property order `{ summary, verdict, new_questions, criticism, defects }`;
         the persisted object's `verdict` comes from the review status and its
         defects are the decoded-and-normalized structured objects; the returned
         object's defects are the normalized returned objects from step 2.
         Compact-`JSON.stringify` both. The persisted verdict bytes MUST equal the
         returned verdict bytes.
         This comparison covers status/verdict, summary, array order,
         `new_questions`, `criticism`, and every defect field; comparing only the
         summary is forbidden.
      4. On zero/multiple reviews, invalid output, malformed or non-canonical
         persisted JSON, schema/severity failure, or ANY byte mismatch, hard-fail
         the round and **FAIL before attaching any sessionLogs/rawLogs**, before
         continuing the planner loop, and before any review defect can be filed.
         On success, retain this exact recovered review id for log attachment and
         continue to sub-step 2c. EXACTLY ONE `reviews` item was written by the
         reviewer.
      5. **Stamp the review with the EXACT current draft identity (T854 — the
         finalize binding).** Read the goal's `fields.planCurrentDraft.identity`
         (`{ goalId, claimId, generation, revision }` — the draft this review
         just judged) and write it onto the recovered review:
         `update_item("reviews", <reviewId>, fields: { planDraft:
         "<JSON.stringify of that identity object>" })`. `finalize_plan`
         REQUIRES the go-ahead review to name the exact current draft identity;
         this stamp is what binds the review to the draft it approved (a stale
         or missing binding conflicts `review-draft-mismatch` at finalize).
         `planDraft` is an unmanaged review field, so the raw update is legal;
         it does NOT touch the reconciled verdict buckets. When the round's
         review already carries a `planDraft` equal to the current identity
         (e.g. a re-stamp after a retry), skip the write.

   2b. **Multi-reviewer path** (configured). Launch ALL active reviewers **in
      parallel** and collect each one's verdict JSON. In this mode NO reviewer
      writes the ledger — the orchestrator writes the single aggregated item
      (sub-step 2b-iii).
      - **i. Per-reviewer launch.** For each active reviewer token:
        - `claude:<model>` → an `CQ_SUBAGENT` tool call with
          `role: "plan-reviewer"`, `model: <the resolved reviewer
          token's bare-alias model, VERBATIM>`, passing the goal id AND
          instructing it to run in **configured mode** per T173: it RETURNS its
          verdict JSON and writes **NOTHING** to the `reviews` ledger (in
          configured mode the native reviewer is one of several, so it never
          writes — the only ledger writer is the orchestrator, sub-step
          2b-iii). Capture the returned `{ summary, verdict, new_questions,
          criticism, defects }`. The token's `effort` is **N/A at `CQ_SUBAGENT`
          dispatch** — the CQ_SUBAGENT tool exposes no per-dispatch effort/reasoning
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
          catches). Feed it the **shared `CQ::plan-review` rubric
          prompt** (`commands/cq/plan-review.md`, T173) plus the goal/plan
          context (the goal's title/description/grounding, its Q&A history, and
          the emitted work-milestone tasks — the same material the native
          reviewer reads). Its stdout-json contract is the rubric's:
          `{ summary, verdict: "go-ahead"|"revise", new_questions: [],
          criticism: [], defects: [...] }`. **Strip any code fence** before
          parsing — `pi` may wrap the JSON in a triple-backtick ` ```json `
          block. Capture the parsed object.
        - **Full-object validation before abstention/reconcile.** A usable
          configured verdict must validate against the SAME complete structured
          sidecar as fallback: exact top-level fields and types, closed verdict
          enum, string buckets, and structured defect objects with a non-empty
          headline, closed severity enum, optional string fields, and no extra
          fields. Enforce the verdict/bucket invariant. Never admit a
          partially-validated object to reconciliation.
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
        the verdict and the union) in the **configured active-reviewer alias
        order**, never parallel completion order:
        - **Quorum floor (all-abstain fallback):** if EVERY configured reviewer
          abstained (zero usable verdicts), fall back to the **single-reviewer
          path (sub-step 2a)** — the native `plan-reviewer` in its fallback mode
          writes the verdict itself, so SKIP 2b-iii — and REPORT that the
          configured panel was unavailable (which aliases abstained + why). The
          round NEVER blocks on an unavailable panel and never writes a verdict
          from zero usable reviews.
        - **Verdict:** `revise` if ANY surviving reviewer returned `revise`;
          `go-ahead` ONLY if ALL surviving reviewers returned `go-ahead`.
        - **Findings:** UNION every surviving reviewer's `new_questions`,
          `criticism`, and `defects` in that alias order. **Prefix each finding
          with its source reviewer's alias** (e.g. `[grok] …`, `[opus] …`) so
          provenance survives the merge. For a defect, prefix its structured
          `headline` first — **prefix the alias BEFORE T843 serialization** —
          then construct the canonical object in order: headline, severity, optional rootCause, optional suggestedFix,
          and compact-`JSON.stringify`
          it for persistence. De-duplicate only entries judged equivalent; keep
          the first occurrence in configured alias order, and bias to KEEP when
          equivalence is uncertain.
      - **iii. Orchestrator writes the ONE aggregated `reviews` item.** YOU (the
        orchestrator), not any reviewer, write the single reconciled verdict:
        `create_item("reviews", M, status: <reconciled verdict>, fields: {
        summary: "<one-line reconciled verdict>", new_questions: [<tagged
        union>], criticism: [<tagged union>], defects: [<T843 serialized tagged
        defect strings>], ledgerRefs: ["goals:<G>"], planDraft:
        "<JSON.stringify of the goal's CURRENT planCurrentDraft.identity —
        { goalId, claimId, generation, revision }>" })` (M = the goal's
        coordination milestone). The `planDraft` stamp (T854) binds this review
        to the EXACT draft it judged — `finalize_plan` requires the go-ahead
        review to name the current draft identity. Validate the complete reconciled structured
        object and the entire serialized defect batch before this single write.
        **Preserve the invariant:** a `revise` must carry non-empty
        `new_questions` and/or `criticism` (those are what `revise` acts on);
        STRICTEST-WINS guarantees this because any reviewer that voted `revise`
        contributed at least one such finding. Stamp `author`/`session`. This is
        the SINGLE `reviews` item for the round. Capture its id from the fixed
        acknowledgement for the session-log attachment below.

      **Normative translation/reconciliation fixtures.** These labels make the
      four valid paths and the fail-loud boundary cases explicit:

      - `direct-empty`: fallback returns structured `defects: []`; it persists
        `fields.defects: []`; post-frontier bytes match.
      - `direct-non-empty`: fallback returns structured defect objects; each
        persists as compact
        `{"headline":"…","severity":"…","rootCause":"…","suggestedFix":"…"}`
        with absent optionals omitted; decoded post-frontier bytes match.
      - `configured-empty`: every survivor returns structured `defects: []`;
        aggregation persists `fields.defects: []`.
      - `configured-non-empty`: process survivors in configured alias order,
        prefix each alias on the structured headline, then serialize; e.g.
        `{"headline":"[opus] …","severity":"high"}`.
      - `zero-new-review`: hard-fail; no log attachment or defect filing.
      - `multiple-new-reviews`: hard-fail; no arbitrary id selection.
      - `stale-same-summary`: the pre-frontier item is never eligible.
      - `bucket-divergence`: any summary/verdict/new_questions/criticism/defects
        byte difference hard-fails.
      - `invalid-output`: pointer, prose, missing/extra field, invalid verdict,
        or wrong bucket type fails structured validation.
      - `malformed-defect-json`: persisted decode fails the whole review.
      - `invalid-defect-schema`: missing/extra/wrong-typed defect field fails.
      - `invalid-severity`: any value outside
        `low|medium|high|critical` fails.
      - `reordered-returned-defect`: a sidecar-valid returned defect whose keys
        arrive in a different order normalizes to T843 order and reconciles.

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

> **Where the filed defects come from (T854).** The round's defects are filed
> by the guarded plan mutations themselves: the planner RETURNED them as its
> result's `defectsToFile` batch and YOU supplied that batch as the SAME
> operation's `reviewDefects` (publish / release / finalize) — so every defect
> exists ATOMICALLY with the action that consumed its review, carries
> `ledgerRefs: ["goals:<G>", "reviews:<R>"]`, and is idempotent under retry
> (a replayed operation re-files NOTHING). While the goal is in
> `clarifying`/`planning` these goal-linked defects are intentionally EXCLUDED
> from the GLOBAL P-investigate predicate (ownership by a movable planning
> goal) — THIS worklist is their ONLY investigation channel, so a filed defect
> is investigated EXACTLY ONCE per round (predicate (a) below) and never
> double-triaged by `CQ::advance`'s Investigate stage. The exclusion lifts when
> the goal leaves the movable planning phases.

### Worklist = LEDGER QUERY (authoritative — NOT prose-parse)

Derive the worklist from the **ledger**, not from the plan-advance subagent's
returned summary. The subagent's PlanStepResult is ALREADY APPLIED by the time
this phase runs; its prose is ADVISORY ONLY and MUST NOT be the source of
truth. Query the ledger by defect
**STATUS** (T116's queryable lifecycle, not a prose marker):

> every **defect** whose `ledgerRefs` link the just-advanced goal (`goals:<G>`)
> and whose `status` is still **ACTIONABLE** — `open`, `wip`, or `inconclusive`.
> (`root-caused` is READY-TO-SEED and is the **`CQ::advance` Seed stage's**
> consumer — `commands/cq/advance.md` §The cycle, Seed stage, drains the unowned
> root-caused backlog via P-seed — NOT a fresh investigate target here;
> `resolved`/`wontfix` are terminal and EXCLUDED.)

(`fts_search({ query: '(status:open OR status:wip OR status:inconclusive)
ledgerRefs:"goals:<G>"', ledger: "defects", projection: "compact", limit: 100 })` /
`search_items({ ledger_id: "defects", query: "goals:<G>", projection:
"compact" })`, retaining only the listed actionable statuses with a
`goals:<G>` ledgerRef; cross-check
`fetch_item({ ledger_id: "defects", item_id: D, projection: "full" })` as
needed). This set — NOT the subagent's summary — is the auto-investigate
worklist for G. Each defect appears in it EXACTLY ONCE (deduplicate by defect
id); you run `CQ::investigate/advance D` on each member AT MOST ONCE this round
(predicate (a)).

### For each defect D in the worklist

Run **`CQ::investigate/advance D` INLINE** in this same main session, exactly per
llm/commands/cq/investigate/advance.md — **do NOT duplicate or re-implement that
logic; RUN it** (form/extend the hypothesis tree, dispatch read-only explorers,
validate citations, adjudicate). A *command* running another command's loop is
legal under K12; the subagents-cannot-spawn-subagents rule is preserved because
ONLY this orchestrator (a command) does the chaining — the `plan-advance` /
`plan-reviewer` subagents only FILE defects (T73), they never run
`CQ::investigate/advance`.

**When the defect reaches `status == root-caused`** (the READY-TO-SEED gate —
the inline `CQ::investigate/advance` pass sets that status when it adjudicates the
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

- **STILL auto-investigate** the filed defects — run `CQ::investigate/advance D`
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
    per `CQ::plan/advance` round.** Do not re-launch `CQ::investigate/advance D` a
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

## Research items the planner returned are driven by `CQ::advance`, NOT here (Q267)

The `plan-advance` planner subagent (`agents/plan-advance.md`) may RETURN a
`researches` action for EMPIRICAL unknowns — the Q267 triage rule: an
empirically-answerable unknown (which library / data structure / approach
performs best; a verifiable-by-experiment fact) becomes an `open` `researches`
item INSTEAD of a user question, while user questions stay
reserved for preference/requirements decisions. YOU file those items through the
`release_plan_claim` researches pause (sub-step 1a), which links them `goals:<G>`
AND persists them as the goal's `waitingResearches` — suppressing re-planning
(including your own next claim, via the `research-wait-active` conflict) while
any is `open`/`wip`/`inconclusive`, and resuming once every one is
`concluded`/`abandoned` or has left the active view. Those research items are **NOT
this orchestrator's to drive.** Unlike the defects the round files — which THIS
orchestrator auto-investigates INLINE (the auto-investigate phase above) — an
actionable `researches` item linked `goals:<G>` is driven by **`CQ::advance`'s
RESEARCH stage** (`commands/cq/advance.md` §The cycle → Research stage, which
runs `CQ::research/advance` on each actionable research). `CQ::plan/advance` does
**NOT** spawn research subagents itself and does NOT chain `CQ::research/advance`:
subagents-cannot-spawn-subagents holds (the planner subagent only RETURNS the
researches action), and the flow-level `CQ::advance` wrapper owns the research stage and
its P-research gate. Treat any filed research item as advisory context in the
§Report only; it is picked up by the next `CQ::advance` cycle's research stage.

A task whose `dependsOn` names the filed `researches:<RS>` is not "stalled" —
it is **GATED**, exactly the vocabulary `commands/cq/advance.md` §P-implement /
§The cycle (Research stage) use: the task simply stays out of the implement
ready-set until RS reaches `concluded` (the `researches` schema's
`satisfiesDependencyStatuses`), at which point the post-research-stage
RE-CHECK of P-implement admits it. This mirrors the investigate flow's own
research parking — see `commands/cq/investigate/advance.md` §"Research
escalation" — so the two flows read consistently: an empirical unknown is
filed as a `researches` item and file-and-deferred to `CQ::advance`'s research
stage in BOTH flows, never driven inline by the filing subagent.

## Session logs (after EVERY subagent returns)

Each subagent (planner and reviewer) ends its reply with a `### Session summary`
section. **ALL log writes go through `cq log put` — never a direct `Write` to a
log path, and never `git add` a log file** (`cq log put` does redaction +
strict-JSONL validation IN the CLI and writes into the primary store's
out-of-tree logs area; the logical paths `.cq/logs/…` are recorded in
sessionLogs/rawLogs and read back via `read_log`). Stamp
`<timestamp>` (`Bash`: `date -u +%Y%m%d-%H%M%S`) once per returned subagent.

> **The `ownerFenceToken` NEVER enters a log.** The claim's owner token appears
> ONLY in the winning (or exactly-retried) claim acknowledgement — never write
> it into a summary header, a session-log line, a handoff field, or a ledger
> item. (`cq log put`'s redaction strips the plan-owner-fence-token spellings
> from persisted transcripts — defence in depth, not licence to write it.)
> For the planner summary header, record the planner's returned ACTION
> (`questions`/`researches`/`draft`/`finalize`/`awaiting`/`noop`) and the
> guarded operation you applied — never the claim's secret material.

**Native `CQ_SUBAGENT` subagent (planner / reviewer / `plan-synthesizer`).** Take
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

**`pi:*` shellout (candidate planner / reviewer).** There is no native `CQ_SUBAGENT`
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
the goal's and the `reviews` item's log writes (the planner subagent writes
NOTHING — you apply its result and attach its logs after your guarded
operation commits):
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
    item; use ONLY the exact post-frontier id recovered and byte-reconciled in
    sub-step 2a, with the one `claude`-subagent `.md`+`.jsonl` pair. A pointer,
    summary/status search, or pre-frontier review is never an id source.
  - In the **configured (2b)** path YOU created the aggregated review item
    (sub-step 2b-iii), so you already have its id; attach the log paths for
    **every** reviewer that ran this round (one `claude`-subagent `.md`+`.jsonl`
    pair per `claude:*` reviewer, plus one `pi`-stdout summary `.md` + raw `.md`
    per `pi:*` reviewer).

Do this for the planner step (the fallback subagent, or every candidate planner +
the synthesis step in the multi-planner path) AND every reviewer on every
iteration — one log pair per spawned subagent and per pi shellout, ALL via
`cq log put`. The inline `CQ::investigate/advance` pass logs its own
`investigate-explorer` subagents per llm/commands/cq/investigate/advance.md
(§Session logs) — follow that command's logging rule while running it.

## Report to the user

After running the round on every target goal, read each goal
(`fetch_item({ ledger_id: "goals", item_id: <G>, projection: "full" })`) for
its current phase and give a **per-goal** summary line (when run with no
argument, one line for each goal advanced):
- the goal's id + current phase (`clarifying` / `planning` / `planned` / …);
- what the user must do next:
  - `awaiting-answers` → "answer the N open questions for goal G in the TUI/web,
    then run `CQ::plan/advance G` again" (list the question ids);
  - `awaiting-research` → "goal G is parked on research RS… (still
    open/wip/inconclusive); the next `CQ::advance` research stage drives it —
    planning resumes automatically once every waited research is
    concluded/abandoned" (list the waiting research ids);
  - `completed` → "plan approved and locked; goal G is now `planned`" (point to
    the finalized milestones/tasks and the locked decision); if the goal was already
    `building` or `done` when the planner ran (no planning step needed), report
    the current phase and note that implementation is in progress or already
    complete — the user closes `building→done` via the TUI/web;
  - `noop` → why there was nothing to do.

Then, for the **auto-investigate phase**, add a line per defect D in the worklist
covering its outcome and the next action:
- **root-caused → seeded goal** — defect reached `status == root-caused`;
  defect-seeded goal G′ created/extended (ledgerRef `defects:<D>`). If G′ was
  auto-resumed and reached `planned`, say so (point to the fix tasks); else:
  "run `CQ::plan/advance G′`".
- **parked on a question** — a stop predicate (d)/(e) or step-6 block fired; an
  `open` question was filed. "Answer question Qn in the TUI/web, then re-run."
- **no-new-evidence-stopped** — predicate (b): the tree gained no new
  `confirmed`/`[correct]` evidence, so D was not relaunched; another
  `CQ::investigate/advance D` round is warranted only if new leads emerge.
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
`CQ::advance` command in the SAME inline session, so you already KNOW which
context you are in.

- **Run STANDALONE** (the user invoked `CQ::plan/advance` directly, with no
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
  handoff whenever chained, so this one record covers the whole pass.)
  Persistence is the store's job — no git action here; when the optional
  `[ledger].backup` mode (in-tree / orphan-branch) is enabled, the debounced
  exporter mirrors the ledger + logs to git.

  **TURN-vs-RUN clause (D39).** A RUN and a TURN are distinct scopes. A **RUN**
  spans as many turns as needed and is durably resumable from ledger state on the
  next `CQ::plan/advance` invocation — the ledger IS the durable resume point. A
  **TURN** is a single context window; exhausting the turn/context budget is
  **NOT a run-stop**. When a turn/context budget is exhausted mid-stride, the
  agent **STOPS WITHOUT writing a handoff** — no `handoffs` record, no
  `mixed`/effort terminal artifact — because the ledger already captures every
  durable state change. The next `CQ::plan/advance` reads ledger state and
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

- **Run CHAINED INLINE by any wrapping flow command** (`CQ::advance`, or a
  `/<flow>:start` / `/<flow>:follow-up` that runs this pass inline):
  **SUPPRESS this handoff write**. The outermost wrapper owns the single
  authoritative run-level handoff and writes it once at its stop — `CQ::advance`
  per its §Provenance (it is the sole `handoffs` writer for the whole run);
  a `/<flow>:start` or `/<flow>:follow-up` writes it directly in its own
  §Handoff record step. You can tell you are in this context because the
  wrapping command explicitly chains you and its prompt instructs this
  suppression; a standalone invocation has no such wrapper. Suppressing here is
  what guarantees exactly ONE handoff per run — never a duplicate.

## Ledger persistence (no git action)
Persistence is the store's job — no git action here; when the optional
`[ledger].backup` mode (in-tree / orphan-branch) is enabled, the debounced
exporter mirrors the ledger + logs to git.
