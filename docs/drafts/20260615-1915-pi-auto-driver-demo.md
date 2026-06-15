# pi auto-driver demo runbook (T470)

Date: 2026-06-15 19:15  
Branch: implement/T470  
Demo script: `nix/pkg/pi-extensions/auto-driver/demo/e2e-demo.ts`

---

## 1. How to invoke in a live Pi session

After a `home-manager switch` that activates the cq harness, the auto-driver
extension is loaded via `nix/hm/pi.nix` → `settings.extensions`. In an
active `pi` session (interactive TUI), the following slash commands are
available immediately:

```
/cq:advance:auto         — drains the WHOLE flow (wraps /cq:advance)
/cq:plan:auto            — drains plan-flow only  (wraps /cq:plan:advance)
/cq:investigate:auto     — drains investigate-flow (wraps /cq:investigate:advance)
/cq:implement:auto       — drains implement-flow   (wraps /cq:implement:advance)
```

Each command:
1. Sends `/cq:advance` (or the corresponding wrapped command) into the live
   session as a user message (Pi `sendUserMessage` → triggers a turn).
2. Awaits the agent's idle state (`ctx.waitForIdle()`).
3. Shells out to `cq advance-gate` in the session's working directory to read
   the current flow predicates.
4. Decides the next action (see §3 below).
5. Either re-drives with a corrective prompt naming the violated predicates,
   compacts and re-drives, or stops.

The Pi footer status bar (key `cq-auto`) updates at each lifecycle point.

---

## 2. Real `cq advance-gate` output at demo time (live oracle evidence)

