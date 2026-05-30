# Plan — `/plan` workflow runs visible in the History tab (cycle: workflow-history)

Goal: each `/plan` run becomes its OWN History entry (a `session` row distinct
from the chat session) with each planning phase subagent (producer,
clarify-reviewer, planner, plan-reviewer, continuation) nested under it as an
`invocation` row — exactly how a main session + its subagents render today.
Persist DIRECTLY via the Persistence adapter; never route through the
interactive Bridge / SessionRegistry, so pool=1 holds.

Baseline (verified, this worktree, 1f32906): `bun test` 1032 pass / 0 fail;
e2e target 26/26.

## Environment facts established by investigation

- `Persistence` interface (`persist/Persistence.ts`) exposes `sessions.insert/update/get`,
  `invocations.insert/update/get/listForSession`, `withTx`. Both `SqlitePersistence`
  and `InMemoryPersistence` implement it. The History list query (`invocations.list`)
  is a UNION CTE: `main_latest` (top-level `agent_name='main' AND parent_invocation_id IS NULL`,
  deduped latest-per-session) UNION `subs` (`agent_name != 'main' OR parent_invocation_id IS NOT NULL`).
  So a root `main` invocation surfaces a session as ONE top-level row; child
  invocations surface as subagent rows. The web `List.tsx` already renders
  subagent rows with a `↪` marker keyed on `agentName !== "main"`. The data
  model maps onto existing rendering with NO query change.
- `SessionRow` (`@cq/shared/session.ts`) has no `kind`/`source` column → add one
  via migration #8 (next version; current max = 7). Default `'chat'`; workflow
  runs set `'workflow'`. Both adapters honor it; HistoryRow Zod (protocol.ts) +
  the join in `invocations.ts` carry it.
- `WorkflowRuntime` (`workflow/workflowRuntime.ts`) owns EVERY phase dispatch:
  - `startPlan` → `producer.produce(...)` (phase-1 producer)
  - `continueGoal` → `subagent.dispatch(CONTINUE_SPEC, ...)` (continuation producer)
  - `runClarifyReview` → `dispatch(CLARIFY_REVIEW_SPEC, ...)`
  - `runPlanner`/`dispatchPlanner` → `dispatch(PLAN_SPEC, ...)` (incl. revise rounds)
  - `runPlanReview` → `dispatch(PLAN_REVIEW_SPEC, ...)`
  Constructed in `server.ts:144` / `devServer.ts` WITHOUT persistence. `persistence`
  is in scope at both sites (`server.ts:64`, `devServer.ts:51`).
- The Claude dispatch (`claudePhaseSubagent.ts` / `claudeProducer.ts`) resolves
  at submit-time and `break`s the SDK iteration on `submitted` BEFORE the SDK
  `result` message (which carries `total_cost_usd` + `usage.{input_tokens,output_tokens}`,
  per claudeBridge.ts:1062-1078). To capture usage we must NOT change WHEN the
  dispatch resolves (timing + pool=1 invariant), but observe the `result`
  message as a side effect and return it alongside the structured output.
- The Codex dispatch (`codexHeadless.ts`) discards thread events; usage is not
  readily available → 0 cost acceptable (brief + existing Codex-subagent-row
  precedent). Document.

## Data model for ONE `/plan` run

```
session (kind='workflow', platform=run platform, model=run model,
         title=<goal title once known; placeholder /plan text until then>,
         status via ended_reason/endedAt)
  └─ invocation  agent_name='main', parent=null            ← the /plan command (root)
       ├─ invocation agent_name='producer'                 ← phase-1 producer
       ├─ invocation agent_name='clarify-reviewer#1'       ← each clarify round
       ├─ invocation agent_name='planner#1'                ← each planner round
       ├─ invocation agent_name='plan-reviewer#1'          ← each review round
       ├─ invocation agent_name='planner#2' / 'plan-reviewer#2' (revise rounds)
       └─ invocation agent_name='continuation'             ← continuation producer
```

Round index appended for looping phases (`#1`, `#2`, …) so each round is one
distinct row (no missing/duplicate). agent_name values use a small fixed set;
round suffix is the loop counter.

### Session↔workflow link (resume re-attach)

