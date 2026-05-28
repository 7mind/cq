# Resume-from-history rework — plan

**Brief source:** the user message dispatching this worktree; Q13–Q21 in
`docs/drafts/20260527-2330-questions-ledgers-and-resume.md` (lives in the main
checkout; copy reviewed at dispatch time).

**Working tree:** `/home/pavel/work/safe/cqe/cq1/.claude/worktrees/agent-a05f8b3bd960fc4f2`
on branch `worktree-agent-a05f8b3bd960fc4f2`, branched from `main` at 4e3d4fe.

---

## Reconciliation with current code state

The brief was written against a code state where the `title` column did not
yet exist. Reading the worktree (2026-05-27):

- `session.title` column **already exists** in migration `version: 1`
  (`packages/server/src/persist/migrations.ts:29`) as `TEXT NOT NULL DEFAULT ''`.
- `SessionRow.title: string` exists (`packages/shared/src/session.ts:19`).
- `HistoryRow.title: z.string()` exists (`packages/shared/src/protocol.ts:69`).
- `SessionStore.insert/update/list` already handle `title`
  (`packages/server/src/persist/sessions.ts`).
- `InMemoryPersistence` already round-trips `title`
  (`packages/server/src/persist/InMemoryPersistence.ts`).
- `List.tsx` already references `row.title` and falls back to
  `row.sessionId.slice(0, 8)` (line 265).
- Current head migration is **#5**, not #2 as the brief assumed.

**Schema-nullability deviation from brief:** brief says "nullable `title TEXT`".
Current schema is `NOT NULL DEFAULT ''`. Changing nullability now would require
a new migration that re-creates the table (SQLite cannot drop NOT NULL in
place), would force `SessionRow.title` to become `string | null`, and would
ripple through several call sites and tests. The empty-string sentinel
already means "not yet generated" everywhere. **Decision: keep `string` with
empty-string sentinel for "untitled"; do NOT add a migration; do NOT change
nullability.** Recorded as cross-cutting note.

So no new migration; no schema work; no protocol-shape change.

---

## Scope (5 fixes, one PR per fix)

Status: `[ ]` planned · `[~]` in progress · `[x]` done · `[!]` blocked

### PR-01 — Haiku-generated session titles

**Goal.** After the first `result` message of a fresh main session lands,
asynchronously generate a 4-8 word title via Anthropic's Haiku model and
store it on the session row.

**Touchpoints.**
- `packages/server/package.json` — add `@anthropic-ai/sdk` dep.
- `packages/server/src/agent/titleGenerator.ts` (new) — service that owns
  the Anthropic client + the prompt + idempotent persist.
- `packages/server/src/agent/bridge.ts` — instantiate + wire; call once
  after the first persisted `result` for a fresh main session.
- `packages/server/test/titleGenerator.test.ts` (new) — unit tests with
  injected fake client.
- `packages/server/test/bridge-persist.test.ts` (extend) — assert generator
  is called once on first result, not on second.

**Design notes.**
- One `Anthropic` client constructed at Bridge construction; injected via
  `BridgeOpts.titleGenerator?: TitleGenerator` for tests.
- `TitleGenerator` interface: `generate(opts: { sessionId, firstUserMessage, firstAssistantText }): Promise<string>`.
- Real implementation: `AnthropicTitleGenerator` calls
  `messages.create({ model: "claude-haiku-4-5", max_tokens: 50, ... })`.
- Idempotency: bridge checks current `session.title === ""` before invoking;
  on success, persists via `persistence.sessions.update(sessionId, { title })`
  and sends `chat.usage`-style update via existing `sendHistoryUpdate`-on-session
  path (or a new `history.update`-on-session if missing — likely the session is
  not addressed in HistoryUpdate today; List rebuild via re-list on session
  end is acceptable. Investigate at execution time).
