# cq advance-gate Stop-hook: Manual Repro + Live-Evidence Capture

**Task:** T371 / G44 (fixes D50; Q204 strongest-bar capstone)  
**Date:** 2026-06-10  
**Author:** sonnet-4-6

This document captures the live manual repro evidence for the `/cq:advance`
Stop-gate, per Q204. It covers:

1. Documented manual repro with **real captured output** from `cq advance-gate`
   across all verdict branches.
2. The full live-harness repro procedure (post-`home-manager switch`).
3. The accepted irreducible behavioural limit.

---

## Part 1 — Manual Repro with Real Captured Output

All commands were run inside a throwaway temp dir with a freshly-init'd ledger.
The repo is `nix/pkg/cq-ledgers/`; the CLI entrypoint is
`packages/cq-cli/src/main.ts`.

### 1.1 Setup: Create and seed a throwaway ledger

```sh
# Create a temp ledger root
TMPDIR=$(mktemp -d /tmp/cq-repro-XXXXXX)
# => /tmp/cq-repro-cpTfYZ

# Initialise the canonical ledger set
bun run packages/cq-cli/src/main.ts init --cwd "$TMPDIR"
```

**Output:**
```
initialised ledgers at /tmp/cq-repro-cpTfYZ (milestones, defects, tasks, hypothesis, questions, decisions, goals, reviews, handoffs, ideas)
cq init: wrote cq.toml at /tmp/cq-repro-cpTfYZ/cq.toml
```

Seed an open defect so `pInvestigate` is TRUE (one actionable open defect
triggers the investigate predicate):

```typescript
// seed-defect.ts — run from packages/ledger/
import { FsLedgerStore, MILESTONES_AMBIENT_ID } from './src/index.js';
const store = new FsLedgerStore({ root: process.env.TMPDIR! });
await store.init();
const item = await store.createItem('defects', MILESTONES_AMBIENT_ID, {
  status: 'open',
  fields: { headline: 'repro defect for gate demo', severity: 'high' },
});
console.log('Created defect:', item.id);
await store.dispose();
```

**Output:**
```
Created defect: D1
```

---

### 1.2 Case A — marker PRESENT, TRUE predicate → BLOCK (non-zero exit)

```sh
SESSION_ID=test-session
MARKER="${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-${SESSION_ID}"

# Drop the marker (simulates /cq:advance writing it at run start)
touch "$MARKER"

# Run advance-gate; the ledger has D1 open → pInvestigate=TRUE
CLAUDE_CODE_SESSION_ID="$SESSION_ID" \
  bun run packages/cq-cli/src/main.ts advance-gate \
    --session "$SESSION_ID" \
    --cwd "$TMPDIR"
echo "Exit code: $?"
```

**Real captured output (stdout):**
```json
{"block":true,"reason":"P-investigate=TRUE and unblocked; continue per D41 — turn-pause is not a stop condition","predicates":{"pInvestigate":{"value":true,"items":["D1"]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}
```

**Exit code: 1** (non-zero = BLOCK)

Key observations:
- `block: true`
- `reason` names the predicate (`P-investigate=TRUE`) and cites `continue per D41`
- `predicates.pInvestigate.items` lists the specific item (`D1`) driving the block
- Exit code is non-zero (1), which the Stop hook translates to `{decision:"block"}`

---

### 1.3 Case B — marker PRESENT with `external-signal` → ALLOW (exit 0)

```sh
# Append the external-signal line to the existing marker
echo 'external-signal: "context-exhausted — user override"' >> "$MARKER"

# Re-run the gate
CLAUDE_CODE_SESSION_ID="$SESSION_ID" \
  bun run packages/cq-cli/src/main.ts advance-gate \
    --session "$SESSION_ID" \
    --cwd "$TMPDIR"
echo "Exit code: $?"
```

**Real captured output (stdout):**
```json
{"block":false,"reason":"external-signal present in advance marker — allow","predicates":{"pInvestigate":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}
```

**Exit code: 0** (ALLOW)

Key observations:
- `block: false` — the gate allows the stop even though D1 is still open
- `reason` names the escape path (`external-signal present`)
- The `predicates` block carries empty/FALSE values — the ledger is **not read**
  on the external-signal path (short-circuit before `derivePredicates`)

---

### 1.4 Case C — marker ABSENT (gate dormant) → ALLOW (exit 0)

