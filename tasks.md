# cq — active task ledger

**Cycle:** outer-1 / inner M3 (M2 archived; PR-27 next).
**Goal:** build cq — TypeScript Web UI for the Claude Agent SDK on Bun + React + WebSocket per [`./prompt.md`](./prompt.md). Discharge condition: all five milestones `[x]` and archived; `bun test` clean; `bun run start --cwd <real-dir>` launches; sample prompt round-trips Chat tab + History tab drill-down.
**Accepted plan:** [`docs/drafts/20260526-0037-cq-plan.md`](docs/drafts/20260526-0037-cq-plan.md) (2294 lines, G2c-patched).
**Defects:** [`./defects.md`](./defects.md). _(2 open: `PR-18-D01` minor deferred to PR-51; `PR-20-D01` minor deferred. 1 resolved: `PR-19-D01` closed in PR-20.)_

## Cross-cutting locks (non-negotiable, project-wide)

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. No `any` outside justified library boundaries.
- Bun 1.3.13 (flake-pinned). React 19.2.6 fn+hooks only. `@anthropic-ai/claude-agent-sdk@0.3.150` (zod 4 peer).
- WebSocket-only application data. No HTTP endpoints for app data. No auth. No telemetry.
- One concurrent editor per ledger group; worktree-per-editor for parallel cycles; one ledger entry = one commit; sequential never-reused PR ids.
- Resilient-WS-UI Part-3 checklist coverage is complete (M1 closed; see archive).
- One open escalation: §11 **Q-1** (AskUserQuestion answer-injection) — *conditional, fires only if PR-31's spike disconfirms Candidate A*. Documented in plan with a recommended fallback.

## Milestones — stubs

- [x] **M0 — Bring-up** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)) — 5 PRs.
- [x] **M1 — WebSocket spine** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)) — 14 PRs.
- [x] **M2 — Agent SDK / Chat MVP** (closed: 2026-05-26; archive: [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)) — 9 PRs.
- [ ] **M3 — Chat full fidelity** — permission overlays, elicitation, AskUserQuestion, plan mode, thinking blocks, slash autocomplete, attachments, file-ref anchors, more tool cards, TaskList sidebar. *PRs PR-27 … PR-38 (12).*
- [ ] **M4 — Persistence + History tab** — DDL, adapters, bridge writes, list/detail/timing/export/delete, resume-from-history. *PRs PR-39 … PR-47 (9).*
- [ ] **M5 — Polish & harden** — graceful shutdown, error toasts, a11y, E2E suite, README, type/lint clean, stop-condition verify. *PRs PR-48 … PR-54 (7).*

Total PR count: 56 (PR-01 … PR-54 + PR-09a + PR-22b; PR-22a replaces old PR-22). 28 of 56 closed.

## M3 — Chat full fidelity (current milestone)

Goal: every brief § 4 first-class affordance ticked — sub-agent nested cards, permission prompts, read-only overlay, MCP elicitation, AskUserQuestion, plan mode, thinking blocks, slash autocomplete, attachments, file-ref anchors, Grep/Web cards, TaskList sidebar.

- [x] **PR-27** — Sub-agent nested cards + `agentProgressSummaries`; bridge tracks invocation tree by `parent_tool_use_id`. Test: `subagent.test.ts`. Deps: PR-22b, PR-23.
- [x] **PR-28** — Permission prompts (`canUseTool` → `chat.permission_request` ↔ `chat.permission_reply`). Test: `permission.test.ts`. Deps: PR-19. Completed: `PermissionBroker` in `permission.ts`; bridge wired with `canUseTool`; `session.ts` routes `chat.permission_reply`; `PermissionPrompt.tsx` + CSS; 7 server tests + 4 web tests (255 total, 3 pre-existing PATH failures).
- [x] **PR-29** — Read-only mode overlay via `canUseTool` (F-03). Test: `read-only.test.ts`. Deps: PR-28.
- [x] **PR-30** — MCP elicitation roundtrip (form + URL modes) (F-01). Tests: `elicitation.test.ts`, `elicitation-card.test.ts`. Deps: PR-19, PR-23.
- [ ] **PR-31** — AskUserQuestion card with Candidate-A spike (F-02; Q-1 conditional escalation). Tests: `ask-question.test.ts` (web + server). Deps: PR-23, PR-28.
- [ ] **PR-32** — Plan mode + ExitPlanMode card. Test: `plan-mode.test.ts`. Deps: PR-28.
- [ ] **PR-33** — Thinking blocks (collapsed disclosure + token count). Test: `thinking.test.ts`. Deps: PR-22a.
- [ ] **PR-34** — Slash-command autocomplete (`/` opens popover; fuzzy match init.slash_commands; IME-safe). Test: `slash-autocomplete.test.ts`. Deps: PR-21, PR-25.
- [ ] **PR-35** — Attachments (clipboard image paste + drag-and-drop; 5 MB Zod refinement). Test: `attachments.test.ts`. Deps: PR-21.
- [ ] **PR-36** — File-reference rendering (path:line anchors; adds `chat.read_file_request/result` frames). Tests: `file-refs.test.ts`, `read-file.test.ts`. Deps: PR-22a.
- [ ] **PR-37** — Grep/Glob/WebFetch/WebSearch cards. Test: `grep-card.test.ts`. Deps: PR-23.
- [ ] **PR-38** — TaskCreate/TaskList/TaskUpdate sidebar pin. Test: see plan § 6. Deps: PR-23, PR-22a.

