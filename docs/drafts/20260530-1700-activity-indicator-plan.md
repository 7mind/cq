# Aggregate activity indicator — plan (ACTIVITY-01)

Worktree `.claude/worktrees/activity-indicator`, branch `activity-indicator`, base `da42222`.
Baseline (verified da42222): `bun test` 1120 pass / 0 fail; e2e 28/28.
No Task tool in this harness → plan / adversarial-review / execute / review run inline as
explicit distinct steps (precedent: M-PCONTENT cycle).

## Problem

`Header.tsx:158` badge = `sessionId === null ? "NEW" : inProgress ? "BUSY" : "IDLE"` —
driven SOLELY by the interactive chat's `inProgress`. The `/plan` workflow runs phase
subagents in a headless lane invisible to the badge. Want: badge reflects ANY active
compute, with a count: `BUSY (N)`.

## Definition of "running" (settled, from the brief)

`N = (interactive chat turn streaming ? 1 : 0) + (count of in-flight workflow phase dispatches)`.

- A workflow PARKED waiting for the user to answer questions is IDLE → contributes 0.
- Badge: `N > 0 → "BUSY (N)"`; `N === 0 → "IDLE"`; no chat session AND `N === 0` → "NEW".

### What counts toward `running` — justification (pendingTeardowns vs active dispatch)

The WorkflowRuntime has two distinct in-flight notions:

1. `this.active` — set at dispatch-START (in `startPlan` / `continueGoal` / `advanceGoal` /
   `advanceGoalWithGuidance`) and cleared in the `finally` AFTER the phase `await` returns,
   i.e. at submit/settle time. This is "the model is working right now" — between
   dispatch-start and submit/settle. `isBusy()` already returns `this.active !== null`.
2. `pendingTeardowns` — a SEPARATE promise per dispatch that resolves when the SDK
   subprocess is fully REAPED (`query().close()` finished). This is post-submit
   subprocess-reap GRACE — the model already finished; only OS-process teardown remains.

Per the brief, "running" = the model is working (between dispatch-start and submit/settle).
Therefore `activeDispatchCount()` is derived from `this.active`, **NOT** from
`pendingTeardowns`. Counting `pendingTeardowns` would over-report (badge stuck BUSY while
a subprocess drains after the model is done). The workflow lane is pool=1, so `active`
is 0 or 1; `activeDispatchCount()` returns `this.active !== null ? 1 : 0`. The AGGREGATE
sum across lanes (chat 0/1 + workflow 0/1) yields N ∈ {0,1,2}, exactly as specified.

## Design

### A. WorkflowRuntime — live count + change notification

- `activeDispatchCount(): number` → `this.active !== null ? 1 : 0`.
- `onActivityChange(listener: () => void): () => void` — register a listener fired
  whenever `this.active` transitions (set→non-null or →null). Returns an unsubscribe fn.
- Implementation: a single private `setActive(next: ActiveWorkflow | null)` helper replaces
  EVERY `this.active = …` assignment (4 set sites + 4 finally-clears). It fires the
  activity listeners on every call (the aggregate tracker de-bounces by comparing the summed
  count, so an idempotent set is harmless). This guarantees push-on-every-transition for
  the workflow lane — no assignment can bypass the notification.

### B. Chat lane — busy-change notification

The chat busy state lives inside each backend bridge's `this.active` (claudeBridge:
4 sites; codexBridge: 3 sites), flipping ASYNC inside runLoop (chat.done fires when the
turn ends, not when a method returns). To guarantee push-on-every-transition without
polling:

- Add `onBusyChange?: () => void` to `BridgeOpts` / each backend's opts.
- In ClaudeBridge + CodexBridge, replace every `this.active = …` with a single private
  `setActive(next)` helper that assigns then invokes `this.onBusyChange?.()`.
- The Bridge facade forwards a single `onBusyChange` callback to both backends (constructed
  in its ctor; threaded into claudeOpts + the lazily-built codex opts).

This is OBSERVE-ONLY: the tracker never routes the workflow through the Bridge and never
changes pool=1. It only listens to the two lanes' existing busy signals.