```sh
# Remove the marker entirely
rm "$MARKER"

# Re-run — ledger still has D1 open but the gate is dormant
CLAUDE_CODE_SESSION_ID="$SESSION_ID" \
  bun run packages/cq-cli/src/main.ts advance-gate \
    --session "$SESSION_ID" \
    --cwd "$TMPDIR"
echo "Exit code: $?"
```

**Real captured output (stdout):**
```json
{"block":false,"reason":"no active /cq:advance run (marker absent) — allow","predicates":{"pInvestigate":{"value":false,"items":[]},"pPlan":{"value":false,"items":[]},"pImplement":{"value":false,"items":[]},"openQuestionGate":{"value":false,"items":[]}}}
```

**Exit code: 0** (ALLOW)

Key observations:
- `block: false` even though D1 is open — without the marker the gate does not
  engage at all, and does **not** read the ledger
- This prevents false-positive blocks outside active `/cq:advance` runs

---

### 1.5 Case D — wrapper translation: neutral verdict → Claude Code `{decision:block}`

The `claudeStopGateHook` (defined in `nix/hm/claude.nix` as
`pkgs.writeShellScript "claude-stop-advance-gate"`) translates the neutral
`{block,reason,predicates}` verdict into Claude Code's Stop-hook protocol.

**Wrapper body (extracted from `nix/hm/claude.nix`):**

```sh
set -u
# (1) No session id → the gate can't engage; allow the stop.
if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  exit 0
fi
# (2) Invoke the neutral gate, capturing its stdout (verdict JSON) + exit.
verdict="$(cq advance-gate --session "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD")"
gate_status=$?
# (3) Non-zero → BLOCK: re-emit as Claude Code's hook response.
if [ "$gate_status" -ne 0 ]; then
  printf '%s' "$verdict" | jq -c '{decision: "block", reason: .reason}'
  exit 0
fi
# (4) Exit 0 → ALLOW: emit nothing and let the stop proceed.
exit 0
```

**Live run with marker PRESENT + pInvestigate=TRUE (run from `$TMPDIR` so `$PWD`
  points to the ledger root):**

```sh
cd "$TMPDIR"
touch "$MARKER"   # re-create the marker
CLAUDE_CODE_SESSION_ID="$SESSION_ID" bash /path/to/claude-stop-advance-gate.sh
echo "Wrapper exit code: $?"
```

**Real captured output (wrapper stdout):**
```json
{"decision":"block","reason":"P-investigate=TRUE and unblocked; continue per D41 — turn-pause is not a stop condition"}
```

**Wrapper exit code: 0**

The wrapper exits 0 regardless of block/allow — Claude Code reads the
`{decision:"block"}` JSON from stdout to decide whether to force continuation.
The gate's `block`/`predicates` fields are dropped; only `reason` is lifted.

**The T372 integration test** (`packages/cq-cli/test/claude-stop-hook.test.ts`)
is the committed, hermetic evidence of this contract: it extracts the exact
wrapper body from `claude.nix` (single source of truth), realizes it as a
runnable script, stubs `cq` in PATH, and asserts:

- (a) stub `cq` exits non-zero → wrapper stdout is `{decision:"block", reason:<gate reason>}`, exit 0
- (b) stub `cq` exits 0 → wrapper stdout is empty, exit 0  
- (c) no `$CLAUDE_CODE_SESSION_ID` → wrapper allows without invoking `cq`

Run it with: `bun test packages/cq-cli/test/claude-stop-hook.test.ts`

---

## Part 2 — Full Live-Harness Repro (Post-`home-manager switch`)

This section documents the end-to-end manual repro a developer runs AFTER
`home-manager switch` has installed the Stop hook into Claude Code's settings.

### Prerequisites

```sh
home-manager switch   # installs claudeStopGateHook into settings.hooks.Stop
# Verify the hook is registered:
cat ~/.claude/settings.json | jq '.hooks.Stop'
# Expected: [{matcher:"*", hooks:[{type:"command", command:"/nix/store/.../claude-stop-advance-gate"}]}]
```

