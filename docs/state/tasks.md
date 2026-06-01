# ledger plan-flow — Task Ledger

Authoritative ledger of planned and completed work for the portable, ledger-native
"plan" workflow (goal → clarifying Q&A → planning → adversarial review → planned).
Scope/design governed by `./docs/drafts/20260601-1606-plan-flow.md` and the locked
notes below (which override the plan doc where they differ).

Status: `[ ]` planned · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Milestones (high-level)

- [~] **M1** — Server/data formality: transition guard (F1, all canonical ledgers),
  goal preconditions (F2), `reviews` ledger (F3), bootstrap regeneration.
- [ ] **M2** — Portable orchestration: `prompts/` source dir (symlinked into Claude
  + Codex locations) — `/plan:start`, `/plan:advance`, `plan-reviewer`.
- [ ] **M3** — Non-AI watcher (F4): `@cq/ledger-live` process re-invoking the open
  session on the resume predicate.
- [x] **M4** — UI quick-transition buttons (TUI + web): render only the legal next
  statuses from the schema `transitions` map as one-click actions. Edits
  `ledger-tui`/`ledger-web` only. **Depends on PR-01** (the map) AND on that map
  being surfaced in the `fetch_ledger`/schema MCP response. Can run in an isolated
  worktree, parallel to M2/M3, once PR-01 is committed.

Sequencing M1 → M2 → M3; M4 parallel with M2/M3 after PR-01 lands; M2/M3 may overlap.

---

## Milestone 1 — PR breakdown

Detail in `./docs/drafts/20260601-1606-plan-flow.md`. One line per PR here.

- [x] **PR-01** — F1 transition guard: optional `transitions` on `LedgerSchema`,
  enforced in `core.ts::applyUpdateItem`; plumb registry/Zod/divergence/clone;
  populate maps for ALL 7 canonical ledgers. Failing test first.
  Acceptance: `bun test packages/ledger/test/transitions.test.ts` passes on both
  stores (illegal `clarifying→planned` throws; field-only update skips guard);
  `bun run check` clean.
- [x] **PR-02** — F2 goal preconditions in both stores' `updateItem`: refuse leaving
  `clarifying` while an open linked question exists; refuse entering `planned`
  without a locked linked `decisions` item. Failing tests first.
  Acceptance: `bun test packages/ledger/test/goal-preconditions.test.ts` passes on
  both stores; `bun run check` clean.
- [ ] **PR-03** — F3 `reviews` ledger: new canonical ledger; verdict = `status`
  enum (`go-ahead|revise`); `new_questions`/`criticism` as `string[]`; linked to
  goal via `ledgerRefs`. Failing test first.
  Acceptance: reviews case in `canonical-ledgers.test.ts` passes both stores;
  out-of-enum verdict throws `InvalidStatusError`; `bun run check` clean.
- [ ] **PR-04** — Regenerate bootstrap `docs/ledgers.yaml` (+ example ledgers) to
  match the bumped canonical schemas. No forward-compat path (per user: not in
  production yet). Acceptance: `ledger-mcp` starts against the repo `docs/` with
  no divergence error; `bun run check` clean.

---

## Cross-cutting architectural notes (locked)

- [x] **No backwards-compat / no migration path** — repo not in production (user
  decision 2026-06-01). PR-04 just regenerates the on-disk bootstrap; no
  forward-compat upgrade code in `FsLedgerStore.init`.
- [x] **`transitions` populated for ALL 7 canonical ledgers** (user decision
  2026-06-01), not goals-only. The guard mechanism is general; every canonical
  schema declares its allowed map. Lands PR-01.
- [x] **Codex/Claude prompt sharing = single `prompts/` source dir + symlinks**
  (user decision 2026-06-01) into `.claude/commands/`, `.claude/agents/`, and the
  Codex locations. One source of truth. Lands M2.
- [x] **F1 enforced in `core.ts::applyUpdateItem` (core.ts:209)** — both stores
  delegate status mutation there → dual-store-correct by construction. Guard runs
  only when `patch.status !== undefined` and the status actually changes.
- [x] **`transitions` is an optional schema field; absent ⇒ no enforcement** —
  keeps user-created ledgers unconstrained. Round-trips via `ledgers.yaml` only
  (not `.md` frontmatter — `parseLedger` takes schema as a param). Touch-points:
  `serializeRegistry`/`parseSchema` (registry.ts:142/78), `schemasEqual`
  (FsLedgerStore.ts:951), `cloneSchema` (InMemoryLedgerStore.ts:567),
  `validateSchema` (core.ts:113), both Zod `schemaSchema` fragments.
- [x] **F2 at the LedgerStore layer (both stores), not core, not tool layer** —
  mirrors `assertMilestoneActive`/`archiveMilestone`; the cross-ledger view exists
  at the store, and the tool layer is bypassable by the TUI/web editor.
- [x] **F3 = new `reviews` ledger, verdict as `status` enum** — `statusValues` is
  store-enforced (`assertStatusAllowed`), giving schema-validated verdicts with no
  new validation code; review history stays queryable/linkable.
- [x] **No author enum** — `author` stays intrinsic/free-form (avoids coupling the
  library to a model roster and tripping the divergence guard). Provenance
  convention (actual model class, never hardcoded) lives in the prompts.
- [x] **Watcher reuses `LiveManager` + MCP HTTP `/mcp` reads** — no file reads;
  `onChanged` on `{type:"changed",ledger}`; must `check()` on arm to close the
  disarmed-race. Lands M3.

---

## Completed

