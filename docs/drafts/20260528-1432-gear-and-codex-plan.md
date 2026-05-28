# cq — gear-popup + Codex SDK programme plan

Date: 2026-05-28.
Branch: `worktree-agent-a15a5a95ca3542220` (reset to `main` 777231e).

## 0. Inputs and discrepancies vs the brief

The brief was authored against an envisioned state of `main`. After resetting this
worktree to `main` (which now contains the merged `@cq/ledger` work, the
resume-from-history rework, and the Haiku title generator), most file references
in the brief now resolve. Three reconciliations remain:

- **Brief-referenced Q&A doc**
  `./docs/drafts/20260528-1404-questions-gear-popup-and-codex.md` does not
  exist. The brief's "CONFIRMED DESIGN" section (Q1–Q14) is operationally
  complete and is treated as the authoritative source. Documented in
  `defects.md` as `D-GC-N0` (no fix needed, sourcing note only).

- **Reasoning-effort enum mapping for Codex**
  The brief said Codex tops out at `"high"` and that `max → "high"` (saturated).
  Inspecting `@openai/codex-sdk@0.134.0` shows the real `ModelReasoningEffort`
  union is `"minimal" | "low" | "medium" | "high" | "xhigh"`. Updated mapping:
  `max → "xhigh"`. This is strictly better than the brief specified.

- **Codex permission-mode UX**
  Brief said Codex CLI has an `auto | suggest | read-only` enum. Real SDK
  exposes two orthogonal knobs: `sandboxMode: "read-only" | "workspace-write" |
  "danger-full-access"` and `approvalPolicy: "never" | "on-request" |
  "on-failure" | "untrusted"`. We surface `sandboxMode` as the popup's
  "permission mode" when a Codex model is selected (3 values), matching the
  brief's intent of "show ONLY the Codex enum when Codex is selected". We do
  NOT expose `approvalPolicy` in v1 — it pivots on Codex CLI's interactive
  approval UX which is out of scope. Documented as `D-GC-N1` follow-up.

- **In-process MCP wiring for Codex (brief Q13)**
  Brief says "the same in-process `createSdkMcpServer({name:'cq', tools:[...]})`
  instance must be reachable from a Codex session". The Codex SDK does NOT
  accept in-process MCP servers via `ThreadOptions`. Codex's MCP integration is
  configuration-driven (`~/.codex/config.toml mcp_servers.*` or
  `CodexOptions.config.mcp_servers.*`), and the binary it launches reads them
  from there. The in-process `createSdkMcpServer` instance is a Claude-SDK
  construct that only the Claude bundled CLI consumes.

  **Decision**: ship the routing/persistence/UI without ledger-MCP or
  AskUserQuestion availability inside Codex sessions. Document the gap as
  `D-GC-1` (defer to a future "external cq-mcp binary" cycle). Codex sessions
  will get the Codex CLI's own built-in tool surface (file ops, bash, etc.) —
  the model just won't be able to call cq-internal tools. The brief's goal of
  "Platform=Codex visible in History, real Codex roundtrip works, no
  cross-platform resume" is unaffected.

## 1. Milestones

Two parallel feature tracks merged into one ordered milestone sequence,
sequenced so each PR ships independently green.

### M-GEAR — gear-icon popup (Change 1, 5 PRs)

- **gear-1**: Reasoning-effort domain type + Claude mapping table + protocol
  schema extension (`ChatStart.effort`). Pure type/Zod changes. No UI yet.
  Tests: `protocol.test.ts` round-trip; `effort.test.ts` mapping.
