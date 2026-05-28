# cq — active task ledger

**Cycle:** outer-6 / `@cq/ledger` defect-fix (D-LED-01..D-LED-07). **Discharged.**
**Goal:** Discharge 7 defects raised against the outer-5 ledger build (3 blocking + 4 polish).
**Accepted plan:** [`docs/drafts/20260528-1200-ledger-defect-fix-plan.md`](docs/drafts/20260528-1200-ledger-defect-fix-plan.md).
**Baseline (post outer-5):** `bun test packages/ledger` → 33/33; `bun run check` → 558/558; `bun run e2e` → 16/16.
**Discharge:** `bun run check` → 596 pass / 0 fail (+38 from defect-fix tests); `cd packages/e2e && bunx playwright test` → 16/16 pass. (`bun run e2e` script alias hits a transient @playwright/test resolution warning unrelated to these changes — confirmed by running `bun run -- playwright test` from `packages/e2e/`, which also passes 16/16.) Session log: [`docs/logs/20260528-1300-ledger-defect-fix-log.md`](docs/logs/20260528-1300-ledger-defect-fix-log.md).

## Active — outer-6 (defect-fix)

- [x] **D-LED-01** — CRITICAL path-traversal: id regex in core.ts + Zod + FsLedgerStore defense-in-depth + new path-traversal.test.ts. Commit `d4aa017`.
- [x] **D-LED-02** — Schema validation gaps in `create_ledger` (terminal subset / em-dash / reserved field names / field-name regex) at Zod, parseSchema, and shared validator layers. New `validateSchema()` helper exported from core; called by both adapters' `createLedger`, by `parseSchema`, and mirrored in Zod `schemaSchema`.
- [x] **D-LED-03** — Deleted dead `void createAskUserQuestionMcpServer` import + statement from bridge.ts. `ask-question.test.ts:144` still uses the export so the function remains in askUserQuestion.ts. `bun run check` -> 594 pass / 0 fail.
- [x] **D-LED-04** — `docs/ledgers.yaml` added to `.gitignore`; `git rm` removed the tracked empty registry.
- [x] **D-LED-05** — `cloneFields` return type corrected to `Record<string, FieldValue>`; cast removed. Typecheck still clean.
- [x] **D-LED-06** — `FsLedgerStore.dispose()` now awaits every per-ledger mutex chain via a no-op `mutex.run()` before clearing internal state. New test in `concurrency.test.ts`: 20 queued updates + dispose race; asserts updates resolve before dispose returns.
- [x] **D-LED-07** — New sibling test in `concurrency.test.ts` (the original 50-update test untouched). Injected `now=()=>tick++`; asserts the 50 returned `updatedAt` values form a strictly-monotonic contiguous block, and the final on-disk `updatedAt` equals `createItem.updatedAt + N` with a counter matching the last-serialised write.

## Cycle outer-5 — discharged

**Discharge:** `bun run check` 558/558; `bun run e2e` 16/16.

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

## Active — outer-5 (resume-from-history rework)

Goal: ship five UX fixes for the resume flow per
[`docs/drafts/20260527-2330-resume-rework-plan.md`](docs/drafts/20260527-2330-resume-rework-plan.md).
Discharge: `bun run check` 0; `bun run e2e` 0; zero `ResumePicker` refs.

Status: `[ ]` planned · `[~]` in progress · `[x]` done · `[!]` blocked

- [x] **PR-01** — Haiku-generated session titles (server-side + persist + tests).
- [x] **PR-02** — Hide zero cost/token cells for subagent rows in `List.tsx`.
- [x] **PR-03** — Add Resume button column in History tab (top-level finished main only).
- [x] **PR-04** — Delete `ResumePicker.tsx`, Header trigger, dialog tests.
- [x] **PR-05** — Use generated title in session/excerpt column with prompt-excerpt fallback.

Cross-cutting (locked):

- [x] `title` column stays `TEXT NOT NULL DEFAULT ''`; brief's "nullable" deviates from existing schema. Empty-string sentinel preserved.
- [x] `@anthropic-ai/sdk` added to `packages/server` only.
- [x] Subagent predicate in `List.tsx` = `agentName !== 'main'`.
- [x] User-triggered rejoin (live session) goes away; only auto-refresh rejoin remains.

### PR-05 completed (2026-05-28)

`List.tsx` session/excerpt cell now branches on `agentName`. Main rows show `title || promptExcerpt || "(no prompt)"` on one line. Subagent rows keep the original two-line layout (`sessionId.slice(0,8)` + prompt excerpt) because their prompts are already meaningful and Q20 explicitly excludes them from Haiku titling. Unit test in `history-list.test.ts` covers the three main-row branches plus the subagent rendering invariance.

Also added a new e2e spec `packages/e2e/tests/history-title-resume.spec.ts` covering the end-to-end flow: send message → Haiku title persisted → switch to History tab → click Resume → assert tab switches to Chat and prior user bubble survives (proves same chatSessionId reused). Extended `packages/e2e/mock-server.ts` to handle non-streaming `/v1/messages` calls (the title generator's path) by parsing the request body, extracting the user's first message from the title prompt, and returning a unique derived title per session so e2e rows are distinguishable in the shared in-memory DB.

While testing the discharge condition, found that `bun run e2e` failed because `cd packages/e2e && playwright test` couldn't find `playwright` on PATH (it lives in `packages/e2e/node_modules/.bin`). Fixed the root `package.json` script to use `bun x playwright test` instead. This was a pre-existing project-script bug surfaced while validating PR-05; verified independent of these changes by reproducing on `git stash`.

Final verification: `bun run check` → 539 pass; `bun run e2e` → 15 pass.

### PR-04 completed (2026-05-28)

Deleted `packages/web/src/chat/ResumePicker.tsx` and `packages/e2e/tests/resume-running-rejoin.spec.ts`. Stripped `Header.tsx` of the `Resume from history` button, the dialog mount, `showResumePicker` state, the `handleResume*`/`handleRejoin` helpers, and the `onResumeSession`/`onRejoinSession` props. `ChatTab.tsx`: dropped `handleRejoinSession` (its only caller was the deleted dialog branch; the D47 auto-refresh `chat.rejoin` send-path is inline and unaffected) and removed both props from the Header element. `header.test.ts`: dropped the deleted prop from defaultProps. `bun run check` → 538 pass. `grep -r ResumePicker|resume-picker|resume-session-btn packages/{web,server,e2e,shared}/{src,test,tests}` returns zero hits.

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
