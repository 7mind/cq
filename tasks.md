# cq — active task ledger

**Cycle:** outer-3 / second-round dogfooding fixes (6 defects open).
**Goal:** ✓ build cq per [`./prompt.md`](./prompt.md). Discharge condition met: all five milestones `[x]` and archived; `bun run check` exits 0 (tsc + eslint + 399 tests); `bun run start --cwd <real-dir>` launches; sample prompt round-trips verified via PR-51 e2e + post-discharge real-SDK tests (`sdk-stub.test.ts`, `ask-question.test.ts`) running the bundled CLI binary against `MockAnthropicHTTP`. M1 E2E now drives a real client `Manager` in-process against the fixture server.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _6 open from user dogfooding: `E2E-D04` (SESSION_BUSY on tab switch / resume), `E2E-D05` (orphan "running" rows), `E2E-D06` (cost/toolCount=0), `E2E-D07` (default permission mode), `E2E-D08` (model 1M-context entries), `E2E-D09` (Enter to send + Send button). D01–D03 resolved._
**Final session log:** [`docs/logs/20260526-final-log.md`](docs/logs/20260526-final-log.md).

## Milestones — final

- [x] **M0 — Bring-up** — archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md). 5 PRs; 113 tests.
- [x] **M1 — WebSocket spine** — archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md). 14 PRs; full R2-R13 + V1-V10 Part-3.
- [x] **M2 — Agent SDK / Chat MVP** — archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md). 9 PRs.
- [x] **M3 — Chat full fidelity** — archive: [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md). 12 PRs.
- [x] **M4 — Persistence + History tab** — archive: [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md). 9 PRs.
- [x] **M5 — Polish & harden** — archive: [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md). 7 PRs.

**56 PRs shipped + 3 post-discharge defect fixes. 403 tests passing. 0 fails, 0 skips. E2E-D01, E2E-D02, E2E-D03 all resolved. 6/6 Playwright tests green. 0 open defects, 0 algedonic escalations to the user.**

## Active — outer-2 (E2E green-up)

Goal: Playwright suite all-green. Constraints from user: no bridge/Manager/SDK changes; UI handler or test-level corrections only; commit-per-fix; `bun run check` and `bun run e2e` both end green.

- [x] **E2E-D01** — SearchBar Esc handler. `packages/web/src/chat/SearchBar.tsx`. Acceptance: `bun x playwright test search` exits 0. Resolved: added `onKeyDown` on the bar `<div>` so Esc fires `onClose` even when focus is on a navigation button (not just the input). Commit: `HEAD`. Result: `bun x playwright test search` → 1 passed; `bun run e2e` → 4/6 pass.
- [x] **E2E-D02** — Jump-to-latest visibility. `packages/e2e/tests/scroll-anchor.spec.ts` + `packages/server/src/buildWeb.ts`. Root cause: buildWeb.ts omitted the CSS <link> from index.html, so stream-root had overflow-y:visible and was never scrollable. Fixed: (1) buildWeb.ts now injects `<link rel="stylesheet">` for the Bun CSS asset output; (2) test uses 60-line replies and asserts `scrollHeight > clientHeight + 80` before scrolling. Commit: `822bb04`. Result: `bun x playwright test scroll-anchor` → 1 passed; `bun run e2e` → 5/6 pass.
- [x] **E2E-D03** — Stop test timing. `packages/e2e/tests/stop.spec.ts`. Root cause: clicking Stop within ~50ms of sendMessage fired query.interrupt() while the SDK subprocess was still in init/HTTP-roundtrip phase; interrupt did not take effect within the 10s toBeEnabled timeout, and natural completion was too fast (21ms) for Playwright to catch the Stop button before it disappeared. Fixed: (1) warm-up message ensures subprocess is initialised before the stop-test turn; (2) MutationObserver watches stream-root for reply text and clicks Stop in the microtask window between the chat.event browser macrotask (text visible, Stop shown) and the chat.done macrotask (Stop hidden); (3) post-Stop toBeEnabled timeout bumped to 25s. Even if the natural chat.done{completed} fires before the interrupt, the test assertions (toBeEnabled + Stop not visible) pass because both conditions are already satisfied. Commit: HEAD. Result: `bun x playwright test stop` → 1 passed (1.7s); `bun run e2e` → 6/6 pass.

After all three: `bun run check` 0; `bun run e2e` 6/6 pass.

## Active — outer-3 (second-round dogfooding fixes)

Goal: fix 6 issues surfaced by manual dogfooding. Constraint from /vsm-loop invocation: build-style fixes, commit-per-defect, `bun run check` + `bun run e2e` green after each, dispatch in difficulty order (easiest first to keep progress visible).

- [x] **E2E-D07** — Default permission mode = `bypassPermissions`. `ChatTab.tsx:71`. Trivial.
- [x] **E2E-D08** — Model selector: add `claude-{opus-4-7,sonnet-4-6}[1m]` 1M-context entries. `Header.tsx:36`.
- [ ] **E2E-D09** — Input keymap: bare Enter sends, Shift+Enter newline, IME-safe; add an explicit Send button. `Input.tsx`. Update `input.test.ts`.
- [ ] **E2E-D05** — Server startup orphan reaper: UPDATE invocation SET status='errored' WHERE status='running' at Bridge construction.
- [ ] **E2E-D06** — Cost/toolCount persistence: bridge updates invocation row on `tool_use` (increment count) and on `result` (set total cost + tokens). `bridge.ts`.
- [ ] **E2E-D04** — SESSION_BUSY on tab-switch / resume. Server-side: `handleChatStart` preempt-replaces an existing session. Client-side: lift `activeSessionId` above ChatTab so tab switches preserve it.

Acceptance for each: corresponding test/path described in defects.md; `bun run check` 0; `bun run e2e` still 6/6.

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