- **gear-2**: SQLite migration #6 — `session.effort` AND `session.platform`
  columns (bundled because they target the same table in the same cycle;
  see §G2b finding #1). Update both adapters; `SessionRow` type gains
  `effort` + `platform`; `HistoryRow` Zod gains both. Tests:
  `persist-crud.test.ts` round-trip both adapters. **This subsumes codex-2;
  drop codex-2 from the M-CODEX list.**
- **gear-3**: Gear-icon Header refactor. New `SettingsPopup.tsx` component
  hosting model + permissionMode + hideSdkEvents + effort. Header renders a
  gear button top-LEFT, popover anchored to it, outside-click/Esc close, no
  backdrop. Model + permission + hide-sdk-events inputs deleted from Header.
  `ChatTab` state stays put (model/permissionMode/hideSdkEvents/effort all
  per-session, sent in `ChatStart`). Defaults read from `localStorage` keys
  `cq.model`, `cq.permissionMode`, `cq.hideSdkEvents`, `cq.effort`.
  Tests: `settingsPopup.test.ts` (open/close/outside-click/Esc/localStorage);
  `header.test.ts` updated (no inline controls).
- **gear-4**: Effort persistence wiring on server (Bridge sets `session.effort`
  from `ChatStart.effort` at session start; passes Claude SDK
  `thinking.budget_tokens` per the mapping or leaves thinking off for `none`).
  Tests: `bridge-persist.test.ts` effort persisted; `bridge.test.ts` thinking
  options forwarded.
- **gear-5**: History "Effort" column inserted before the Session/Excerpt cell.
  Empty cell for subagent rows (rule mirrors Cost/Tokens). Tests:
  `history-list.test.ts`. (codex-8 will insert a "Platform" column right before
  Effort so the final column order is Cost/InTok/OutTok/Platform/Effort/Excerpt/Resume.)

### M-CODEX — Codex platform (Change 2, 8 PRs)

- **codex-1**: Shared `models.ts` registry + `modelToPlatform(modelId)`
  function + Platform enum + `Effort` enum (reused from gear-1). Allow-list of
  model ids keyed by platform. Tests: `models.test.ts` mapping and predicate.
- **codex-2**: *bundled into gear-2 (see §G2b finding #1).*
- **codex-3**: `ChatStart.platform` Zod field; server reads `ChatStart.platform`
  on start; persists; cross-platform resume refusal (`chat.error{code:
  'platform-mismatch'}`). Tests: `protocol.test.ts` round-trip; `bridge.test.ts`
  refusal path. **This is the platform-mismatch refusal acceptance test.**
- **codex-4**: New `BackendBridge` interface in
  `packages/server/src/agent/backendBridge.ts`. Rename current `Bridge` class
  to `ClaudeBridge`, move to `claudeBridge.ts`, implement the interface. The
  external file `bridge.ts` becomes a thin facade that holds the pool=1
  invariant and routes by `ChatStart.platform`. Public class name remains
  `Bridge` for back-compat with existing test fixtures and call sites
  (re-export); behavior identical.
  Tests: existing `bridge.test.ts` / `bridge-persist.test.ts` still pass
  unchanged; new `bridgeFacade.test.ts` for routing.
- **codex-5**: `@openai/codex-sdk@0.134.0` dep + `CodexBridge` skeleton
  (`codexBridge.ts`). Implement `BackendBridge`: takes `BridgeOpts` + a
  `codexFactory` for tests; maps `ChatStart` to `Codex.startThread` /
  `Codex.resumeThread`. Maps reasoning-effort to `modelReasoningEffort`. Maps
  popup permission-mode to `sandboxMode`. Persists session+invocation rows
  (`platform='codex'`). Emits `chat.error{code:'codex-not-authenticated'}` when
  no auth source detected. Does NOT wire MCP (deferred — D-GC-1). Tests:
  `codexBridge.test.ts` with hand-written dummy `Codex` implementing the SDK
  interface (per dual-tests/skill — manual dummy preferred).
- **codex-6**: Translate Codex `ThreadEvent` stream into cq's SDK message
  shape — emit `chat.event` frames carrying `sdkEvent: {type, ...}` that the
  client renderer can display (mostly `agent_message` → assistant text;
  `command_execution`/`file_change`/`mcp_tool_call` → tool cards;
  `turn.completed` → result-like; `turn.failed` → error). Resume support via
  `Codex.resumeThread(threadId)` — persist Codex's `thread_id` into
  `SessionRow.sdkSessionId`. Tests: `codexBridge.test.ts` event translation
  cases; persistence of thread_id.
- **codex-7**: Client model dropdown → platform routing via `modelToPlatform`.
  Popup's permission-mode dropdown switches its option set when the chosen
  model's platform is Codex (3 sandboxMode values) vs Claude (existing 5
  values). Client sends `ChatStart.platform` derived from `model`. Tests:
  `settingsPopup.test.ts` extended for platform-dependent options.
- **codex-8**: History "Platform" column + Resume button platform-aware
  visibility. Resume button hidden when row's platform != currently-selected
  model's platform. Tests: `history-list.test.ts` extended; cross-platform
  hidden case.

### M-E2E — End-to-end specs (3 specs)

- **e2e-1**: `gear-popup.spec.ts` — gear opens, change model/effort/perm/hide,
  outside-click closes, Esc closes, New Chat fires with chosen values (assert
  via persistence row read).
- **e2e-2**: `cross-platform-resume.spec.ts` — programmatic WS test:
  Claude session persisted; switch dropdown to Codex model; assert Resume
  button hidden; force-send `chat.start{platform:'codex', resumeFromInvocationId
  :<claude-inv>}` via the test's WS; assert server emits
  `chat.error{code:'platform-mismatch'}`.
- **e2e-3**: `codex-roundtrip.spec.ts` — wrapped in
  `test.skip(noCodexAuth, 'codex login / OPENAI_API_KEY absent')`. When
  present (sandbox has `~/.codex/auth.json` per check), starts a session with
  a Codex model, sends "say hello", asserts bubble appears + History row
  has `platform='codex'` and `effort` populated. 60s timeout.

## 2. Sequencing rationale

`gear-1` and `codex-1` are independent type/registry-only changes — both
can be the first PR. Subsequent PRs depend on those.

`codex-4` (Bridge facade) must precede `codex-5` (CodexBridge) so we have
the interface to implement. `codex-3` (protocol field + refusal) must
precede `codex-4` so the facade's routing has a field to route on.

`gear-3` (popup UI) is independent of any codex PR — but `codex-7` extends
the popup with platform-dependent permission-mode options, so gear-3 ships
first with only-Claude options, codex-7 extends it.

Order: gear-1 → codex-1 → gear-2 → codex-2 → codex-3 → codex-4 → codex-5 →
codex-6 → gear-3 → codex-7 → gear-4 → gear-5 → codex-8 → e2e-1 → e2e-2 → e2e-3.

## 3. Acceptance per PR

Every PR ends with: `bun run check` exits 0 with no NEW failing tests
beyond the pre-existing 18 fragile-environment failures (real subprocess /
Origin parsing / smoke). Each PR is one commit.

`bun run e2e` only re-runs at end of M-E2E. Existing 16 e2e specs stay
green; 3 new ones discovered (1 may skip cleanly).

## 4. Cross-cutting decisions (locked)

- **Effort enum strings**: `"none" | "low" | "medium" | "high" | "max"`. The
  string set is shared across both platforms; per-platform mapping happens at
  the bridge boundary.
- **Effort defaults**: `"none"` (preserves existing no-thinking behavior on
  Claude). Persisted as `'none'` for any pre-migration row.
- **Platform defaults**: `'claude'` (preserves existing rows). New columns
  default-fill to those values.
- **Resume button visibility**: `row.platform === currentPlatform &&
  row.endedAt !== null && row.agentName === 'main' && row.sessionId !==
  activeSessionId`. The `currentPlatform` comes from `modelToPlatform(model)`.
- **Server-side platform-mismatch**: triggered when `ChatStart.resumeFromInvocationId
  !== undefined && persistence.session(invID).platform !== ChatStart.platform`.
- **Codex MCP**: deferred (D-GC-1). Codex sessions get Codex CLI's built-in
  tools only.
- **Codex `ChatStart` fields not yet supported by CodexBridge**: `attachments`
  (Codex SDK has `local_image` UserInput but no file mime support); fall through
  with a one-shot warn log per-session.
- **Title generator**: continues to be Claude Haiku for both platforms. The
  Codex bridge calls the same `AnthropicTitleGenerator` after the first turn
  completes (uses the same `ActiveSession.firstUserText` + Codex's
  `finalResponse` as the assistant text).
- **`bridge.ts` facade class name**: `bridge.ts` exports a NEW facade class
  named `Bridge` (keeping the symbol stable for the wider codebase). The
  current Bridge implementation moves to `claudeBridge.ts` as
  `ClaudeBridge implements BackendBridge`. Existing `Bridge` test fixtures
  that test Claude-specific internals (`runLoop`, `handleTaskStarted`) move
  alongside as `claudeBridge.test.ts`. Tests that exercise the public
  contract (`handleChatStart`/`handleChatInput`) stay against `Bridge`.
- **localStorage keys**: `cq.model`, `cq.permissionMode`, `cq.effort`,
  `cq.hideSdkEvents`. Existing keys `cq.activeSessionId` preserved.
- **Header gear position**: top-LEFT, before the cwd display, per brief Q1.
- **Popup applies on next New Chat** — popup writes both localStorage *and*
  the local React state; ChatTab consumes the React state on next
  `chat.start` (mid-stream changes don't fire a re-start).
- **`ui_settings` table** (existing): KEPT. Server-side `settings.get/set`
  round-trip continues to work for model/permissionMode/hideSdkEvents (no
  scope creep). New popup state (model/permissionMode/hideSdkEvents/effort)
  is initialised from `localStorage` on first render (per the brief). The
  existing `settings.get_result` handler still fires and merges
  server-persisted values when present. localStorage is updated synchronously
  in the popup's onChange callbacks. (§G2b finding #2.)

## 5. Risk register

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Codex SDK auth detection wrong (false-positive "authenticated") | medium | Try-catch on `Codex.startThread` first frame; if error is auth-class, emit `codex-not-authenticated`; tested. |
| Existing `header.test.ts` heavily covers controls we move | high | Update test file: split into `Header.test.ts` (cwd + badges + buttons) and `settingsPopup.test.ts` (the moved controls). |
| Pre-existing 18 fragile-env failures count drifts | low | Re-baseline at each PR; flag any new failure as a regression. |
| Test `settingsPopup` needs `@happy-dom/global-registrator` not installed | medium | Existing web-test infrastructure must already work for other web tests; verify the existing `header.test.ts` runs and copy its setup. |
| Removing `ui_settings` + `settings.get/set` breaks existing tests | high | Coordinate the cut in gear-3 — remove server handler, ChatTab code path, related tests; ensure no other consumers. |
| Pool=1 across both backends contended | low | Single `active` field on facade; either ClaudeBridge or CodexBridge owns it at a time; facade refuses concurrent starts via existing preempt-replace. |

## 6. Test plan summary

Unit tests (estimated +35 cases):
- gear-1: protocol round-trip with `effort` (+3); effort mapping table (+5)
- gear-2: persistence round-trip (+2)
- gear-3: settingsPopup (+8); header update (+0 net, replace)
- gear-4: bridge effort persistence (+3); thinking options forwarded (+2)
- gear-5: history list effort cell (+2)
- codex-1: models registry + modelToPlatform (+4)
- codex-2: persistence platform (+2)
- codex-3: protocol platform field + bridge refusal (+3)
- codex-4: bridge facade routing (+3)
- codex-5: codexBridge auth + basic lifecycle (+5)
- codex-6: codexBridge event translation (+4)
- codex-7: settingsPopup platform-dependent options (+3)
- codex-8: history platform column + resume visibility (+3)

E2E tests (+3): gear-popup, cross-platform-resume, codex-roundtrip.

## 7. Out of scope

- Ledger MCP / AskUserQuestion availability inside Codex sessions (D-GC-1).
- Codex `approvalPolicy` UI control (D-GC-N1).
- Image attachments in Codex sessions.
- File-attachment translation for Codex.
- External cq-mcp binary.

## 8. Discharge condition

- All 16 PRs committed in order with `tag: gear-N` / `codex-N` / `e2e-N`.
- `bun run check`: ≤18 failures (no new regressions); test count grows by ~+35.
- `bun run e2e`: 16 prior pass; 2 new pass (gear-popup, cross-platform-resume);
  1 new skips cleanly when auth absent (codex-roundtrip).
- `defects.md` carries D-GC-1 (Codex MCP deferral) and D-GC-N1 (Codex approval
  policy deferral) as open follow-ups.
- Session log at `docs/logs/20260528-1432-gear-codex-log.md`.
