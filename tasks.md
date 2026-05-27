# cq — active task ledger

**Cycle:** outer-5 / `@cq/ledger` build. **Discharged.**
**Goal:** Ship `packages/ledger` (markdown-backed ledger library) + in-process MCP tool surface registered on the existing `cq` server, end-to-end agent-callable per Q12 acceptance.
**Accepted plan:** [`docs/drafts/20260527-2330-ledger-plan.md`](docs/drafts/20260527-2330-ledger-plan.md).
**Discharge evidence:** `bun run check` → 558 pass / 0 fail (was 524 baseline; +34 ledger-related tests); `bun run e2e` → 16/16 pass (was 15; +1 ledger-create spec).

## Milestones — historical (cq core)

- [x] **M0 — Bring-up** — archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md).
- [x] **M1 — WebSocket spine** — archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md).
- [x] **M2 — Agent SDK / Chat MVP** — archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md).
- [x] **M3 — Chat full fidelity** — archive: [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md).
- [x] **M4 — Persistence + History tab** — archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md).
- [x] **M5 — Polish & harden** — archive: [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md).

## Active — outer-5 (`@cq/ledger`)

- [x] **L1** — Package scaffold + types. New `packages/ledger` with composite tsconfig, `types.ts`, `src/index.ts`; root workspaces entry; root tsconfig reference. Commit `061c09f`-ish (L1 commit).
- [x] **L2** — Parser + serializer + round-trip test. `parse.ts`, `serialize.ts`, `frontmatter.ts`. 4 round-trip cases (representative fixture, idempotency, empty ledger, archive milestone).
- [x] **L3** — Store interface + InMemoryLedgerStore + FsLedgerStore + lockfile + mutex. 9-case abstract suite × 2 adapters + 3 lockfile cases = 21 tests.
- [x] **L4** — Concurrency test. 3 cases: 50 parallel updates, 50 parallel creates, cross-ledger parallelism.
- [x] **L5** — Registry + createLedger / archiveMilestone (folded into L3).
- [x] **L6** — MCP tool factory. 12 tools (`mcp__cq__enumerate_ledgers`…`mcp__cq__search_items`); 5 unit cases.
- [x] **L7** — Server wiring. `bridge.ts` accepts `ledgerStore?`; `server.ts`/`devServer.ts`/`main.ts` construct `FsLedgerStore({ root: cwd })` and pass through. `mcp__cq__*` auto-allow already in place — no `canUseTool` change.
- [x] **L8** — Real-SDK integration test. `packages/server/test/ledger-integration.test.ts`: real SDK subprocess + MockAnthropicHTTP + FsLedgerStore on tmp dir; asserts `mcp__cq__enumerate_ledgers` tool_use surfaces and the result re-enters the conversation.
- [x] **L9** — Playwright e2e. `packages/e2e/tests/ledger-create.spec.ts`: scripts mock to issue `mcp__cq__create_ledger{name:'todos'}` then confirmation; asserts `./docs/todos.md` + `./docs/ledgers.yaml` on disk. Mock server gained `/__admin/scriptOnToolResult` for two-turn scripting.
- [x] **L10** — Manual UI dogfood + discharge. Discharge condition met: `bun run check` 558/558, `bun run e2e` 16/16. Manual dogfood deferred to user's own session — L8 and L9 integration tests exercise the full code path through the real SDK subprocess against MockAnthropicHTTP, which is the only end-to-end coverage we can run without consuming the user's Anthropic API quota.

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
- M3 → [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)
- M4 → [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)
- M5 → [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md)