**Dispatch order.** Mostly serial. Some parallel opportunity: PR-32/33/37/38 are mostly disjoint card files and can split across worktrees once PR-28 / PR-22a / PR-23 are in place.

## In-progress / recent

- **PR-31** — AskUserQuestion card with Candidate-A spike (F-02; Q-1 conditional escalation). Tests: `ask-question.test.ts` (web + server). Deps: PR-23, PR-28.

## Recent completions (this cycle's worth)

- [x] **PR-30** — MCP elicitation roundtrip (`onElicitation` + ElicitationCard) (F-01). `ElicitationBroker` (`elicitation.ts`) parks Promises by elicitationId; uses SDK-provided `elicitationId` for URL-mode correlation. Bridge wires `onElicitation` callback; intercepts `SDKElicitationCompleteMessage` to resolve URL-mode elicitations via `completeUrl()`. `session.ts` routes `chat.elicitation_reply`. `ElicitationCard.tsx` supports form-mode (JSON-Schema → field mapper: string/number/boolean/enum → input/select/checkbox; fallback to textarea) and URL-mode ("Open in new tab" + "Waiting…"). CSS in `ElicitationCard.module.css`. 7 server tests + 6 web tests (274 total, 271 pass; 3 pre-existing PATH failures).

- [x] **PR-29** — Read-only mode overlay via `canUseTool` (F-03). `readOnlyOverlay.ts` (`applyReadOnlyOverlay`) wraps broker's `canUseTool`: deny-set tools (Edit/Write/NotebookEdit/MultiEdit/Bash/TodoWrite + description heuristic) return `{behavior:'deny'}` immediately in read-only mode with no WS frame emitted. SDK always gets `permissionMode:'default'`; UI label stored as `uiMode` in `ActiveSession`. `protocol.ts` adds `"read-only"` to `ChatStart.permissionMode` enum; `Header.tsx` adds it to the picker. 6 new tests (3 unit + 3 integration) → 269 total.

- [x] **PR-28** — Permission prompts (`canUseTool` → WS roundtrip). `PermissionBroker` (`permission.ts`) parks Promises by UUID, emits `chat.permission_request`, resolves on `chat.permission_reply`. Bridge wires `canUseTool` callback; `session.ts` routes replies. `PermissionPrompt.tsx` + CSS. 7 server tests + 4 web tests (255 total).

- [x] **PR-27** — Sub-agent nested cards + `agentProgressSummaries`. `SubagentCard.tsx` + `SubagentCard.module.css` created. `Stream.tsx` extended: `computeRenderedMessages` routes `task_started/task_progress/task_notification` and nested events by `parent_tool_use_id`. `subagent.test.ts` added. 252 tests (was 251).
- [x] **M2 closed + archived** to `docs/archive/tasks-M2.md`. 9 PRs (PR-19 … PR-26 incl. PR-22a/b). 251 tests across 33 files; M2 e2e (`chat-mvp.test.ts`) runtime 193 ms. Bridge + Chat shell + Markdown/Shiki + tool cards + interrupt + Header all in place. PR-20-D01 carries forward.
- [x] **M1 closed + archived** to `docs/archive/tasks-M1.md`. 14 PRs; 210 tests; R2-R13 + V1-V10 full Part-3 coverage. PR-18-D01 carries forward.
- [x] **M0 closed + archived** to `docs/archive/tasks-M0.md`. 5 PRs; 113 tests.

## Archive

- M0 → [`./docs/archive/tasks-M0.md`](./docs/archive/tasks-M0.md)
- M1 → [`./docs/archive/tasks-M1.md`](./docs/archive/tasks-M1.md)
- M2 → [`./docs/archive/tasks-M2.md`](./docs/archive/tasks-M2.md)
