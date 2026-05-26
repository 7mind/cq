# M2 — Agent SDK integration / Chat MVP — archive

Closed: 2026-05-26.
Active span: 9 PRs (PR-19 … PR-26 incl. PR-22a/22b). All [x]. Two defects opened, one resolved.
Acceptance at close: `bun x tsc -b` 0; `bun x eslint .` 0; `bun test` → 251/251 pass across 33 files; M2 e2e `chat-mvp.test.ts` runtime 193 ms.

## PR-by-PR (one line each; commits + headline outcome)

- **PR-19** `6a4dbfc` — Server SDK bridge skeleton (`agent/bridge.ts`), single-Query pool, AsyncQueue streaming-input, SDKMessage → chat.event mapping, SESSION_BUSY guard, chat.done. WsSession routes `chat.start`/`chat.input`/`chat.interrupt` to bridge. `mcp-inheritance.test.ts` skipped → defect `PR-19-D01` (resolved by PR-20).
- **PR-20** `b380f7d` — `MockAnthropicHTTP` SSE stub on free port; `sdk-stub.test.ts` (2 cases via fallback queryFactory fetching SSE directly); `mcp-inheritance.test.ts` un-skipped + passing via `agent/mcp.ts` `loadMcpServers()` fallback. PR-19-D01 closed. Defect `PR-20-D01` opened: real Anthropic SDK binary is missing from `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`, so ANTHROPIC_BASE_URL inheritance to subprocess is deferred.
- **PR-21** `8458c86` — Web `ChatTab` + uncontrolled `Input` (textarea via ref, controlled would crash happy-dom React 19). `isSendChord(e)` + `isMacPlatform(nav?)` in `lib/platform.ts`. Six F-16 named cases pass: Ctrl+Enter linux, Cmd+Enter mac, vice-versa platform-gate, Shift+Enter newline, Esc blur, IME isComposing passthrough.
- **PR-22a** `16c1797` — `Markdown.tsx` wraps `react-markdown@10.1.0` + `remark-gfm@4.0.1`; fenced blocks route to `CodeBlock.tsx` with Shiki 3.23.0 (plan said `^4.x` but npm latest is 3.x — identical API). 12 bundled langs + github-light/dark themes; non-bundled langs lazy-load and re-render. Code-block header: lang label + Copy button (1.5 s "Copied!" feedback). 4 markdown + 4 code-block tests.
- **PR-22b** `b842e53` — `Stream.tsx` accumulates `SDKPartialAssistantMessage` deltas by `message_id`; on canonical `SDKAssistantMessage` replaces with full content. Each message renders through `<Markdown key={messageId}>` — React positional reconciliation keeps `<CodeBlock>` fiber stable (F-07 `isSameNode` invariant verified). Bridge sets `includePartialMessages: true`. `UnknownCard` placeholder for non-cardable SDK events.
- **PR-23** `f905d5c` — `ReadCard`/`WriteCard`/`EditCard`/`BashCard`. `diffLine.ts` is an LCS-based line diff (no library). `ToolCard` switcher dispatches by `toolUse.name`. Stream extracts tool_use + tool_result, pairs by `tool_use_id`. 8 tests (4 component + 4 lineDiff).
- **PR-24** `54a93ca` — Interrupt path: `ActiveSession.aborting` flag in bridge; loop checks flag every iteration to discard late chat.event; `chat.done reason='interrupted'`. Web Input gains `onInterrupt` prop → red Stop button when `disabled`. ChatTab tracks active session, wires Stop. 2 interrupt cases.
- **PR-25** `d80de68` — Web `Header` (cwd + model + permission-mode + live tokens/cost + session id + started-at + ticking duration + "New session" button + `NewSessionConfirm` modal). 4 cases. **Orchestrator-finished commit:** executor wrote files but returned without committing (tried exchange-script workflow instead of running `bun` directly); orchestrator fixed one ESLint unused-import, ran acceptance, committed.
- **PR-26** `b69c172` — M2 e2e `chat-mvp.test.ts`. Boots production WsSession + Bridge stack in-process; injects MockQuery via `queryFactory` (canned script: init → assistant+Bash tool_use → assistant+tool_result → final assistant → end). WS client sends `chat.start` + `chat.input "list files"`; collects frames until `chat.done`. Asserts ordering: `chat.started` → ≥1 assistant `chat.event` → Bash tool_use `chat.event` → tool_result `chat.event` → `chat.done{reason:'completed'}`. Runtime 193 ms.

## Defects

- `PR-18-D01` — open, minor, deferred to PR-51 (full Manager-against-real-server E2E).
- `PR-19-D01` — RESOLVED in PR-20 via `loadMcpServers()` fallback.
- `PR-20-D01` — open, minor: real `@anthropic-ai/claude-agent-sdk-linux-x64` binary missing; ANTHROPIC_BASE_URL inheritance path to subprocess deferred. Compensation: queryFactory injection + MockQuery used throughout M2 tests.

## Cross-cutting changes during M2

- `dangerouslySetInnerHTML` used for Shiki output; ESLint allowed via block-comment justification (the `react/no-danger` plugin is not installed).
- ChatTab tracks `activeSessionId` lifecycle from `chat.started` → `chat.done`.
- Bridge sets `includePartialMessages: true` so the stream renderer can reflow tokens.

## Acceptance dashboard (final M2)

```
$ bun --version
1.3.13
$ bun x tsc -b
$ bun x eslint .
$ bun test
[251 tests pass across 33 files; 0 fail; 5.77 s]
$ bun test packages/server/test/e2e/chat-mvp.test.ts
[1 test pass; 193 ms]
```

## What M2 hands off to M3

- A working Chat MVP: user types, hits Cmd/Ctrl+Enter, sees streamed markdown + code highlight + basic tool cards, can interrupt, can pick model, sees usage counters.
- The Bridge architecture (single-Query pool, AsyncQueue streaming-input, SDKMessage → chat.event mapping) is in place; M3 extends it for permission overlays (PR-28/29), elicitation (PR-30), AskUserQuestion (PR-31), plan mode (PR-32), thinking blocks (PR-33), slash commands (PR-34), attachments (PR-35), file-ref anchors (PR-36), Grep/Web cards (PR-37), TaskList sidebar (PR-38).
- Two known defects (`PR-18-D01`, `PR-20-D01`) carried forward.
- One conditional escalation (Q-1, AskUserQuestion answer-injection) still pending; PR-31 will spike Candidate A first.

M3 begins at PR-27 (Sub-agent nested cards + `agentProgressSummaries`).