- **PR-01** (2026-06-01) — F1 declarative status-transition guard. Shipped: optional
  `transitions?: Record<string,string[]>` on `LedgerSchema` (`types.ts`), enforced in
  `core.ts::applyUpdateItem` via `assertTransitionAllowed` (fires only when `patch.status`
  is set AND differs from current; absent map ⇒ no enforcement) with a new
  `InvalidTransitionError`; plumbed through `parseSchema`/`serializeRegistry` (registry.ts),
  `schemasEqual`/`transitionsEqual` (FsLedgerStore.ts), `cloneSchema` (InMemoryLedgerStore.ts),
  `validateSchema` (core.ts), and both MCP `schemaSchema` Zod fragments. Populated maps for
  ALL 7 canonical ledgers (constants.ts). `validateSchema` now also rejects outgoing edges on
  a terminal status. Added `scripts/regen-bootstrap.ts` (+ `regen-bootstrap` npm script) to
  rebuild `docs/ledgers.yaml` from canon via `serializeRegistry`.
  Verification: `bun run check` → tsc clean, eslint clean, `bun test` 332 pass / 0 fail (30
  files); `bun test packages/ledger/test/transitions.test.ts` green on both stores; boot
  regression test inits `FsLedgerStore` against the regenerated registry with no
  `BootstrapViolationError`; `bun run regen-bootstrap` idempotent (byte-identical re-run).
  Metrics: review rounds 2; defects major:1, minor:2, nit:3 (all resolved/accepted);
  verification complete; scope delta none.
  Notes / surprises / constraints for later PRs:
  - **`docs/ledgers.yaml` is gitignored** (local dogfood runtime state) — the durable artifact
    is the committed `scripts/regen-bootstrap.ts`. PR-03 MUST add the `reviews` ledger to
    `CANONICAL_LEDGERS` and re-run `bun run regen-bootstrap` (the script iterates the canonical
    set generically, so a new ledger is picked up automatically).
  - **No backwards-compat path** (user decision): the strict `BootstrapViolationError` divergence
    guard is retained; on any canonical schema change, regenerate the on-disk bootstrap rather
    than tolerating staleness. Do NOT add a "tolerate stale file" test.
  - `transitionsEqual` is **order-significant** on to-status arrays — keep canonical map array
    order stable, or the bootstrap will false-positive divergence.
  - **`transitions` IS exposed to pure MCP clients** via `fetch_ledger` → `cloneSchema` →
    `jsonResult` (no field projection). This unblocks M4 (UI quick-transition buttons): the
    frontend can read the map from the fetched ledger schema today.
  - The whole `docs/` tree is untracked in git except where individually added; the review-loop
    state (`docs/state/`, `docs/drafts/`) is added explicitly per commit.

- **M4** (2026-06-01) — UI quick-transition buttons (TUI + web). Shipped: both clients read
  `schema.transitions[item.status]` from the fetched MCP ledger schema and render one-click
  actions for ONLY the legal next statuses, dispatching the existing `update_item({status})`
  path (TUI status overlay; web detail-panel `transition to` button row, styled via new
  `.lw-transitions`/`.lw-transition` CSS). Absent map → existing status editor unchanged;
  terminal (`[]`) → no actions. Web excludes milestones (their status routes via
  `updateMilestone`); TUI dispatches milestone status via `updateMilestone` correctly.
  Executed in an isolated worktree, then transplanted onto `feat/plan-flow` (disjoint packages).
  Verification: `bun run check` on the combined PR-02+M4 tree → tsc/eslint clean, `bun test`
  362 pass / 0 fail (31 files); M4 UI suites 77 pass.
  Metrics: review rounds 1 (no major/minor; 4 accepted nits); verification complete; scope
  delta none (confined to ledger-tui + ledger-web).
  Notes:
  - **Worktree gotcha:** `Agent isolation:"worktree"` branched off `main`, NOT the current
    `feat/plan-flow` — so the worktree initially lacked the F1 `transitions` field. The agent
    rebased onto `feat/plan-flow`. For future parallel editors, verify the worktree base branch.
  - `transitions` reaches clients via `fetch_ledger` → `cloneSchema` → JSON (no projection);
    field path in both UIs is `view.schema.transitions`.

- **PR-02** (2026-06-01) — F2 server-enforced goal preconditions. Shipped: a shared pure helper
  `assertGoalPhasePreconditions` (core.ts) invoked via a `StatusChangePrecondition` hook in
  `applyUpdateItem` AFTER the F1 transition guard; both stores pass a closure (only when
  `ledgerId === goals`) over their in-memory questions/decisions ledgers. Rule (a): cannot leave
  `clarifying` while any `open` question links the goal (`ledgerRefs ∋ "goals:<G>"`). Rule (b):
  cannot enter `planned` without ≥1 `locked` `decisions` item linking the goal. New
  `GoalPreconditionError` (names goal, rule, blocking ids).
  Verification: `bun run check` → tsc/eslint clean, `bun test` 356 pass / 0 fail (31 files);
  `bun test goal-preconditions.test.ts` 24 pass on both stores.
  Metrics: review rounds 1 (no major; minor/doc/test fixes verified by the added tests);
  defects major:0, minor:2, nit:1; verification complete; scope delta none.
  Notes / constraints for later PRs:
  - **Ordering invariant:** the precondition runs AFTER the transition guard, so a schema-illegal
    jump surfaces as `InvalidTransitionError`, not `GoalPreconditionError`. Pinned by a test —
    don't reorder.
  - **Enforcement is per-process** (exact within a process, best-effort across processes under the
    eventual-consistency D-COHERENCE model). Documented in the helper; not lock-enforced.
  - Goal-specific rules live in the generic store (gated on the `goals` ledger name); a fully
    declarative precondition DSL was deliberately deferred (simplicity-first). No schema change ⇒
    no `regen-bootstrap` needed for this PR.