### C. ActivityTracker (server) — aggregate + push

`packages/server/src/ws/activityTracker.ts` (interface + impl):

- Holds refs to `bridge.isBusy()` and `workflow.activeDispatchCount()` (functions, not
  state — single source of truth is the lanes).
- `running(): number` = `(bridge.isBusy() ? 1 : 0) + workflow.activeDispatchCount()`.
- `subscribe(sink: (running: number) => void): () => void` — push the CURRENT value once on
  subscribe (initial state on connect), then on every change.
- Wired to both lanes via their change callbacks; on any callback it recomputes `running()`
  and, if changed since last push (de-dupe), fans out to all sinks.
- No globals; deps injected via ctor.

### D. Protocol

- `activity.status { running: number }` (server→client) Zod object in `protocol.ts`, added
  to `ServerFrame` union. `running` = `z.number().int().nonnegative()`.

### E. WS session wiring

- `WsSession` registers an `activity.status` sink on `open` (pushes initial state
  immediately) and unsubscribes on `close`. The sink sends an `activity.status` frame.
- `server.ts` / `devServer.ts` construct one `ActivityTracker` per server, pass it to each
  `WsSession`. The tracker's lane callbacks are wired in server.ts where bridge+workflow
  are constructed.

### F. Web — badge consumes the aggregate

- `SessionContext` gains `running: number` + `setRunning`.
- `ChatTab`'s `manager.onMessage` handler adds an `activity.status` branch → `setRunning`.
- `Header` gains a `running: number` prop. Badge becomes:
  `running > 0 → "BUSY (" + running + ")"`; else `sessionId !== null → "IDLE"`; else "NEW".
- The per-chat `inProgress` stays for the countdown ring / textarea / duration tick — only
  the BADGE switches to `running`. The duration tick `useEffect` keeps using `inProgress`
  (unchanged).

## PR breakdown (single milestone M-ACTIVITY, ONE commit)

The concerns are interwoven (protocol → server tracker → ws wiring → web), and intermediate
splits would not compile cleanly. Deliver as ONE buildable commit `feat(activity-1): …`:

- D01 protocol `activity.status` + ServerFrame + Zod round-trip test.
- D02 WorkflowRuntime `activeDispatchCount` + `onActivityChange` + `setActive` refactor + tests.
- D03 backend bridges `onBusyChange` + `setActive` refactor (claude+codex) + facade forward.
- D04 ActivityTracker (interface+impl) + tests (chat-only=1, wf-only=1, both=2, parked=0,
  push-on-every-transition, initial-on-subscribe).
- D05 WsSession sink wiring + server.ts/devServer.ts construction.
- D06 Web: SessionContext.running, ChatTab branch, Header badge + Header test updates.

## Success criteria

- `bun run check` exit 0, run TWICE (baseline 1120/0 + new tests).
- `bun run e2e` green ≥1×.
- `nix build .#default` exit 0 (git add new files first — RESET-02).
- New tests prove: count correctness (chat-only=1, wf-phase-only=1, both=2, parked=0),
  push-on-EVERY-transition of either lane, initial state on connect, badge renders
  BUSY (1)/BUSY (2)/IDLE/NEW, protocol round-trip.
- Manual scenario logged.

## Risks / assumptions

- R1: instrumenting backend `this.active` sites must be exhaustive — a single `setActive`
  helper per backend removes the risk (no raw assignment left). Adversarial review must
  grep for residual `this.active =`.
- R2: the de-dupe in the tracker must not suppress a real transition. De-dupe is on the
  SUMMED running value; a chat-busy→idle that coincides with a workflow idle→busy nets the
  same sum — but each lane callback fires separately, so the intermediate is observed. Even
  if two changes coalesce to the same sum, the badge value is correct (that IS the truth).
  Acceptable: the contract is "push when running CHANGES", and running is the observable.
- R3: codexBridge `this.active` has 3 sites incl. one read-guard (`if (this.active === null)
  return;`) — only ASSIGNMENTS get wrapped, not reads. Review must confirm.
- A1: pool=1 holds; workflow lane ≤1 dispatch; chat ≤1 turn. N ∈ {0,1,2}.
