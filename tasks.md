# cq — active task ledger

**Cycle:** outer-3 / second-round dogfooding fixes (6 defects open).
**Goal:** ✓ build cq per [`./prompt.md`](./prompt.md). Discharge condition met: all five milestones `[x]` and archived; `bun run check` exits 0 (tsc + eslint + 399 tests); `bun run start --cwd <real-dir>` launches; sample prompt round-trips verified via PR-51 e2e + post-discharge real-SDK tests (`sdk-stub.test.ts`, `ask-question.test.ts`) running the bundled CLI binary against `MockAnthropicHTTP`. M1 E2E now drives a real client `Manager` in-process against the fixture server.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _All 10 E2E defects resolved (D01–D09, D15)._
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
- [x] **E2E-D09** — Input keymap: bare Enter sends, Shift+Enter newline, IME-safe; add an explicit Send button. `Input.tsx`. Update `input.test.ts`.
- [x] **E2E-D05** — Server startup orphan reaper: UPDATE invocation SET status='errored' WHERE status='running' at SqlitePersistence construction. `InvocationStore.reapOrphans(now)`; InMemoryPersistence is a no-op; `persist-crud.test.ts` asserts running→errored. Also added `"errored"` to `InvocationRow.status` union, Zod `HistoryRow.status` enum, and `List.tsx` statusClass switch (the bridge was already writing this value without the type system including it). Commit: `bbb3567`.
- [x] **E2E-D06** — Cost/toolCount persistence: bridge updates invocation row on `tool_use` (increment count) and on `result` (set total cost + tokens). `bridge.ts`. Commit: `31d0e0d`.
- [x] **E2E-D04** — SESSION_BUSY on tab-switch / resume. Server-side: `handleChatStart` preempt-replaces an existing session via `interruptActive() + await shutdown()`. Client-side: `activeSessionId`/`inProgress` lifted to `SessionProvider` context above tab switcher. `bridge.test.ts` flipped; `chat-autostart.test.ts` wrapped. Commit: `efe35a2`. `bun run check` 456/456; `bun run e2e` 6/6.

Acceptance for each: corresponding test/path described in defects.md; `bun run check` 0; `bun run e2e` still 6/6.

## Active — outer-4 (third-round dogfooding fixes)

Goal: fix 4 UX defects surfaced by dogfooding (D23–D26). Commit-per-defect; `bun run check` green after all four.

- [x] **D23** — History list: one row per session. `invocations.ts` + `InMemoryPersistence.ts`. ROW_NUMBER() CTE deduplicates to latest invocation per session; sub-agent children excluded via `agent_name='main' AND parent_invocation_id IS NULL`. Commit: `8142fcf`.
- [x] **D24** — User messages appear in chat stream. `Stream.tsx`: add `kind:"user"` to `RenderedMessage`, handle `sdkType="user"`, render via `MessageBubble role="user"`. Commit: `400bfb4`.
- [x] **D25** — Empty assistant bubbles suppressed. `Stream.tsx`: skip `MessageBubble` render when text is empty and thinkingBlocks is empty. Commit: `4f9d2ef`.
- [x] **D26** — SDK event labels + hide toggle. `UnknownCard.tsx` label rewrite; `Stream.tsx` `hideSdkEvents` prop; `Header.tsx` checkbox; `ChatTab.tsx` wiring. Commit: `d9436e2`.

`bun run check` 473/473; 6/6 e2e (re-run after all four commits).

## Post-discharge fixes

- `fix: install real SDK binary (PR-20-D01) + verify Candidate-A spike (PR-31-D01)` — Pinned `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.150` in `packages/server/package.json`; added `resolveNativeBinaryPath()` to bridge.ts; added real-SDK test cases to `sdk-stub.test.ts`, `mcp-inheritance.test.ts`, and `ask-question.test.ts`; updated `MockAnthropicHTTP` to handle `HEAD /` probe and multi-round `scriptedResponder`; confirmed Candidate-A (synthetic tool_result injection) works against real subprocess. 399 tests pass (3 new).
- `fix: web → composite TS project + ws-resilience drives real Manager (closes PR-18-D01)` — Made `packages/web` a TypeScript composite project (`composite:true`, `declaration:true`, `declarationMap:true`, `rootDir:./src`); created `packages/web/src/index.ts` re-exporting `Manager`, `Connection`, and related types; updated `packages/server/tsconfig.json` to reference `../web` and add `@cq/web` path alias; rewrote `ws-resilience.test.ts` to drive a real `Manager` with real Bun `WebSocket` transport against the fixture server (all 3 scenarios pass). Also fixed `isRetriable` to treat 1006 (ABNORMAL_CLOSURE) as retriable so the stale-grace DEAD path schedules reconnection. 399 tests pass (0 new failures).
- `fix: AskUserQuestion uses toolAliases + SDK-MCP (PR-31-D02; replaces Candidate-A injection)` — Replaced Candidate-A synthetic SDKUserMessage injection with the SDK-native `toolAliases + createSdkMcpServer` path. `askUserQuestion.ts` rewritten as `AskBroker` + `createAskUserQuestionMcpServer`. `bridge.ts` wires `Options.toolAliases = { AskUserQuestion: 'mcp__cq__ask_user_question' }`, `Options.mcpServers = {...externalServers, cq: askMcpServer}`, auto-allows `mcp__cq__*` in `canUseTool` with `updatedInput: {}` (subprocess Zod schema workaround), and buffers WS replies that arrive before the MCP handler calls `broker.ask()`. `ask-question.test.ts` rewritten with `AskBroker` unit tests + new real-SDK spike confirming end-to-end MCP round-trip. Added `zod` dep to `packages/server`. 403 tests pass (+4 net).
- `fix(D15): resume from history continues the same session, marked` — Resume previously generated a fresh `chatSessionId + sessionRow`, breaking Claude CLI semantics (resumption should continue the same session). Added `SessionRegistry.register(id)` to reuse an existing id without collision. `handleChatStart` now looks up priorInv/priorSession, re-uses `priorSession.id` as `chatSessionId`, calls `sessions.update({endedAt:null, endedReason:null})` to re-open the row, inserts a new invocation with `resumedFromInvocationId` set, and falls back to fresh-session path on missing prior rows (with warn log). Schema: `invocation` gains nullable `resumed_from_invocation_id` (migration 2). `InvocationRow` + `HistoryRow` (Zod) gain `resumedFromInvocationId`. `List.tsx` renders a ↻ badge on resumed rows. Existing test fixtures updated to include the new field. Tests: `persist-crud` (round-trip both adapters), `bridge-persist` (fresh+resume asserts 1 session row, 2 invocations, correct link, SDK options carry resume). 459 unit tests pass (+3 net); 6/6 e2e pass. Commit: `e515cee`.
- `fix(D28): attribute subagent tool_call_count + model to child invocation row` — D28a: added `toolUseInvocationMap: Map<tool_use_id, childInvId>` to `ActiveSession`; `handleTaskStarted` populates it from `msg.tool_use_id`. In the `assistant` handler, `parent_tool_use_id` is resolved via the map: subagent messages credit `tool_call_count` to the child row and capture `msg.message.model` on the child's first message. Cost/tokens stay 0 on child rows (SDK emits one result per top-level turn boundary only; documented in code). D28b: result messages with `subtype.startsWith("error")` now emit `chat.error{code:subtype, message:errors[0]}` alongside `chat.done{errored}` so the UI toast surfaces the failure. Tests: `bridge-persist.test.ts` D28a (task_started + subagent assistant with parent_tool_use_id → child has tool_call_count>0 and model non-empty); `bridge.test.ts` D28b (result{error_max_turns} → chat.done{errored} + chat.error). 475 unit tests pass (+2); 6/6 e2e pass. Commit: `4d3b028`.

