# cq — active task ledger

**Cycle:** outer-1 / inner M2 (M1 archived; PR-19 next).
**Goal:** build cq — TypeScript Web UI for the Claude Agent SDK on Bun + React + WebSocket per [`./prompt.md`](./prompt.md). Discharge condition: all five milestones `[x]` and archived; `bun test` clean; `bun run start --cwd <real-dir>` launches; sample prompt round-trips Chat tab + History tab drill-down.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _(3 open: `PR-18-D01` minor deferred to PR-51; `PR-20-D01` minor deferred; 1 resolved: `PR-19-D01` closed PR-20.)_

## Cross-cutting locks (non-negotiable, project-wide)

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any` outside justified library boundaries.
- Bun 1.3.13 (flake-pinned). React 19.2.6 fn+hooks only. `@anthropic-ai/claude-agent-sdk@0.3.150` (zod 4 peer).
- WebSocket-only application data. No HTTP endpoints for app data. No auth. No telemetry.
- One concurrent editor per ledger group; worktree-per-editor for parallel cycles; one ledger entry = one commit; sequential never-reused PR ids.
- Resilient-WS-UI Part-3 checklist coverage is complete (M1 closed; see archive).
- One open escalation: §11 **Q-1** (AskUserQuestion answer-injection) — *conditional, fires only if PR-31's spike disconfirms Candidate A*. Documented in plan with a recommended fallback.

## Milestones — stubs

- [x] **M0 — Bring-up** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)) — workspace, protocol, smoke server, logger, dev/HMR. *5 PRs.*
- [x] **M1 — WebSocket spine** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)) — full resilient-ws-ui Part-3 R2-R13 + V1-V10 + G2c F-04/F-10/F-17/F-18/F-19. *14 PRs.*
- [x] **M2 — Agent SDK integration (Chat MVP)** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)) — SDK bridge, Chat shell, markdown + Shiki, basic cards, interrupt, header, E2E acceptance. *PRs PR-19 … PR-26 (9, incl. PR-22a/b).*
- [ ] **M3 — Chat full fidelity** — permission overlays, elicitation, AskUserQuestion, plan mode, thinking blocks, slash autocomplete, attachments, file-ref anchors, more tool cards, TaskList sidebar. *PRs PR-27 … PR-38 (12).*
- [ ] **M4 — Persistence + History tab** — DDL, adapters, bridge writes, list/detail/timing/export/delete, resume-from-history. *PRs PR-39 … PR-47 (9).*
- [ ] **M5 — Polish & harden** — graceful shutdown, error toasts, a11y, E2E suite, README, type/lint clean, stop-condition verify. *PRs PR-48 … PR-54 (7).*

Total PR count: 56 (PR-01 … PR-54 + PR-09a + PR-22b; PR-22a replaces old PR-22).

## M2 — Agent SDK integration / Chat MVP (current milestone)

Goal: first end-to-end conversation. User types in browser, hits Cmd/Ctrl+Enter, sees streamed markdown assistant output with syntax-highlighted code blocks and basic tool cards for Read/Write/Edit/Bash; can interrupt; can pick a model. Close when PR-26 e2e (`chat-mvp.test.ts`) is green.

- [x] **PR-19** — Server SDK bridge skeleton + streaming-input mode + MCP-inheritance test (F-14). Tests: `bridge.test.ts` (6 cases, all pass), `mcp-inheritance.test.ts` (1 test, skipped → defect PR-19-D01; requires PR-20 MockAnthropicHTTP). `tsc + eslint` clean. 73 server tests pass, 216 total. Commit: see M2/PR-19 commit.
- [x] **PR-20** — `MockAnthropicHTTP` SSE stub + `sdk-stub.test.ts` (2 cases via fallback queryFactory fetching real SSE) + `mcp-inheritance.test.ts` un-skipped (PR-19-D01 closed via `loadMcpServers()` fallback in `agent/mcp.ts`). `tsc + eslint` clean. 65 server / 208 total passing; 0 skips; 3 pre-existing Bun-not-in-PATH failures unchanged. PR-20-D01 opened for deferred real-binary path. Deps: PR-19.
- [x] **PR-21** — Web `ChatTab` shell + `Input` component with cross-platform send chord + IME passthrough (F-16). Test: `input.test.ts` (6 named cases). `tsc + eslint` clean. 111 web / 214 total passing; 3 pre-existing Bun-not-in-PATH fails unchanged. Deps: PR-17, PR-02.
- [x] **PR-22a** — Web `Markdown` (react-markdown + remark-gfm + Shiki static, 12-lang allow-list per F-20, lazy load for others) + `CodeBlock` card (lang label + copy button, F-07). Tests: `markdown.test.ts`, `code-block.test.ts`. Deps: PR-21.
- [x] **PR-22b** — `Stream` renderer + token-level reflow via `SDKPartialAssistantMessage`; code-block stable-identity invariant (F-07). Test: `stream-reflow.test.ts`. Deps: PR-22a.
- [x] **PR-23** — Tool cards for Read / Write / Edit / Bash with hand-rolled line-diff. Test: `cards.test.ts`. Deps: PR-22a.
- [x] **PR-24** — Interrupt path: `chat.interrupt` → `Query.interrupt()`; stop button in Input; abort-token guards late events; `chat.done reason=interrupted`. Test: `interrupt.test.ts`. Deps: PR-19, PR-21.
- [x] **PR-25** — Web `Header` (cwd, model picker, permission-mode toggle, live tokens + cost, session id, started-at, duration, new-session w/ mid-stream confirm). 4 new tests; 250 total. (Orchestrator completed commit after executor returned without committing — fixed 1 eslint unused-import.)
- [x] **PR-26** — M2 e2e: full-stack boot with MockQuery-injected Bridge (real SDK unavailable per PR-20-D01). `chat.start` + `chat.input "list files"` → `chat.started` → `chat.event` (assistant + Bash tool_use + tool_result) → `chat.done reason=completed`. Runtime 193ms (<30s). Test: `e2e/chat-mvp.test.ts`. 251 total pass. Deps: PR-19..PR-25.

**Dispatch order (plan § 9).** Mostly serial. Possible parallel split: PR-19 server-side and PR-21 web-side after PR-17 lands (disjoint write scopes); PR-22a/22b/23 share `Markdown.tsx`/`Cards/` so serialise. PR-24 needs both PR-19 and PR-21.

## In-progress / recent

- **M2 close → orchestrator archives → M3 starts at PR-27**

## Recent completions (this cycle's worth)

- [x] **PR-26** — M2/PR-26: E2E chat-mvp acceptance test (closes M2). Boots production WsSession + Bridge stack in-process; injects MockQuery via `queryFactory` (canned script: init → assistant+Bash tool_use → assistant+tool_result → final assistant → end). WS client (Bun native) sends `chat.start` + `chat.input "list files"`; collects frames until `chat.done`. Asserts canonical sequence: `chat.started` → ≥1 assistant `chat.event` → Bash `tool_use` `chat.event` → `tool_result` `chat.event` → `chat.done{reason:'completed'}`. Ordering verified by index. Runtime 193ms. 251 total / 0 fail. `tsc + eslint` clean.
- [x] **PR-24** — M2/PR-24: interrupt path end-to-end. `bridge.ts`: `ActiveSession.aborting` flag set on `handleChatInterrupt`; loop checks flag on every iteration to discard late `chat.event` frames; `chat.done reason=interrupted` emitted (not 'completed') when aborting. `Input.tsx`: `onInterrupt` prop; Stop button rendered while `disabled && onInterrupt`. `Input.module.css`: `.stopButton` (red). `ChatTab.tsx`: tracks `activeSessionId` from `chat.started`/`chat.done`; passes `disabled={inProgress}` and `onInterrupt` to `<Input>`; `handleInterrupt` sends `chat.interrupt`. `interrupt.test.ts`: 2 cases (mid-stream interrupt at msg #3; immediate interrupt before events). 237 total / 235 pass (3 pre-existing Bun-not-in-PATH fails). `tsc + eslint` clean.
- [x] **PR-23** — M2/PR-23: tool cards for Read/Write/Edit/Bash + hand-rolled line-diff. `ReadCard.tsx`, `WriteCard.tsx`, `EditCard.tsx`, `BashCard.tsx` each accepts tool_use input + optional matching tool_result. `diffLine.ts` implements LCS-based line-diff. `Cards/index.ts` exports `ToolCard` switcher dispatching by name. `Cards.module.css` styles (card container, header, diff green/red rows). `Stream.tsx` extended: extracts tool_use + tool_result blocks from `SDKAssistantMessage.message.content`, pairs by `tool_use_id`, routes through `ToolCard`. `cards.test.ts`: 8 cases (4 component + 4 lineDiff). 130 web / 244 total; `tsc + eslint` clean.
- [x] **PR-22b** — M2/PR-22b: `Stream` renderer + token-level reflow. `Stream.tsx` accumulates `SDKPartialAssistantMessage` (type: `stream_event`) deltas per Anthropic `message.id`; on final `SDKAssistantMessage` replaces stitched text with canonical content. Each message renders through `<Markdown>` keyed by `messageId` — React positional reconciliation keeps `<CodeBlock>` fiber stable (approach B, F-07). `UnknownCard.tsx` placeholder for unrecognised SDK types. Bridge adds `includePartialMessages: true`. `stream-reflow.test.ts`: 3 cases (monotonic accumulation, final-replace, code-block stable identity). 122 web / 236 total; `tsc + eslint` clean.
- [x] **PR-22a** — M2/PR-22a: Web `Markdown` (GFM + Shiki static) + `CodeBlock` card. `Markdown.tsx` wraps react-markdown with remark-gfm; fenced code blocks route to `CodeBlock.tsx` using Shiki `getSingletonHighlighter` with 12 bundled langs + github-light/dark themes. Non-bundled languages lazy-load and re-render. CodeBlock header: language label + Copy button (1.5 s "Copied!" feedback). `markdown.test.ts` (4 cases: GFM table, fenced code, task list, footnote); `code-block.test.ts` (4 cases: label+copy, clipboard stub, lazy-load, bundled-sync). 119 web / 233 total; `tsc + eslint` clean.
- [x] **PR-21** — M2/PR-21: Web `ChatTab` shell + `Input` (uncontrolled textarea, cross-platform send chord, IME passthrough). `isSendChord()` exported; `isMacPlatform()` in `lib/platform.ts`. `ChatTab` builds `chat.input` frame, calls `manager.send()`. `input.test.ts` six F-16 cases pass. 111 web / 214 total; 3 pre-existing fails unchanged. `tsc + eslint` clean.
- [x] **PR-20** — M2/PR-20: `MockAnthropicHTTP` SSE stub; `sdk-stub.test.ts` (2 cases); `mcp-inheritance.test.ts` un-skipped (PR-19-D01 closed via `loadMcpServers()` fallback). `agent/mcp.ts` implements `loadMcpServers(home?)`; Bridge merges result into `Options.mcpServers`. PR-20-D01 opened. 65 server / 208 total passing; 0 skips. `tsc + eslint` clean.
- [x] **PR-19** — M2/PR-19: Server SDK bridge skeleton + streaming-input + MCP inheritance. `agent/bridge.ts` (single-Query pool, AsyncQueue streaming input, SDKMessage→chat.event mapping, SESSION_BUSY guard, chat.done). `agent/mcp.ts` (placeholder doc). Session routing in `ws/session.ts`. Bridge wired in `server.ts` + `devServer.ts`. Tests: `bridge.test.ts` (6/6 pass), `mcp-inheritance.test.ts` (skipped → PR-19-D01). 73 server / 216 total. `tsc + eslint` clean.
- [x] **M1 closed + archived** to `docs/archive/tasks-M1.md`. 14 PRs (PR-06 … PR-18 incl. PR-09a). 210 tests across 22 files. R2-R13 + V1-V10 full Part-3 coverage; G2c F-04/F-10/F-17/F-18/F-19 applied. One defect (`PR-18-D01`, minor, deferred to PR-51).
- [x] **M0 closed + archived** to `docs/archive/tasks-M0.md`. 5 PRs, 113 tests, 0 defects.

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