The link is goalId → sessionId. Mechanism: a small persisted map keyed by
goalId. Justification: a workflow run is identified by its GOAL (the durable
ledger entity); `workflowId` is per-dispatch (regenerated every advance) so it
cannot key the session. We store the mapping so a resumed phase dispatch
(`reconcile`/auto-advance after restart) re-attaches to the SAME session and
appends a NEW child invocation rather than orphaning. Implementation: a
dedicated `workflow_session` table (goal_id PK → session_id) in SQLite; an
in-memory `Map` in InMemoryPersistence. This keeps the goal ledger schema
untouched (no divergence-guard impact) and both adapters symmetric. The root
main invocation id is also stored (so children get the right parent on resume).

## Milestone M-WFHIST — PR breakdown

### wfhist-1 — Persistence: `session.kind` column + workflow-session link store
- Migration #8: `ALTER TABLE session ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';`
  + `CREATE TABLE workflow_session (goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, root_invocation_id TEXT NOT NULL);`
- `SessionRow.kind: "chat" | "workflow"` (default applied on read for legacy rows).
- `sessions.ts` insert/update/toRow carry `kind`; `invocations.ts` history join
  selects `s.kind`; `toHistoryRow`/`toHistoryRowFull` carry it.
- `Persistence` interface gains `workflowSessions: { link(goalId, sessionId, rootInvocationId), getByGoal(goalId) }`.
- `SqlitePersistence` + `InMemoryPersistence` implement it.
- HistoryRow + HistoryRowFull Zod (`protocol.ts`) gain `kind: z.enum(["chat","workflow"])` (default chat via `.catch`/optional for legacy).
- Acceptance: migration applies on a fresh + a pre-#8 DB; both adapters round-trip
  `kind` and the link store; Zod parses a workflow row. `bun test` green.

### wfhist-2 — Capture phase-subagent usage (model/cost/tokens) through the dispatch result
- Change the Claude dispatch (`claudePhaseSubagent.ts`, `claudeProducer.ts`) to
  observe the SDK `result` message and surface usage WITHOUT changing resolve timing.
  Approach: a `PhaseUsage { model, costUsd, inputTokens, outputTokens }` captured
  in the drain loop; expose via an optional `onUsage?(usage)` callback on the
  request (the runtime supplies it). The dispatch still resolves at submit-time;
  `onUsage` fires later when `result` is seen (or never, for Codex / no-result).
  Do NOT widen the `dispatch`/`produce` return into a sync/async union.
- Codex (`codexHeadless.ts`): no usage available → never fires `onUsage` (0 cost row).
- Thread `onUsage` through `PhaseRequest` and `ProduceRequest`.
- Acceptance: a fake QueryFactory emitting a `result` message drives `onUsage`
  with the right numbers; submit-time resolution unchanged (existing tests green).

### wfhist-3 — Wire Persistence into WorkflowRuntime; session + root invocation per run
- `WorkflowRuntimeOpts.persistence?: Persistence` (optional/injectable). A small
  internal `WorkflowHistoryRecorder` helper encapsulates all row writes so the
  runtime body stays readable and tests can assert against it.
- On `startPlan`: create the `session` (kind=workflow, placeholder title = the
  `/plan` text, platform, model) + the root `main` invocation (status running)
  BEFORE the producer dispatch; link goalId→sessionId after the producer returns
  the goal (we know goalId only post-write). Justification for ordering: the
  session/root must exist before the first child (producer) so the child has a
  parent; goalId is unknown until `writeArtifacts`, so we create
  session+root keyed by workflowId first, hold them in an in-memory pending slot,
  then `link(goalId, sessionId, rootInvocationId)` + UPDATE the session title to
  the goal title once the producer returns. (Title update is one extra UPDATE —
  cheaper than deferring root creation past the first child.)
- On `continueGoal`: look up the existing workflow session for the goal via
  `workflowSessions.getByGoal`; if present, append a NEW root? No — append the
  continuation child under the EXISTING root. If absent (goal planned before this
  feature shipped), create a fresh workflow session + root for the continuation run.
- Settle the root invocation status when the run reaches a terminal lifecycle
  (questions_ready keeps it running until the loop later completes/errs; planned/
  done → completed; errored/escalated → failed/completed-with-reason). Close the
  session (`endedAt`, `endedReason`) on terminal.
