# Session log — aggregate activity indicator (ACTIVITY-01)

Date: 2026-05-30. Worktree `.claude/worktrees/activity-indicator`, branch
`activity-indicator`, base `da42222`. Run under `/review-loop` discipline (no
Task tool in this harness → plan / adversarial-review / execute / review ran
inline as distinct explicit steps).

## Original request

Make the top-bar badge reflect ALL activity (interactive chat AND `/plan`
workflow phases), not just the chat session, and show a count — `BUSY (N)`.
`N = (chat turn streaming ? 1 : 0) + (count of in-flight workflow phase
dispatches)`. A workflow PARKED on answers contributes 0. Badge: `N > 0 →
"BUSY (N)"`; `N === 0 → "IDLE"`; no chat session AND `N === 0` → "NEW".

## Milestone / PR worked on

- **M-ACTIVITY** — single PR `activity-1` (commit `d65f4a3`). Delivered as one
  buildable commit (concerns interwoven across protocol/server/web). Plan:
  `docs/drafts/20260530-1700-activity-indicator-plan.md`.

## What counts toward `running` (+ justification re: pendingTeardowns)

`running = (chat turn streaming ? 1 : 0) + WorkflowRuntime.activeDispatchCount()`.

- The workflow count derives from the runtime's `active` dispatch slot — a phase
  between dispatch-START and submit/settle, i.e. "the model is working". The lane
  is pool=1 so it is 0 or 1. It is **NOT** derived from `pendingTeardowns`: that
  set tracks post-submit subprocess REAP (`query().close()` finished) — the model
  is already done by then, so counting it would over-report and leave the badge
  stuck BUSY while a subprocess drains. `isBusy()` already clears at submit-time
  (before reap), confirming `active` is the right "running" source.
- The chat lane contributes the PER-TURN `isTurnInFlight()`, NOT `isBusy()`
  (= `active !== null`). In cq's multi-turn streaming model the `query()` stays
  open across turns, so `isBusy()` is true for the whole session lifetime
  including idle gaps between turns. Using it would stick the badge BUSY while the
  chat is idle (ACTIVITY-01-D01).

## Push-on-every-transition — how it was proven

Each lane funnels every `this.active =` mutation (and the chat per-turn flag)
through a single helper (`setActive` / `setTurnInFlight` / `setTurnAbort`) that
notifies after assigning. A residual-assignment grep confirms each backend +
the runtime has exactly ONE raw `this.active =` (inside its helper). Tests:
`activityTracker.test.ts` (push on every chat transition + de-dupe), 
`workflow-activity.test.ts` (`onActivityChange` fires on dispatch START and END
with the right count), `bridge-activity.test.ts` (`onBusyChange` fires across
turn start→done→input, and `isTurnInFlight` clears on `chat.done` while `isBusy`
stays true), `activity-ws.test.ts` (the real WsSession pushes `activity.status`
on connect + on each transition).

## Count correctness — how it was proven

- `activityTracker.test.ts`: chat-only=1, workflow-only=1, both=2, parked=0,
  initial-on-connect, multi-sink fan-out.
- `activity-ws.test.ts` (real WsSession + real WorkflowRuntime + gated producer):
  initial `{running:0}` on connect; a gated phase dispatch drives `running` to 1
  then back to 0 on settle; a parked (`questions_ready`) workflow stays at 0; a
  concurrent chat-busy + workflow phase aggregates to 2.
- `activity-badge.test.ts` (real ChatTab): a pushed `activity.status{running:2}`
  renders "BUSY (2)"; `{running:1}` → "BUSY (1)"; workflow-only (no chat session,
  running:1) → BUSY (1), not IDLE; `{running:0}` with no session → NEW.

This deterministic web + WS-frame coverage IS the operational verification of the
manual discharge scenario (chat turn + /plan phase → BUSY (2); idle → IDLE;
workflow-only phase → BUSY (1) even with chat idle).

## Adversarial review — rounds and findings

One inline adversarial round on the CODE (after a round on the plan), which
surfaced two defects, both resolved:

- **ACTIVITY-01-D01** (major): the chat-lane signal was `bridge.isBusy()` =
  session-active, which stays true between turns of a multi-turn session →
  badge stuck BUSY while idle. Fix: a distinct per-turn `isTurnInFlight()` on the
  `BackendBridge` interface + both backends + the facade, feeding the tracker;
  `isBusy()` keeps its pool=1 preempt semantics. (Scope delta vs the plan — the
  per-turn distinction was not foreseen; surfaced by reviewing the streaming
  model.) Proven by `bridge-activity.test.ts`.
- **ACTIVITY-01-D02** (minor): the e2e `header-badges` asserted the transient
  BUSY badge; with ACTIVITY-01 the badge lags the send by a round-trip and the
  two activity.status frames coalesce in one React batch against the instant
  mock, so the transient need not paint → flaked under full-suite load. Fix: the
  brief's accepted alternative — a deterministic web-level assertion
  (`activity-badge.test.ts`) for the strict BUSY(N) labels; the e2e now records
  badge transitions via an in-page MutationObserver and asserts end-state IDLE +
  that any painted busy label is the valid "BUSY (1)" count form.

## Discharge outputs

- `bun run check` exit 0, run TWICE — 1156 pass / 0 fail both (baseline 1120 +
  36 new tests; deterministic).
- `bun run e2e` — 28/28; 3 consecutive clean full runs. (header-badges and
  stop.spec are timing-sensitive transient-state specs; each 4/4 in isolation;
  stop.spec's rare full-suite flake is pre-existing and independent of this
  change — its Stop button reads the chat-only `inProgress`, untouched.)
- `nix build .#default` exit 0 (cq-0.0.1; built locally — remote SSH builder
  unreachable, as in prior cycles; new source files staged before the build per
  RESET-02).

## Constraints honored

- Observe-only: the tracker reads the two lanes via injected functions + change
  callbacks; it never routes the workflow through the Bridge and never changes
  pool=1.
- No loop/phase semantics, recorder, ledger writes, or divergence-guard touched.
- No sync/async unions. Main + other worktrees untouched; no history rewritten.

## Ledger state

- `tasks.md`: M-ACTIVITY CLOSED; `activity-1` `[x]` with a rich Completed entry.
- `defects.md`: ACTIVITY-01 `[x]` resolved; ACTIVITY-01-D01 `[x]`; ACTIVITY-01-D02
  `[x]`.
