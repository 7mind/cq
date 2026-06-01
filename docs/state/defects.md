# ledger plan-flow — Defect Ledger

Adversarial-review findings for the plan-flow implementation. Append-only;
flip status, never delete. Grouped by PR.

Status: `[ ] open` · `[~] under fix` · `[x] resolved`

---

## PR-01

### [PR-01-D01] Pre-existing on-disk ledgers fail to boot with BootstrapViolationError after canonical schemas gain `transitions`
**Status:** [x] resolved
**Severity:** major
**Location:** packages/ledger/src/store/FsLedgerStore.ts:279 (`schemasEqual`), :957-977 (`transitionsEqual`); vs on-disk docs/ledgers.yaml (no `transitions:` blocks)
**Description:** Any `FsLedgerStore` whose `ledgers.yaml` was written before this change has `schema.transitions === undefined` for canonical ledgers. On init, `transitionsEqual(undefined, {...})` → false → `schemasEqual` false → `BootstrapViolationError`. Reproduced against a copy of the repo's live `docs/`: "existing milestones ledger has a different schema than its canonical bootstrap schema". No FS test caught it (all use fresh tmp dirs). The repo's own `.mcp.json`-wired ledger is exactly such a store.
**Root cause:** Canonical schemas changed in code (transitions added) while the on-disk bootstrap is stale; the divergence guard is strict and exact.
**Fix:** Added `scripts/regen-bootstrap.ts` (+ `regen-bootstrap` npm script) that rebuilds `docs/ledgers.yaml` from `CANONICAL_LEDGERS` via the store's own `serializeRegistry` (byte-compatible, idempotent); regenerated the file so all 7 canonical schemas carry their `transitions` maps. No compat/auto-migrate code added; divergence guard kept strict (correct). Regression test in `canonical-ledgers.test.ts` boots an `FsLedgerStore` against the regenerated registry and asserts success. NOTE: `docs/ledgers.yaml` is gitignored (local dogfood state); the durable artifact is the committed regen script, which PR-03 reuses for the `reviews` ledger. Verified: store inits against `docs/` with no `BootstrapViolationError`.

### [PR-01-D02] `validateSchema` accepts outgoing transitions declared on a terminal status
**Status:** [x] resolved
**Severity:** minor
**Location:** packages/ledger/src/store/core.ts:155-172
**Description:** Validation checks only that transition keys/values are members of `statusValues`; a user-declared map may give a terminal status outgoing edges (e.g. `resolved: ["open"]`) and pass. Canonical maps all use `[]` for terminals, so no live impact — a soundness gap the brief explicitly asked about.
**Fix:** `validateSchema` (core.ts) now throws `SchemaValidationError` when a transition key is in `terminalStatuses` with a non-empty target array. Test added in `transitions.test.ts` (terminal-with-outgoing rejected; terminal with `[]` accepted).
**Status note:** [x] resolved.

### [PR-01-D03] Milestone holds cannot move directly between `postponed` and `blocked`
**Status:** [x] resolved
**Severity:** minor
**Location:** packages/ledger/src/constants.ts (`MILESTONES_SCHEMA.transitions`)
**Description:** `postponed → blocked` and `blocked → postponed` are rejected (both route through `open`). A real reduction of the milestone state graph; no test/data exercises it. Reviewer asked to confirm intent.
**Fix:** Added direct edges to `MILESTONES_SCHEMA.transitions` in constants.ts (`postponed → [open, done, blocked]`, `blocked → [open, done, postponed]`); regenerated bootstrap reflects them.

### [PR-01-D04] Misleading comment in `parseTransitions` claims membership is not re-checked
**Status:** [x] resolved
**Severity:** nit
**Location:** packages/ledger/src/registry.ts:127-128
**Description:** Comment says membership against `statusValues` is "NOT re-checked here (the guard tolerates unknown entries)". False — `parseSchema` calls `validateSchema` immediately after, which throws on unknown from/to statuses. Behavior is correct and strict; only the comment misleads.
**Fix:** Reworded the `parseTransitions` comment (registry.ts) to state shape is enforced here and status-membership is enforced by the subsequent `validateSchema` call in `parseSchema`.

### [PR-01-D05] No test directly pins the canonical transition maps (esp. milestones)
**Status:** [x] resolved
**Severity:** nit
**Location:** packages/ledger/test/transitions.test.ts
**Description:** Runtime guard tests only exercise `goals`; D02 tests use synthetic schemas. No assertion pins the D03 `postponed↔blocked` edges or the other canonical maps. They're validated indirectly (every map passes `validateSchema` at bootstrap), but a regression silently dropping an edge would go uncaught.
**Fix:** Added a `canonical schema transition maps — pinned edges` block in `transitions.test.ts` with exact-edge assertions across all 7 canonical maps (milestones `postponed↔blocked` + `done:[]`; goals `clarifying→planning` present, `→planned` absent; questions `open→{answered,withdrawn}`; one edge each for defects/tasks/hypothesis/decisions).

### [PR-01-D06] `scripts/` excluded from lint
**Status:** [x] resolved (accepted; see Fix)
**Severity:** nit
**Location:** package.json (`"lint": "eslint packages"`)
**Description:** New `scripts/regen-bootstrap.ts` lives outside `packages/`, so `bun run lint` never checks it. Low impact (trivial script, exercised indirectly by the boot test). Note: root `check` runs `eslint .` which DOES cover `scripts/`; only the standalone `lint` script narrows to `packages`.
**Fix:** Accepted as-is — `eslint .` in the `check` gate already covers `scripts/`, so the script is linted by the authoritative gate; no change needed. Recorded for awareness.