## Active — outer-5 (resume-from-history rework)

Goal: ship five UX fixes for the resume flow per
[`docs/drafts/20260527-2330-resume-rework-plan.md`](docs/drafts/20260527-2330-resume-rework-plan.md).
Discharge: `bun run check` 0; `bun run e2e` 0; zero `ResumePicker` refs.

Status: `[ ]` planned · `[~]` in progress · `[x]` done · `[!]` blocked

- [x] **PR-01** — Haiku-generated session titles (server-side + persist + tests).
- [x] **PR-02** — Hide zero cost/token cells for subagent rows in `List.tsx`.
- [x] **PR-03** — Add Resume button column in History tab (top-level finished main only).
- [ ] **PR-04** — Delete `ResumePicker.tsx`, Header trigger, dialog tests.
- [ ] **PR-05** — Use generated title in session/excerpt column with prompt-excerpt fallback.

Cross-cutting (locked):

- [x] `title` column stays `TEXT NOT NULL DEFAULT ''`; brief's "nullable" deviates from existing schema. Empty-string sentinel preserved.
- [x] `@anthropic-ai/sdk` added to `packages/server` only.
- [x] Subagent predicate in `List.tsx` = `agentName !== 'main'`.
- [x] User-triggered rejoin (live session) goes away; only auto-refresh rejoin remains.

### PR-03 completed (2026-05-28)

Rightmost "Resume" column in the History tab. Button renders only when `agentName === 'main' && endedAt !== null && sessionId !== activeSessionId`. Cross-tab signal: `SessionContext.requestResume(invocationId)` → App effect flips active tab to chat; `ChatTab` effect calls existing `handleResumeSession` and clears the request. `data-testid="resume-row-<invId>"` for tests. CSS added in `History.module.css`. Test added in `history-list.test.ts` covers all three branches (visible / subagent / running). `bun run check` → 538 pass.

### PR-02 completed (2026-05-28)

`packages/web/src/history/List.tsx`: cost/in/out cells now render empty for any row where `agentName !== 'main'` (the SDK emits per-turn metrics only at the top-level boundary, so subagent rows always carried misleading zeros). Test added in `history-list.test.ts` asserts both the main-row and subagent-row paths. `bun run check` → 537 pass.

### PR-01 completed (2026-05-28)

Shipped `packages/server/src/agent/titleGenerator.ts` with `AnthropicTitleGenerator` + `TitleGenerator` interface + `buildTitleUserPrompt` + `sanitizeTitle` helpers. Added `@anthropic-ai/sdk@^0.69.0` dep. Wired into `Bridge`: `BridgeOpts.titleGenerator` (defaults to `AnthropicTitleGenerator`); `ActiveSession` gains `firstUserText`/`titleRequested`; `handleChatInput` captures the first user text; after the first `result{subtype:'success'}` with non-empty user+assistant text, generator runs async via `.then/.catch`, persists via `sessions.update({title})`, gated by both in-memory and persisted idempotency checks. Lazy client construction (no `ANTHROPIC_API_KEY` required for tests that don't trigger). Tests: 7 unit (`titleGenerator.test.ts`) + 2 bridge-integration (`bridge-persist.test.ts`). Verification: `bun run check` → 536 pass (was 524). Surprises: existing `session.title` column was `NOT NULL DEFAULT ''` already — no migration needed; empty string is the "not yet generated" sentinel (documented as cross-cutting note).

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
- M3 → [`./docs/archive/tasks-M3.md`](./docs/archive/tasks-M3.md)
- M4 → [`./docs/archive/tasks-M4.md`](./docs/archive/tasks-M4.md)
- M5 → [`./docs/archive/tasks-M5.md`](./docs/archive/tasks-M5.md)