- Acceptance: a `/plan` run via fake backend creates exactly one workflow session
  + one root main invocation; goalId linked; title becomes the goal title.

### wfhist-4 — One child invocation per phase dispatch
- Wrap EACH dispatch point in the recorder: insert a child invocation
  (parent=root, agent_name=phase[+round], model, started_at, status running)
  before the dispatch; on resolve update status=completed + cost/tokens from the
  captured usage; on reject/timeout/abort update status=failed (never dangling
  running). Round index from the loop (clarify/planner/review/revise).
- The producer phase (phase-1 + continuation) records likewise.
- Acceptance: a full loop (producer → clarify → planner → review→satisfied) via
  fake backend records exactly one child per dispatch with correct parent linkage,
  agent_name, model; cost/tokens recorded on completion; a failing phase → that
  child failed + root reflects it. Loops produce one row per round.

### wfhist-5 — History tab marker + child rows (web)
- CORRECTION (adversarial review): the History "nesting" of subagents is in
  `List.tsx`, NOT `Detail.tsx`. The list UNION CTE surfaces the root main row AND
  every phase child as separate flat rows; List renders children with the `↪`
  marker keyed on `agentName !== "main"`. `Detail.tsx` shows ONE invocation's
  event replay (clicking a child opens that child's own detail) — this is exactly
  the existing main-session+subagents convention the brief references.
- `List.tsx`: render a "Plan" badge on main rows where `kind==='workflow'`
  (testid `workflow-badge-<invocationId>`). The phase children already render as
  subagent rows with model/duration/tool-count/status.
- Acceptance: web unit test — List renders a workflow main row WITH the badge and
  the phase children as nested `↪` subagent rows under the same session.

### wfhist-6 — Resume re-attach + E2E + discharge
- Resume test: simulate a restart mid-workflow (new runtime instance sharing the
  same InMemoryPersistence + ledger store) → `reconcile`/advance appends new child
  invocations under the SAME session (via `workflowSessions.getByGoal`), no orphan
  / duplicate session.
- Pool=1 regression: assert an interactive chat (Bridge) is unaffected during a
  workflow run — the workflow writes rows directly, never touches Bridge.active /
  SessionRegistry. Mirror the existing `workflow-pool1-regression.test.ts`.
- E2E (`packages/e2e`): `/plan <text>` (mocked backend) → switch to History →
  assert a workflow entry exists with planning subagents nested. Place per the
  WFL-D02 Playwright project ordering discipline.
- Discharge: `bun run check` ×2 (1032+new/0); `bun run e2e`; `nix build .#default`;
  manual scenario in session log; defects.md WF-HIST-01 resolved.

## Risks / assumptions
- R1 (RESOLVED by adversarial review): SDK `result` ordering. Current drain does
  `if (submitted) break;` → it exits BEFORE the `result` message (which arrives
  after the tool call). FIX: remove the `submitted` break; let the drain loop run
  to the generator's natural return (already bounded by the `finally`'s
  `q.close()`), capturing `result` usage along the way and firing `onUsage`. Mock
  factories yield a finite array so the generator returns → no hang. With a real
  subprocess, if `q.close()` cuts off `result` first, usage stays 0 (documented,
  same as Codex). The dispatch still resolves at submit-time (output promise
  unchanged) so pool=1 timing is identical. Verify with a fake emitting
  `{type:'result', total_cost_usd, usage}` after the (mock) submit.
- R2: title timing — placeholder then UPDATE. Acceptable (one extra write).
- R3: status semantics for a run that pauses at questions_ready (human-gated) —
  the root + session stay `running`/open until the loop later settles or the
  reaper wipes them on restart. Document; the resume path re-opens and continues.
- R4: every advanceGoal regenerates workflowId — must NOT create a new session;
  always re-attach via goalId. Covered by R-resume test.

## Cross-cutting decisions (locked)
- D-LINK: goalId→sessionId via a dedicated `workflow_session` table / Map; NOT a
  goal ledger field (no divergence-guard impact).
- D-USAGE: usage surfaced via `onUsage` callback; no sync/async union; Codex=0.
- D-ROOT: root invocation `agent_name='main'`, parent=null → surfaces as the
  single top-level History row through the existing UNION CTE (no query change).
- D-NOBRIDGE: all writes via Persistence directly; Bridge.active untouched.
