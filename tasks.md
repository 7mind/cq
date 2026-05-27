# cq — active task ledger

**Cycle:** outer-2 / post-discharge E2E fixes (3 defects open).
**Goal:** ✓ build cq per [`./prompt.md`](./prompt.md). Discharge condition met: all five milestones `[x]` and archived; `bun run check` exits 0 (tsc + eslint + 399 tests); `bun run start --cwd <real-dir>` launches; sample prompt round-trips verified via PR-51 e2e + post-discharge real-SDK tests (`sdk-stub.test.ts`, `ask-question.test.ts`) running the bundled CLI binary against `MockAnthropicHTTP`. M1 E2E now drives a real client `Manager` in-process against the fixture server.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _3 open: `E2E-D01` (search/Esc), `E2E-D02` (scroll-anchor jump-button visibility), `E2E-D03` (stop test timing). All earlier defects resolved._
**Final session log:** [`docs/logs/20260526-final-log.md`](docs/logs/20260526-final-log.md).

## Milestones — final

- [x] **M0 — Bring-up** — archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md). 5 PRs; 113 tests.
- [x] **M1 — WebSocket spine** — archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md). 14 PRs; full R2-R13 + V1-V10 Part-3.
- [x] **M2 — Agent SDK / Chat MVP** — archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md). 9 PRs.
- [x] **M3 — Chat full fidelity** — archive: [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md). 12 PRs.
- [x] **M4 — Persistence + History tab** — archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md). 9 PRs.
- [x] **M5 — Polish & harden** — archive: [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md). 7 PRs.

**56 PRs shipped + 3 post-discharge defect fixes. 403 tests passing. 0 fails, 0 skips, 0 open defects, 0 algedonic escalations to the user.**

## Active — outer-2 (E2E green-up)

Goal: Playwright suite all-green. Constraints from user: no bridge/Manager/SDK changes; UI handler or test-level corrections only; commit-per-fix; `bun run check` and `bun run e2e` both end green.

- [x] **E2E-D01** — SearchBar Esc handler. `packages/web/src/chat/SearchBar.tsx`. Acceptance: `bun x playwright test search` exits 0. Resolved: added `onKeyDown` on the bar `<div>` so Esc fires `onClose` even when focus is on a navigation button (not just the input). Commit: `HEAD`. Result: `bun x playwright test search` → 1 passed; `bun run e2e` → 4/6 pass.
- [ ] **E2E-D02** — Jump-to-latest visibility. `packages/e2e/tests/scroll-anchor.spec.ts` (test-level fix: scripted-multi-message setup). Acceptance: `bun x playwright test scroll-anchor` exits 0.
- [ ] **E2E-D03** — Stop test timing. `packages/e2e/tests/stop.spec.ts` (test-level: wait for first chat.event before clicking Stop; bump post-Stop timeout). Acceptance: `bun x playwright test stop` exits 0.

After all three: `bun run check` 0; `bun run e2e` 6/6 pass.

## Post-discharge fixes

- `fix: install real SDK binary (PR-20-D01) + verify Candidate-A spike (PR-31-D01)` — Pinned `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.150` in `packages/server/package.json`; added `resolveNativeBinaryPath()` to bridge.ts; added real-SDK test cases to `sdk-stub.test.ts`, `mcp-inheritance.test.ts`, and `ask-question.test.ts`; updated `MockAnthropicHTTP` to handle `HEAD /` probe and multi-round `scriptedResponder`; confirmed Candidate-A (synthetic tool_result injection) works against real subprocess. 399 tests pass (3 new).
- `fix: web → composite TS project + ws-resilience drives real Manager (closes PR-18-D01)` — Made `packages/web` a TypeScript composite project (`composite:true`, `declaration:true`, `declarationMap:true`, `rootDir:./src`); created `packages/web/src/index.ts` re-exporting `Manager`, `Connection`, and related types; updated `packages/server/tsconfig.json` to reference `../web` and add `@cq/web` path alias; rewrote `ws-resilience.test.ts` to drive a real `Manager` with real Bun `WebSocket` transport against the fixture server (all 3 scenarios pass). Also fixed `isRetriable` to treat 1006 (ABNORMAL_CLOSURE) as retriable so the stale-grace DEAD path schedules reconnection. 399 tests pass (0 new failures).
- `fix: AskUserQuestion uses toolAliases + SDK-MCP (PR-31-D02; replaces Candidate-A injection)` — Replaced Candidate-A synthetic SDKUserMessage injection with the SDK-native `toolAliases + createSdkMcpServer` path. `askUserQuestion.ts` rewritten as `AskBroker` + `createAskUserQuestionMcpServer`. `bridge.ts` wires `Options.toolAliases = { AskUserQuestion: 'mcp__cq__ask_user_question' }`, `Options.mcpServers = {...externalServers, cq: askMcpServer}`, auto-allows `mcp__cq__*` in `canUseTool` with `updatedInput: {}` (subprocess Zod schema workaround), and buffers WS replies that arrive before the MCP handler calls `broker.ask()`. `ask-question.test.ts` rewritten with `AskBroker` unit tests + new real-SDK spike confirming end-to-end MCP round-trip. Added `zod` dep to `packages/server`. 403 tests pass (+4 net).

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
- M3 → [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)
- M4 → [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)
- M5 → [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md)
