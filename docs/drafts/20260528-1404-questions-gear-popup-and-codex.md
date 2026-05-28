# Clarifications: gear-icon settings popup + Codex SDK support

**Context:** Two changes were dispatched together: (1) replace the
inline Header controls (model, permission mode, hide-sdk-events) with a
single gear-icon button that opens a popup, adding a new "reasoning
effort" combobox; (2) add Codex CLI SDK as a second platform alongside
Claude, surface a Platform column on the History tab, and forbid
cross-platform resume. Both touch `Header.tsx`, `protocol.ts`, the
`session` row schema, and `bridge.ts`, so several design decisions
should be settled before code is written.

**How to answer:** Write your response on the `Answer:` line under each
question. Leave blank to skip. Reference questions by their ID in chat
if convenient.

---

# Part A — Gear-icon settings popup

## Q1: Where in the header does the gear icon live, and what's the popup form factor?

**Suggestions:**

- **Top-right of the Header, popover/menu anchored to the icon** (recommended) — matches the convention used by VS Code, GitHub. Closes on outside-click or Esc. No backdrop.
- **Top-right, full modal dialog with a backdrop** — heavier; better when controls are many.
- **Sliding side panel** — overkill for a handful of controls.

Answer: as recommended but top-left

---

## Q2: Per-session vs global / persistence of the gear values?

**Context:** Today, model + permissionMode + hideSdkEvents are
per-session settings sent in `ChatStart` and persisted on the session
row. The new "reasoning effort" field would follow the same path.

**Suggestions:**

- **Per-session, persisted on the session row, restored on resume**
  (recommended — matches what already happens for model/permissionMode).
  Defaults loaded from localStorage so a fresh tab remembers the last
  values.
- **Global only** — simpler; loses the "this session was started with
  X" history fidelity.
- **Per-session, no localStorage** — the user must re-pick every fresh
  session.

Answer: as recommended. Also, effort should be displayed in history tab

---

## Q3: Reasoning-effort value space?

**Context:** Claude exposes `thinking: { type: 'enabled', budget_tokens }`
via the SDK Options. OpenAI/Codex exposes `reasoning.effort:
'minimal'|'low'|'medium'|'high'`. To present "reasoning effort" as a
combobox we need a unified vocabulary.

**Suggestions:**

- **Four-level enum `none | low | medium | high`**, mapped per-platform
  (recommended): for Claude, `none → thinking disabled`; `low → 4k`;
  `medium → 16k`; `high → 32k` budget tokens. For Codex, pass through
  to `reasoning.effort` (drop `none` or map to `minimal`). Documented
  in code with the mapping table.
- **Pass raw enum from OpenAI** (`minimal/low/medium/high`) and adapt
  on the Claude side — couples our UI to OpenAI's naming.
- **Pass raw budget-token integer** — too low-level for a combobox.

Answer: can we do it the same way as in claude cli? with max/extra high?

---

## Q4: Which Header controls move into the gear popup, exactly?

**Context:** The Header currently holds: working directory, model
selector, permission-mode selector, hide-sdk-events checkbox, the
connection badge, and (post-merge) the History/Chat tab switch.

**Suggestions:**

- **Move only: model, permission mode, hide-sdk-events. Add: reasoning
  effort. Leave in header: directory display, connection badge, tab
  switch** (recommended).
- **Also move the platform selector (see Q9)** — convenient but the
  platform is currently session-defining; moving it hides a critical
  decision.
- **Move everything except the directory** — too disruptive.

Answer: I think that there should be no separate platform selector, the model selection combobox is enough - if user chosen codex it's obvious what platform to use

---

## Q5: Behavior when the popup is open during an active session?

**Suggestions:**

- **Changes apply to the next session start; current session keeps its
  values** (recommended — matches what model/permissionMode do today).
  A small "applies on next New Chat" hint in the popup.
- **Changes take effect immediately, mid-stream** — would require
  cancelling and restarting the SDK query; surprising.
- **Disable the popup while a session is in flight** — prevents
  confusion but is annoying.

Answer:  as recommended

---

# Part B — Codex CLI SDK support

## Q6: Confirm the Codex SDK package + version.

**Context:** `npm view @openai/codex-sdk@latest` → **0.134.0** (Apache
2.0, official OpenAI maintainer fleet, published 2 days ago). Depends
on the `@openai/codex` binary package (the CLI itself).

**Suggestions:**

- **`@openai/codex-sdk@0.134.0`** (recommended — latest stable).
  Add to `packages/server/package.json`.
- **Pin to a specific older version** — say which.

Answer: as recommended

---

## Q7: Codex auth + transport.

**Context:** Codex CLI authenticates via either an OpenAI API key
(`OPENAI_API_KEY`) or `codex login`. The SDK shells out to the same
`codex` binary the CLI uses.

**Suggestions:**

- **Require `OPENAI_API_KEY` env var** (recommended — symmetric with
  how cq treats `ANTHROPIC_API_KEY`); document in the README. No
  `codex login` flow inside cq.
- **Detect `~/.codex/auth.json` and prefer it; fall back to env** —
  more permissive but couples cq to the Codex login state machine.