The hook script lives at a Nix store path; `cq` must be on `$PATH` (installed
via `tools.nix`'s `ledgerTools`).

### Step-by-step repro

```sh
# 1. Start a /cq:advance run in a repo with an actionable ledger state.
#    (E.g. a repo with an open defect or a planned goal with a DAG-ready task.)
#    The /cq:advance flow writes the marker at:
#      ${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-${CLAUDE_CODE_SESSION_ID}
#    This happens inside the /cq:advance skill's "drop marker" step.

# 2. The flow proceeds through investigate/plan/implement cycles.

# 3. At some point the model reaches a state where it would normally end the
#    turn — e.g. after completing a subtask, before the next loop iteration,
#    or between implement rounds. Claude Code fires the registered Stop hook:
#
#      CLAUDE_CODE_SESSION_ID=<session> bash /nix/store/.../claude-stop-advance-gate
#
# 4. The wrapper invokes:
#
#      verdict="$(cq advance-gate --session "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD")"
#
#    If the ledger still has an actionable predicate (pInvestigate/pPlan/pImplement
#    is TRUE-and-unblocked), `cq advance-gate` emits (example):
#
#      {"block":true,"reason":"P-implement=TRUE and unblocked; continue per D41 ...","predicates":{...}}
#
#    with exit code 1.
#
# 5. The wrapper sees non-zero exit and emits to stdout:
#
#      {"decision":"block","reason":"P-implement=TRUE and unblocked; continue per D41 ..."}
#
#    Claude Code reads this from the hook's stdout, sees `decision: "block"`, and
#    FORCES the model to continue (feeding the `reason` back as context).
#
# 6. The model continues the /cq:advance loop — picking up the next DAG-ready
#    task, advancing the next flow cycle, etc.

# 7. When the flow DRAINS (all predicates FALSE or no actionable work), the gate
#    emits {block:false,...} with exit 0. The wrapper outputs nothing. Claude
#    Code lets the stop proceed normally.

# 8. Cleanup: the /cq:advance skill removes the marker on a normal exit:
#      rm "${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-${CLAUDE_CODE_SESSION_ID}"
#
#    After removal, subsequent Stop hook firings ALLOW immediately (case C above).
```

### Genuine-exhaustion escape hatch

If the model has truly exhausted its context window and cannot make further
progress (regardless of predicate state), a human operator or the harness can
write the external-signal line:

```sh
MARKER="${XDG_RUNTIME_DIR:-/tmp}/cq-advance-active-${CLAUDE_CODE_SESSION_ID}"
echo 'external-signal: "context-exhausted — operator override"' >> "$MARKER"
# Next Stop-hook firing will ALLOW (exit 0, empty wrapper stdout) even if
# predicates are still TRUE.
```

---

## Part 3 — Accepted Irreducible Behavioural Limit

Per Q204 / D50, the following limits are **acknowledged and accepted**:

1. **The hook forces continuation; it cannot make a genuinely context-exhausted
   model productive.** When the context window is truly saturated, a forced-
   continuation turn produces degraded output. However, a degraded forced-
   continuation that may still make partial progress beats a **silent premature
   stop** — the original defect D50. The `external-signal` escape covers the
   genuine-exhaustion case explicitly.

2. **Claude Code only.** The `claudeStopGateHook` wrapper is specific to Claude
   Code's Stop-hook protocol (`{decision:"block",reason}` on stdout). Other
   harnesses (Codex, non-CC scripts) need their own stop-hook equivalent to
   enforce the D41 continuation invariant. The neutral `cq advance-gate` CLI
   (exit code + JSON) is the reusable primitive; the D41 prose remains the
   fallback specification for other harnesses.

3. **Marker lifecycle is the caller's responsibility.** The `/cq:advance` skill
   writes the marker at start and removes it on normal completion. An abnormal
   termination (crash, SIGKILL) can leave a stale marker. Operators can manually
   remove it; the external-signal escape also unblocks the next session if the
   stale marker persists.

4. **This end-to-end live session is NOT a CI gate.** The automated evidence is
   the T367 unit tests (`advance-gate.test.ts`) and the T372 integration test
   (`claude-stop-hook.test.ts`). The live evidence above (Part 1) demonstrates
   the components work together as specified; the live Part 2 procedure requires
   a real `home-manager switch` installation and is validated manually.

---

## References

- `nix/pkg/cq-ledgers/packages/cq-cli/src/advanceGate.ts` — gate logic
- `nix/pkg/cq-ledgers/packages/cq-cli/src/main.ts` — `advance-gate` subcommand dispatcher
- `nix/hm/claude.nix` — `claudeStopGateHook` wrapper (Stop-hook registration)
- `nix/pkg/cq-ledgers/packages/cq-cli/test/advance-gate.test.ts` — T367 unit tests
- `nix/pkg/cq-ledgers/packages/cq-cli/test/claude-stop-hook.test.ts` — T372 wrapper integration test
- Decisions: D41 (continuation invariant), D50 (Stop-hook limit)
- Questions: Q199–Q202 (verdict cases), Q204 (strongest-bar evidence)