- Trigger: at the `if ((msg as ...).type === "result")` block, *after* the
  patch is applied and before `sendDone`. Wrap with try/catch; non-blocking;
  log on failure.
- Subagent rows: never call (only triggered on the **session**'s first result,
  which is by definition the main top-level row).
- Network: real API uses `ANTHROPIC_API_KEY` env (SDK handles automatically);
  document in CLAUDE-relevant places (`prompt.md` already touches env; do not
  rewrite).

### PR-02 — Hide zero-cost / zero-token cells for subagents

**Goal.** In `List.tsx`, render an **empty cell** (not `0`, not `—`) for
`costUsd`, `inputTokens`, `outputTokens` on subagent rows. Main rows
unchanged.

**Touchpoints.**
- `packages/web/src/history/List.tsx` — guard the three cells on
  `row.agentName === 'main' && row.parentInvocationId == null` … but
  `HistoryRow` Zod (line 55–73) does NOT carry `parentInvocationId`; that
  field is on `HistoryRowFull`. **Define subagent purely by
  `row.agentName !== 'main'`** for the List view. Brief Q19 reading:
  "subagent rows (those rows are identified by `agent_name !== 'main' ||
  parent_invocation_id != null`)". Since the resume column also uses
  the same predicate and we don't have `parentInvocationId` in HistoryRow,
  using `agentName !== 'main'` is sufficient and matches D23's row
  filter convention.
- Unit test: extend the list-rendering test (or add a new one) to assert
  the cell renders empty for subagent rows.

### PR-03 — Resume button column on the History tab

**Goal.** Add a rightmost "Resume" column. Render a `<button>` when the
row is a **finished top-level main session**:
`row.agentName === 'main' && row.endedAt !== null && row.sessionId !== activeSessionId`.
Empty cell otherwise. Clicking the button triggers the same flow
`Header.onResumeSession` did: a `chat.start` with `resumeFromInvocationId`
set to the row's `invocationId`.

**Touchpoints.**
- `packages/web/src/history/List.tsx` — new column + button.
- `packages/web/src/history/HistoryTab.tsx` — accept `activeSessionId` prop
  and `onResumeSession(invocationId)` callback; pass to `List`.
- `packages/web/src/AppShell.tsx` (or wherever HistoryTab is mounted) —
  wire `activeSessionId` from `SessionProvider` context and `onResumeSession`
  from a callable lifted high enough that both ChatTab and HistoryTab can
  fire `chat.start`. Investigate at execution time; likely the same
  `handleResumeSession` body needs to be lifted into a context provider
  or move into a shared hook.

**Risk.** Cross-tab dispatch of `chat.start` will also need a tab switch
to the Chat tab after click. Acceptance: clicking the resume button (a)
sends `chat.start` with `resumeFromInvocationId` AND (b) switches the
active tab to Chat, so the user sees the resumed session.

**Tests.**
- Unit test for `List.tsx` — button visible / hidden in the three states.
- E2E spec: start a fresh session, send a message, wait for completion,
  go to History tab, click resume, assert chat tab is active and the
  resumed session shows the prior bubble (i.e. `chatSessionId` preserved).

### PR-04 — Delete ResumePicker + Header trigger

**Goal.** Remove the dialog, the Header button, the rejoin code paths
that exist only because of the dialog. Tests too. No back-compat shims.

**Touchpoints.**
- `packages/web/src/chat/ResumePicker.tsx` — delete.
- `packages/web/src/chat/Header.tsx` — remove import, button, state
  (`showResumePicker`, `handleResumeClick`, `handleResumeSelect`,
  `handleRejoin`, `handleResumeCancel`), `onRejoinSession` prop,
  `onResumeSession` prop (PR-03 moves the call site to HistoryTab).
  Update doc-comment block.
- `packages/web/src/chat/ChatTab.tsx` — drop `onResumeSession` /
  `onRejoinSession` props passed to Header. `handleResumeSession` and
  `handleRejoinSession` themselves stay (PR-03 wires resume to History
  tab; rejoin stays for the auto-refresh path).
- `packages/e2e/tests/resume-running-rejoin.spec.ts` — delete. The
  rejoin-via-dialog scenario no longer exists in the UI; per Q17 the
  Resume button is only for finished sessions, and rejoin-of-live-session
  is no longer a user-facing action. The auto-refresh resume path is
  covered by `refresh-resume.spec.ts` which uses no dialog.

**Verification.** `grep -r ResumePicker` returns zero hits. `grep -r
resume-session-btn` returns zero hits. `grep -r resume-picker` returns
zero hits.

### PR-05 — Title in session/excerpt column with prompt-excerpt fallback

**Goal.** `List.tsx` session/excerpt cell should show:
1. `row.title` if non-empty (Haiku-generated), else
2. `row.promptExcerpt` (first ~60 chars; already truncated by server-side
   logic), else
3. `(no prompt)`.

Today it shows `row.title || row.sessionId.slice(0,8)` — replace with
the above logic. Subagent rows keep their existing prompt-excerpt
rendering (no change for them).

**Touchpoints.**
- `packages/web/src/history/List.tsx` — change the Session/Excerpt cell
  rendering. The current `<div>` showing title-or-sessionId becomes
  title-or-promptExcerpt-or-"(no prompt)"; the existing excerpt sub-div
  remains for subagents but is suppressed for main rows when the title
  is shown (no duplication).
- Unit test: assert each of the three branches renders.

---

## Cross-cutting architectural notes (locked)

- [x] **`title` column remains `TEXT NOT NULL DEFAULT ''`.** Empty string =
  "not yet generated". Avoid a no-op nullability migration. Documented
  above.
- [x] **`@anthropic-ai/sdk` is a server-only dep.** Web/shared do not see it.
- [x] **Subagent predicate in `List.tsx` = `agentName !== 'main'`.** The
  `HistoryRow` Zod row does not carry `parentInvocationId`; the full row
  does. The list view does not need the full row. Brief Q17 allows the
  loose predicate.
- [x] **Resume column entry point.** `List.tsx` receives
  `activeSessionId: string | null` and `onResumeSession(invocationId)` props
  from `HistoryTab`, which sources them from a higher-level context.
- [x] **Rejoin via user click goes away.** Auto-refresh rejoin (`chat.rejoin`)
  remains for the connection-resume path.
- [x] **Test runtime.** E2E uses `MockAnthropicHTTP`. Title-generator E2E
  uses the mock unless real-API is opt-in; default = mock.

## Open questions deferred to execution

- [ ] **Where does `handleResumeSession` live so HistoryTab can call it?**
  Investigate `AppShell.tsx` / `SessionProvider`. If a callback hoist is
  ugly, expose via context.
- [ ] **Does `history.update` (HistoryUpdate frame) carry session-level
  fields like `title`?** Likely no (the frame addresses an `invocationId`).
  Either (a) add a `session.update`-style frame to push the title to live
  clients, or (b) accept that the title only appears after the next
  `history.list` re-fetch (e.g. tab switch). Pick (b) for v1 — the
  HistoryTab refetches on tab focus/connection events already.

---

## Acceptance per PR

- `bun run check` exits 0 (tsc + eslint + bun test all green).
- After PR-03 and PR-05: `bun run e2e` exits 0 including the new spec.
- After PR-04: `grep -r ResumePicker packages` returns nothing.

## Order

Dependency graph: PR-01 produces title; PR-05 displays it (so PR-01 first,
PR-05 last). PR-02 is independent. PR-03 must precede PR-04 (PR-04 deletes
the only existing resume entry point; without PR-03's replacement the UI
would have no way to resume).

Order: **PR-01 → PR-02 → PR-03 → PR-04 → PR-05**.

Each PR ends with: `bun run check` green, commit, move on.
A combined `bun run e2e` run at the end of PR-05.