Answer: codex login is authenticated in your sandbox, rely on that, fall back to env

---

## Q8: How does the user pick the platform for a new session?

**Suggestions:**

- **Dedicated platform selector in the Header (left of the New Chat
  button)**: a small toggle "Claude | Codex" that persists in
  localStorage and pre-selects the platform for the next New Chat
  (recommended). The current session's platform is read-only — shown
  in the badge area.
- **Inside the gear popup** — hides a high-impact decision.
- **Two separate "New Claude Chat" / "New Codex Chat" buttons** — clear
  but uses more horizontal space.

Answer: I said - user selects model from the model selector, codex models are obviously routed through codex

---

## Q9: Persist platform where?

**Suggestions:**

- **New `platform TEXT NOT NULL` column on `session` (migration #N)**,
  values `'claude'|'codex'`, default `'claude'` for backfill. Carried
  on `SessionRow`, `HistoryRow`, `ChatStart`, displayed in the new
  History "Platform" column. Resume validates the requested platform
  matches the stored one (Q10). (recommended)
- **Derive from `model` (claude-* vs gpt-*)** — fragile; ambiguous when
  models alias.

Answer: as recommended

---

## Q10: Cross-platform resume — refuse where?

**Context:** Request says it must not be possible to resume a Claude
session as Codex / vice versa.

**Suggestions:**

- **Refuse on the server in `handleChatStart` when the requested
  platform doesn't match the stored session's platform; respond with
  `chat.error{code:'platform-mismatch'}`** (recommended). The History
  resume button additionally sets the next-session platform to the
  row's platform before triggering the chat-start, so the normal flow
  never trips this guard.
- **Hide the resume button when the active selected platform doesn't
  match the row** — single layer; agent-initiated resumes could still
  slip through.
- **Both: client guards UX, server guards correctness** — safer.

Answer: both

---

## Q11: Bridge architecture — one Bridge or two?

**Context:** Today `Bridge` is hard-wired to `@anthropic-ai/claude-agent-sdk`.

**Suggestions:**

- **Abstract `BackendBridge` interface; two implementations
  `ClaudeBridge` (current code, renamed) and `CodexBridge` (new); a
  thin `Bridge` facade picks one per `chat.start` based on the platform
  field, delegating all session lifecycle** (recommended). The facade
  owns the active-session pool (still size 1) and the persistence write
  path so both backends produce uniform `invocation`/`session` rows.
- **Single `Bridge` with a strategy parameter** — less code splitting
  but harder to reason about as the SDKs' streaming + tool surfaces
  diverge.
- **Two top-level Bridges constructed side-by-side; the WS handler
  routes to one** — simpler but duplicates pool/persistence logic.

Answer:as recommended

---

## Q12: Codex permission mode + tool surface.

**Context:** Codex CLI has its own approval/sandbox model. The current
cq permission modes are `default | acceptEdits | plan | bypassPermissions | read-only`.

**Suggestions:**

- **Map to Codex's closest equivalents** (e.g. `bypassPermissions →
  auto`, `default → suggest`, `read-only → read-only`). Modes that
  don't map (`plan`) are disabled in the popup when platform=codex
  (recommended).
- **Show Codex-native enum in the popup when platform=codex; show
  Claude-native enum when claude** — most accurate but two enums to
  maintain.
- **Universal enum, runtime mapping with logged warnings when modes
  are forced** — opaque to the user.

Answer: show codex-native enum

---

## Q13: Ledger MCP tools for Codex.

**Context:** The `@cq/ledger` MCP server is wired into the Claude SDK
via `createSdkMcpServer`. Codex SDK has its own MCP integration via
`@openai/codex --mcp`.

**Suggestions:**

- **Wire the ledger MCP server to Codex too, exposing the same
  `mcp__cq__*` tool surface** (recommended) — symmetric agent
  experience.
- **Claude-only for v1; defer Codex MCP wiring** — smaller scope,
  defers a meaningful slice of the integration.

Answer:  as recommended

---

## Q14: Codex test/e2e scope.

**Suggestions:**

- **Mock Codex's HTTP layer the same way `MockAnthropicHTTP` mocks
  Anthropic; one new e2e that starts a Codex session, sends a turn,
  asserts the bubble + History row + platform column; plus unit tests
  on `CodexBridge` against the mock** (recommended).
- **Skip e2e for Codex; rely on unit tests** — drops the platform
  column from end-to-end coverage.
- **Hit the real Codex API in e2e** — flaky + costs money.

Answer: hit real codex api

---

## Q15: Dispatch strategy — one /vsm-loop or two parallel worktrees?

**Context:** Part A and Part B share `Header.tsx`, `protocol.ts`, the
`session` row schema, and `bridge.ts`. Parallel worktrees would
collide.

**Suggestions:**

- **One combined /vsm-loop in a single worktree, with Part B's
  platform field threaded into Part A's gear popup as it's built**
  (recommended) — single coherent migration of the Header and session
  model.
- **Sequential: Part A first (faster, no SDK risk), then Part B on
  top** — slower but lower risk.
- **Parallel worktrees** — collision-prone given shared surfaces.

Answer: one loop

---