`cq advance-gate` reads the ledger for the CWD it runs in. At demo time the
demo harness runs from
`nix/pkg/pi-extensions/auto-driver` (the worktree's package directory), whose
`.cq/` working-tree projection is a stale snapshot that predates defects D72/D73
and task T470 — so it reported all predicates FALSE (DRAINED). That output was
an artifact of the worktree CWD, not a true picture of the live repo ledger.

The **live ledger on the main checkout** at the same time returns:

```json
{"block":true,"reason":"P-investigate=TRUE and unblocked; continue per D41 — turn-pause is not a stop condition","predicates":{"pInvestigate":{"value":true,"items":["D72","D73"]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":true,"items":["T470"]},"openQuestionGate":{"value":false,"items":[]}}}
```

(D72 and D73 are open out-of-scope defects filed during this build; T470 is this
demo task itself.) `block:true`, `pInvestigate=[D72,D73]`, and
`pImplement=[T470]` are all outstanding — the live ledger is **not** DRAINED.
Running `/cq:advance:auto` on the live repo would therefore **REDRIVE**
(P-predicates still TRUE), not immediately `STOP_DRAINED`.

The oracle channel itself works correctly: `cq advance-gate` is on PATH,
resolves against the ledger root for whatever CWD it is given, and returns the
identical `DerivedPredicates` shape as the MCP `derive_predicates` tool
(verified in oracle.ts header comments and T463 investigation). The discrepancy
above is purely a CWD issue — the worktree's `.cq/` is a stale snapshot; the
main checkout's `.cq/` is the authoritative live ledger.

---

## 3. Observed transition sequence from the headless harness

Run command:

```
cd nix/pkg/pi-extensions/auto-driver && bun demo/e2e-demo.ts
```

Full captured output:

```
cq auto-driver e2e demo (T470)
Working directory: .../nix/pkg/pi-extensions/auto-driver
Date: 2026-06-15T19:13:20.877Z

========================================================================
Scenario 1: LIVE oracle — cq advance-gate against this repo's ledger
========================================================================

  Live predicate snapshot (from cq advance-gate):
    pInvestigate  : value=false  items=[]
    pPlan         : value=false  items=[]
    pImplement    : value=false  items=[]
    openQuestGate : value=false  items=[]

  advanceAutoPreset.terminalPredicate(live) = true
  => All P-predicates are FALSE in this CWD's ledger snapshot.
     NOTE: this demo runs from the worktree package dir whose .cq/ is a stale
     snapshot — it does NOT necessarily reflect the live main-checkout ledger.
     The live main-checkout ledger may still have work outstanding (see runbook §2).
     Running cq:advance:auto against the live main ledger would REDRIVE if predicates are TRUE there.

  Driver transition log (using live snapshot, fake waitForIdle):
  [status-bar] cq-auto = "idle"
  [status-bar] cq-auto = "driving cq:advance iter 0"
  [send-prompt] /cq:advance
  [status-bar] cq-auto = "awaiting-stop"
  [status-bar] cq-auto = "checking-predicates"
  [status-bar] cq-auto = "done (DRAINED)"

  Result: action=STOP_DRAINED, iterations=0

========================================================================
Scenario 2: DRAINED stop — fake oracle progresses to all-FALSE
========================================================================

  Ordered transition log (status-bar states + injected prompts):
  [status-bar] cq-auto = "idle"
  [status-bar] cq-auto = "driving cq:advance iter 0"
  [send-prompt] /cq:advance
  [status-bar] cq-auto = "awaiting-stop"
  [status-bar] cq-auto = "checking-predicates"
  [status-bar] cq-auto = "driving cq:advance iter 1"
  [send-prompt] The wrapped command has NOT reached its terminal state. The following stage
predicates remain violat…
  [status-bar] cq-auto = "awaiting-stop"
  [status-bar] cq-auto = "checking-predicates"
  [status-bar] cq-auto = "driving cq:advance iter 2"
  [send-prompt] The wrapped command has NOT reached its terminal state. The following stage
predicates remain violat…
  [status-bar] cq-auto = "awaiting-stop"
  [status-bar] cq-auto = "checking-predicates"
  [status-bar] cq-auto = "done (DRAINED)"

  Result: action=STOP_DRAINED, iterations=2
  Expected: action=STOP_DRAINED, iterations=2
  [PASS]

========================================================================
Scenario 3: BLOCKED-ON-QUESTIONS — openQuestionGate set (Q237)
========================================================================

  Ordered transition log:
  [status-bar] cq-auto = "idle"
  [status-bar] cq-auto = "driving cq:advance iter 0"
  [send-prompt] /cq:advance
  [status-bar] cq-auto = "awaiting-stop"
  [status-bar] cq-auto = "checking-predicates"
  [status-bar] cq-auto = "stopped: blocked-on-questions"

  Result: action=STOP_BLOCKED_ON_QUESTIONS, iterations=0
  Expected: action=STOP_BLOCKED_ON_QUESTIONS, iterations=0, no re-drive prompt
  [PASS] No re-drive prompt — correctly surfaced BLOCKED-ON-QUESTIONS.

========================================================================
Scenario 4: registerAllAutoCommands — all four presets registered
========================================================================

  Registered commands:
    /cq:advance:auto
      description: Auto-drive `cq:advance` until its terminal predicate is satisfied.
    /cq:plan:auto
      description: Auto-drive `cq:plan:advance` until its terminal predicate is satisfied.
    /cq:investigate:auto
      description: Auto-drive `cq:investigate:advance` until its terminal predicate is satisfied.
    /cq:implement:auto
      description: Auto-drive `cq:implement:advance` until its terminal predicate is satisfied.

  All four commands present: true
  [PASS]

========================================================================
All demo scenarios completed.
========================================================================
```

---

## 4. State transition enumeration (per Q237)

The status-bar key `cq-auto` transitions through these states in order:

| Phase                       | Status-bar text                  | Condition                                    |
|-----------------------------|----------------------------------|----------------------------------------------|
| idle                        | `idle`                           | Before the first launch                      |
| driving iter N              | `driving <cmd> iter N`           | About to inject the (re-)drive prompt        |
| awaiting-stop               | `awaiting-stop`                  | After `waitForIdle()` returns                |
| checking-predicates         | `checking-predicates`            | While `cq advance-gate` runs                 |
| compacting                  | `compacting`                     | While `ctx.compact()` runs (>80% ctx window) |
| stopped: quota              | `stopped: quota`                 | HTTP 429 detected (best-effort)              |
| stopped: blocked-on-questions | `stopped: blocked-on-questions` | `openQuestionGate.value` is TRUE             |
| stopped: no-progress        | `stopped: no-progress`           | Predicates unchanged OR iteration limit hit  |
| done (DRAINED)              | `done (DRAINED)`                 | `terminalPredicate(predicates)` is TRUE      |

The REDRIVE path emits a corrective prompt that names the violated predicate
ids (e.g. `pImplement is still TRUE — outstanding items: T470`). The exact
prompt text is produced by `composeRedrivePrompt` in `decide.ts`.

---

## 5. Branches exercised: live vs. unit-covered

| Branch                          | How exercised                                         |
|---------------------------------|-------------------------------------------------------|
| STOP_DRAINED                    | Live (Scenario 1 + 2): real oracle + fake oracle      |
| REDRIVE + corrective prompt     | Scenario 2: two redrives naming pImplement/pPlan      |
| STOP_BLOCKED_ON_QUESTIONS       | Scenario 3: openQuestionGate set, no re-drive emitted |
| All four commands registered    | Scenario 4: registerAllAutoCommands                   |
| STOP_QUOTA (429)                | Unit tests in driver.test.ts (quotaHitRef injection)  |
| COMPACT_THEN_REDRIVE (>80% ctx) | Unit tests in driver.test.ts (contextPercent=85)      |
| STOP_NO_PROGRESS (stall)        | Unit tests in driver.test.ts (identical predicates ×2)|
| Pi status-bar rendering         | Confirmed by gated `setStatus` calls (harness-recorded above); must be eyeballed by a human in a live `pi` session with the TUI visible |

The literal Pi TUI footer update requires a live `pi` session with `hasUI=true`
(which the extension sets automatically when running in TUI mode). The harness
above confirms that `ctx.ui.setStatus('cq-auto', text)` is called at every
lifecycle point when `hasUI=true`; the Pi TUI renders these calls into the
footer status bar.

---

## 6. Unit test coverage

```
cd nix/pkg/pi-extensions/auto-driver && bun test

bun test v1.3.13 (bf2e2cec)

 117 pass
 0 fail
 198 expect() calls
Ran 117 tests across 3 files. [38.00ms]
```

All 117 tests green. Typecheck (`tsc --noEmit`) exits 0. The demo script
(`demo/e2e-demo.ts`) is excluded from the package tsconfig `"include": ["*.ts"]`
(which only matches root-level files, not subdirectories); no tsconfig change
was needed.
