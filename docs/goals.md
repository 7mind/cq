---
ledger: goals
counters:
  milestone: 0
  item: 20
archives:
  - id: M15
    path: ./archive/goals/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M20
    path: ./archive/goals/M20.md
    summary: G4 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G4 (D2 backup-and-reinit on schema divergence) done; work milestone M22 archived; decision K15; reviews R75/R76. D2 resolved.
    title: "Plan: fix D2 — graceful backup-and-reinit on ledger schema divergence"
    status: done
  - id: M23
    path: ./archive/goals/M23.md
    summary: G5 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G5 (@cq/ledger packaging + UI-eligibility defects D3-D6) done; work milestones M24/M25/M26 archived; decision K16; reviews R77/R78. D3-D6 resolved.
    title: "Plan: @cq/ledger packaging + UI-eligibility defect cleanup (D3-D6)"
    status: done
  - id: M1
    path: ./archive/goals/M1.md
    summary: G1 coordination — COMPLETE. Goal G1 (build the /implement:* command family) done; work milestones M3/M6/M7/M8/M9 archived; clarifying questions answered, reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: /implement:* command family"
    status: done
  - id: M10
    path: ./archive/goals/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/goals/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M29
    path: ./archive/goals/M29.md
    summary: G7 coordination — COMPLETE. Goal G7 (fix confirmed dogfood UI/store defects D14-D19) done; work milestone M30 archived; defects D14-D19 resolved; reviews + approval decision (K19) terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M35
    path: ./archive/goals/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
---

# goals

## M37

### G10 — planned

- createdAt: 2026-06-03T10:25:42.386Z
- updatedAt: 2026-06-03T10:47:40.416Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- title: Fix D13 (TUI nav perf via memo boundaries) + D23 (multi-step-form test flake)
- description: |
    DEFECT-SEEDED goal (linked defects:D13, D23) — both root causes CONFIRMED by the /advance investigate round (2026-06-03; hypothesis tree H9-H13 + runtime/git evidence), so this goal enters `planning` directly and SKIPS clarifying (K8 pt4 / K12). plan-advance should produce reviewed FIX TASKS directly. Both fix units are FILE-DISJOINT (ledger-tui src vs test) → parallel-safe.
    
    === FIX UNIT A — D13 (medium): TUI ~500ms per cursor move ===
    CONFIRMED ROOT CAUSE (H9+H10; H11/H12 refuted by measurement): the residual per-cursor-move latency is a FIXED, N-INDEPENDENT cost, NOT the O(N) work T85 already removed. Every cursor move calls patchTop({cursor})→setStack (app.tsx:398-404, 830-832) re-rendering the ENTIRE App; there is NO React.memo boundary anywhere in app.tsx, so ScrollList/ContentPane/Markdown all re-execute each keystroke (H9). T85's itemsDerived useMemo (app.tsx:743-760) memoized only the O(N) LIST builders — no memo boundary, never covered the detail pane. ContentPane (app.tsx:1325) re-parses the selected item's markdown unconditionally each render via Markdown→parseBlocks (markdownText.tsx:142-146, no useMemo, not React.memo) and rebuilds field order + estimateLines (app.tsx:1369-1408) (H10). Runtime measurement (debug/20260603-101700-d13-navperf.tsx, ink-testing-library): per-move latency FLAT in N (54.7ms@N=25 / 57.8ms@N=100 / 54.7ms@N=400); the selected item's markdown re-parse DOUBLES per-move cost (empty-desc 28.6ms vs long-md 55.4ms @ N=400). Residual O(N) sites (H11) = 32µs@N=400 — negligible; ink stdout throttle-capped 34ms (H12) — not dominant.
    SUGGESTED FIX: (1) HIGHEST LEVERAGE — wrap Markdown in React.memo + memoize the parse useMemo(()=>parseBlocks(text),[text]) (markdownText.tsx:142-143); removes the ~50% markdown amplifier. (2) wrap ContentPane and ScrollList in React.memo with referentially-stable props; hoist viewItems=allRows.map(...) (app.tsx:1009) into the itemsDerived useMemo for a stable array ref. (3) optionally memoize the relationship resolvers (app.tsx:1389-1390) keyed on (cur.item.id, viewItems) — low impact. REGRESSION GUARD: a navMemo-style test exercising the DEFECTS/HYPOTHESIS ledger with LONG MARKDOWN fields, instrumenting parseBlocks/render counts, asserting a pure cursor move does not re-parse unchanged markdown / does not re-run a memoized ContentPane. (The existing navMemo test used a TASKS ledger with short fields — why it missed this.) Scope: packages/ledger-tui/src/{app.tsx,markdownText.tsx} + test. DISJOINT from D23.
    
    === FIX UNIT B — D23 (medium): multi-step-form test flakes ===
    CONFIRMED ROOT CAUSE (H13): advance() helper (packages/ledger-tui/test/app.test.tsx:201-209) uses a fixed ms=1500 wall-clock deadline as its ONLY settle budget; under CPU contention a slow render misses it and advance() throws. The 'creates an item via the multi-step form' test (app.test.tsx:450-467) chains FOUR advance() calls with no explicit per-test timeout (bun 5000ms default). Verified byte-identical base→HEAD: T130 (bfa70ed) fixed other sites with poll-until-condition but touched neither advance() nor this test. Residual of the D20 timing-budget class.
    SUGGESTED FIX: fold the file's existing poll-until-condition idiom into advance() — keep its h.frame() polling, replace the tight ms=1500 deadline with a generous budget (~2000-5000ms, cf. waitForFrame), AND give the multi-step-form test an explicit generous per-test timeout mirroring the scroll test's 20_000ms (app.test.tsx:578). Scope: packages/ledger-tui/test/app.test.tsx only. DISJOINT from D13.
    
    Repo gate: bun run check (deterministic under concurrent full-suite load). No new ledgers. NOTE: marking D13/D23 resolved uses status `resolved` (valid on the current defect schema).
- grounding: "Both root causes confirmed this session by the /advance investigate round. D13: hypothesis nodes H9 (confirmed — full unmemoized re-render), H10 (confirmed — markdown re-parse), H11 (wrong — O(N) negligible, 32µs@N=400), H12 (wrong — ink draw throttle-capped). Runtime evidence: debug/20260603-101700-d13-navperf.tsx (ink-testing-library micro-bench + end-to-end per-move timing). Static citations validated against source: app.tsx:398-404/743-760/830-832/1009/1325/1369-1408/1389-1390, markdownText.tsx:142-146/75-140/23-64, relationships.ts:69/108-142. NO React.memo anywhere in app.tsx (full-file read). D23: hypothesis H13 (confirmed). advance() at app.test.tsx:201-209 (fixed ms=1500); multi-step test at :450-467 (4x advance, no per-test timeout); poll-until helpers waitFor/waitForFrame at :173-190; scroll-test 20_000ms precedent at :554-578. Byte-identical base→HEAD verified via git (bfa70ed^ vs HEAD diff of advance() = IDENTICAL; T130 diff grep count 0 for advance()/multi-step). Tests: bun:test + ink-testing-library (TUI). Gate bun run check."
- tags: ["defect-seeded","defect:D13","defect:D23","buildable-cleanup"]
- milestones: ["M38"]

## M40

### G11 — planned

- createdAt: 2026-06-03T11:35:03.037Z
- updatedAt: 2026-06-03T15:48:55.329Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- title: "Agent-ergonomic ledger MCP: state-overview endpoint + better tool/field descriptions"
- description: |
    GREENFIELD tooling improvement to the ledger MCP server (@cq/ledger-mcp + @cq/ledger). USER REQUEST (verbatim): "the beginning of [the /advance] session looked suboptimal" — deriving ledger state at the start of a run took many ledger calls — "probably we should add some descriptions somewhere and/or add some endpoints more convenient for the agents."
    
    CONCRETE EVIDENCE from this session's /advance bootstrap (the pain to fix):
    1. Deriving the three /advance detection predicates (P-investigate = actionable defects; P-plan = movable-phase goals; P-implement = DAG-ready tasks; + open-questions gate) took ~13 read-only ledger calls before the orchestrator had "a complete, authoritative picture of ledger state."
    2. fetch_ledger returns the ENTIRE ledger including long description/rootCause/grounding fields — the goals ledger came back 51.8KB and the questions ledger 142.7KB, BOTH overflowing the tool-output token limit and forcing a fallback to fts_search. There is no compact/headline-only/summary projection.
    3. The fts_search status-filter syntax was non-obvious: the inline form `(status:open OR status:wip)` returned empty and had to be cross-checked against the dedicated `status:` parameter and a known-populated sanity value before the agent trusted it. The query language (qualifiers, the status param vs inline filter, terminal-vs-active semantics) is under-documented at the point of use.
    4. There is NO single "ledger state overview / actionable-work snapshot" endpoint: each predicate needs its own cross-ledger query, and there is no one call that answers "what is actionable right now" (open/non-terminal items grouped by ledger + phase, open questions, ready tasks).
    5. ARCHIVE FOOTGUN (surfaced this session): a defect (D22) the user accidentally set `resolved` was swept into the archive by the auto-archive sweep, and there is NO un-archive / reopen-terminal operation (terminal statuses have no outgoing transition; archive_milestone has no inverse). Recovery required re-filing the item under a new id (D24).
    
    CANDIDATE DIRECTIONS (for clarifying/planning to refine + the planner to scope — NOT locked here):
    - a compact agent-oriented STATE-OVERVIEW / snapshot endpoint (e.g. counts + ids grouped by ledger×status, or an /advance-predicate-shaped summary) returning the actionable set in ONE call;
    - a summary/projection mode for fetch_ledger (headline+status+id only, omit long fields) and/or pagination, so it never overflows token limits;
    - improved TOOL and FIELD DESCRIPTIONS — especially the fts query language (status filter param vs inline, active-vs-archived, terminal semantics), surfaced where the agent reads them (the server `instructions` and per-tool descriptions);
    - possibly an un-archive / reopen-terminal capability (or a guard so the auto-archive sweep cannot act on a just-changed/erroneous terminal status);
    - consider whether the convenience belongs in the MCP server (new tools) vs. the flow prompts (better-documented query recipes) vs. both.
    
    Scope: @cq/ledger-mcp (tool surface + server instructions) and/or @cq/ledger (store query helpers); the frontends are pure MCP clients (any new read tool must be exposed over MCP). Repo gate: bun run check. NOTE: this is the IMPROVEMENT goal only; the restored test-quality defect D24 (ex-D22) is tracked separately under M39 and is NOT part of this goal.
    
    ## Follow-up (2026-06-03) — three added features
    USER REQUEST (verbatim): "we need another feature: accidental click protection in web ui. all the transition buttons (state transitions plus pick answer/as recommended/save answer) should be protected. My idea: click and hold for 1s with a progress bar. also we need to create a new ledger - we could call it "handoffs" - every time the orchestrator stops, it should record reason there with explanation. all states are terminal:ledgers- drained|illness-detected|answers-required, maybe smth else ; also: we should extend ledger schemas with a field linking item to its session log/logs (everywhere where it makes sense)"
    
    Three distinct GREENFIELD features folded into G11:
    F1) ACCIDENTAL-CLICK PROTECTION (web UI): every state-mutating action button — the state-transition buttons AND the answer-affecting buttons (per-suggestion 'pick', 'as recommended', 'save answer'/'save & mark answered') — gated behind a CLICK-AND-HOLD interaction (~1s) with a visible PROGRESS BAR, so a stray click cannot mutate state; the action fires only on a completed hold. Scope: @cq/ledger-web (button affordance + hold/progress UX, happy-dom-testable). CLARIFY: exact hold duration; whether destructive-only vs ALL action buttons; cancel-on-release; keyboard-accessibility/non-mouse path; whether the TUI needs a parallel confirm affordance or web-only.
    F2) NEW 'handoffs' LEDGER: a new CANONICAL ledger recording, every time an orchestrator flow STOPS, the stop reason + an explanation. Proposed ALL-TERMINAL status set: drained | illness-detected | answers-required (+ possibly more — the user said 'maybe smth else'). CLARIFY: the full status enum; the item shape (status=reason + explanation/context + refs to the goals/defects/questions that caused the stop + maybe the session); WHICH flows write it and at WHICH stop points (/advance DRAINED/BLOCKED-ON-QUESTIONS/MIXED report maps naturally to drained/answers-required/…; implement/plan/investigate stops too); whether it is purely append-only history; relation to the /advance end-of-run report categories. NOTE CLAUDE.md says 'don't create_ledger unless asked' — here the USER explicitly asked, so a new CANONICAL_LEDGERS entry is in scope.
    F3) SESSION-LOG LINK FIELD: extend ledger item schemas with a field linking an item to its session-log file(s) under docs/logs/ (the per-subagent <timestamp>-<agent-id>.md logs the flows already write), 'everywhere where it makes sense'. CLARIFY: which ledgers get the field (tasks/defects/reviews/goals/hypothesis/handoffs?); field name + type (string[] of log paths or agent-ids?); who populates it and when (the orchestrator that writes the log already knows the agent-id ↔ item mapping); whether the TUI/web should render it as a link/relationship.
    
    All three extend the agent-ergonomics/observability theme (handoffs ledger + session-log links make orchestrator runs auditable; click-protection hardens the web client against stray mutations). Repo gate: bun run check; frontends stay pure MCP clients; any new ledger/field lands via @cq/ledger CANONICAL_LEDGERS (+ TUI/web rendering where relevant).
- grounding: |
    Repo grounding (G11 — confirmed at planning entry, 2026-06-03).
    
    CONFIRMED SCHEMA FACTS (packages/ledger/src/constants.ts):
    - CANONICAL_LEDGERS = 8 entries: milestones, defects, tasks, hypothesis, questions, decisions, goals, reviews (constants.ts:309-318). A new `handoffs` entry appends here (idPrefix HO — M/D/T/H/Q/K/G/R taken).
    - COMMON_REF_FIELDS (constants.ts:92-99) = {sourceRefs, blockedBy, dependsOn, ledgerRefs, tags, suggestedModel}; spread into defects/tasks/hypothesis/questions/decisions. NOT in goals/reviews (bespoke field sets).
    - ALL-TERMINAL precedent = REVIEWS_SCHEMA (constants.ts:286-302): both statuses terminal, empty transition arrays, bespoke fields {summary,new_questions,criticism,ledgerRefs,tags,sourceRefs}, idPrefix R.
    - sessionLogs (Q86 answer) goes on WORK-producing ledgers ONLY: tasks, reviews, defects, hypothesis, goals, handoffs. NOT questions/decisions. Adding to COMMON_REF_FIELDS would also hit questions/decisions, so it must be added per-schema (defects/tasks/hypothesis via inline field; goals/reviews/handoffs via their bespoke field sets) — NOT via COMMON_REF_FIELDS.
    
    CONFIRMED PROJECTION BUILDING BLOCK (packages/ledger/src/columns.ts): LONG_FIELD_DENYLIST = {description,rationale,criticism,context,alternatives,evidence,completion,answer,rootCause,suggestedFix,fix} (columns.ts:35-47); ALWAYS_SHOWN_COLUMNS={id,status,summary}; SUMMARY_SOURCE_FIELDS={headline,title,question}. fetch_ledger projection (Q76) reuses LONG_FIELD_DENYLIST to omit long fields. Snapshot stub summary (Q75) = headline??title??question??summary (the summarize() precedence already used by frontends).
    
    CONFIRMED TOOL SURFACE (packages/ledger/src/mcp/ledgerTools.ts): '14 tools' hardcoded in the header comment (ledgerTools.ts:7) AND in packages/ledger-mcp/src/main.ts; LEDGER_TOOL_NAMES is asserted by tests. New tools (Q80: minimal new tools): snapshot, reopen-item, unarchive-item, read-log → 18; fetch_ledger gains projection+pagination PARAMS (no new tool). Every agent-facing capability MUST be an MCP tool (pure-client frontends). QUERY_LANGUAGE_HELP already embedded in fts_search description + SERVER_INSTRUCTIONS (main.ts:164).
    
    TERMINAL/ARCHIVE (Q78): terminal statuses have [] outgoing transitions; reopen-terminal needs a guard-bypassing store op (move terminal→chosen non-terminal). archiveMilestone has no inverse; un-archive needs a store method restoring from ./archive/<ledger>/<id>.md. BOTH wanted; sweep-guard DEFERRED.
    
    FTS ANOMALY (Q77): reproduce-first the empty `(status:open OR status:wip)` result over a populated ledger (query.ts OR-of-qualifiers evaluator vs the dedicated status: param — two code paths). Failing test FIRST; if real defect → fix task + defects record (file-and-defer); else document.
    
    WEB (packages/ledger-web/src/App.tsx, Q81/Q82): ALL state-mutating buttons get a hold gate via ONE reusable HoldButton (per-button requireHold default true). Buttons: DetailPanel save (status transition + field edits), create-mode +item/+milestone save, BatchAnswerModal {batch-answer-submit, batch-answer-as-recommended, batch-pick-suggestion-N}, detail-panel answerBox buttons. HOLD_MS=1000 named constant; release-before-complete cancels+resets; keyboard = hold Enter/Space (keydown arms+starts progress, keyup-before-threshold cancels); WEB-ONLY (no TUI). happy-dom: uncontrolled inputs+refs; drive hold tests with FAKE TIMERS + dispatched pointer/key events.
    
    HANDOFFS (Q83/Q84/Q85): statuses drained|answers-required|mixed|illness-detected (all terminal), idPrefix HO. SEPARATE field handoffReasons: string[] explaining a 'mixed' stop (e.g. [drained,answers-required]). Item shape: summary (required) + flow (advance|plan|implement|investigate) + ledgerRefs + blockingQuestions (id[]) + handoffReasons (string[]) + sessionLogs (string[]) + tags + sourceRefs; append-only; intrinsic author/session/createdAt. WRITERS: each per-flow command writes a handoff when run STANDALONE; chained under /advance the sub-flow SUPPRESSES its handoff and /advance writes the single run-level record — requires amending advance.md §Provenance to permit exactly that one handoffs write.
    
    SESSION-LOG VIEWER (Q87, DEVIATION): sessionLogs populated by the command that writes the log, in the SAME update_item recording the outcome. Frontends MUST render sessionLogs as CLICKABLE links opening a POPUP showing log CONTENT → requires a NEW bounded MCP read-log tool (web is pure MCP client, cannot read docs/ directly). In-app log-viewer + MCP log-read tool ARE in scope.
    
    GATE: bun run check (test+typecheck+lint).
- milestones: ["M42","M43","M44","M45","M46"]

## M39

### G12 — planned

- createdAt: 2026-06-03T15:14:43.984Z
- updatedAt: 2026-06-03T15:22:15.519Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- title: "Fix D24: make the 's'-key-inert archived-item test regression-sensitive"
- description: |
    DEFECT-SEEDED goal (defect:D24, ex-D22) — root cause CONFIRMED by the /advance investigate round (H14 + orchestrator-validated citations), so this goal enters `planning` directly and SKIPS clarifying (K8 pt4 / K12). plan-advance should produce ONE reviewed FIX TASK directly.
    
    CONFIRMED ROOT CAUSE (H14): the "'s' key is inert on an archived item" test (packages/ledger-tui/test/app.test.tsx:959-986) asserts ONLY f.toContain('[archived]') (:982) and f.toContain('archived task') (:984) — both overlay-INSENSITIVE ('[archived]' = path-header app.tsx:934-939; 'archived task' = list-pane row app.tsx:1069). The status overlay replaces ONLY the content-pane Box (app.tsx:1071-1073: overlay!==null ? <Overlays/> : contentEl), so if the `!cursorInArchive` guard on the 's' handler (app.tsx:803 content-focus / :838 list-focus) were removed, the status SelectList would open in the content pane yet both assertions would still pass — the test cannot catch the regression. The sibling 'e'-inert test (:1008) asserts 'read-only' (a content-pane badge the overlay replaces) and IS regression-sensitive — the model.
    
    SUGGESTED FIX: after pressing 's', add a content-pane-sensitive assertion mirroring the 'e' test — assert the SelectList '› ' cursor marker (app.tsx:1291-1296) is ABSENT and/or the read-only badge '[archived · read-only]' (app.tsx:1424) is still PRESENT, so the test FAILS if 's' wrongly opens the status overlay on an archived row. Use the existing listSide(frame) helper (~test L1264) pattern for a content-pane slice, or assert '› ' absent from the whole frame. Keep the existing waitForFrame settle. Scope: packages/ledger-tui/test/app.test.tsx ONLY (test-quality fix, no product change). Repo gate: bun run check. NOTE: do NOT mark D24 resolved here — the implement-flow merge-back owns closure.
- tags: ["defect-seeded","defect:D24","test-quality"]
- milestones: ["M41"]

## M47

### G13 — planned

- createdAt: 2026-06-03T20:06:27.954Z
- updatedAt: 2026-06-03T20:10:32.790Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- title: Fix D25/D26/D27 (G11 follow-up code-quality cleanup)
- description: |
    DEFECT-SEEDED goal (clarify-skipped, K8 pt4) for three confirmed, low-severity, disjoint code-quality defects filed during the G11 build. Linked defects (their ledgerRefs point back here): D25, D26, D27. All three root causes are CONFIRMED with [correct]-validated citations; each fix is small + well-specified. Three disjoint file scopes → naturally parallel fix tasks. The fix TASKS must each ledgerRef their defect (defects:D25/D26/D27) so the implement orchestrator can close the defect on merge (goals has no ledgerRefs field).
    
    === D26 (read_log symlink-escape hardening — the only behavioural fix; reproduce-first) ===
    CONFIRMED ROOT CAUSE: FsLedgerStore.readLog (packages/ledger/src/store/FsLedgerStore.ts:1257-1267) validates containment with a LEXICAL path.resolve(logsDir, relPath) + startsWith(logsDir + path.sep) check and never calls fs.realpath; fs.readFile(resolved) then follows symlinks. A symlink inside docs/logs/ whose target escapes the root passes the lexical guard and is read.
    SUGGESTED FIX: after the lexical guard, fs.realpath(resolved) and re-assert realpath === logsDir || startsWith(logsDir + path.sep); throw the same escape error otherwise. Catch ENOENT so a genuinely missing file still surfaces the normal not-found error (do NOT mask it). ~3 lines. ADD a regression test FIRST: create a symlink under docs/logs pointing outside the root, assert read_log rejects it (must fail before the fix, pass after).
    
    === D25 (stale eslint-disable — lint hygiene) ===
    CONFIRMED ROOT CAUSE: navRenderBytes.test.tsx:291 carries `// eslint-disable-next-line no-console` over the console.log at :292, but no-console is not enabled in eslint.config.js, so the directive is unused → eslint warning (non-fatal).
    SUGGESTED FIX: remove the stale `// eslint-disable-next-line no-console` comment at packages/ledger-tui/test/navRenderBytes.test.tsx:291 (keep the console.log).
    
    === D27 (handoff CHAINED-trigger wording — prompt clarity) ===
    CONFIRMED ROOT CAUSE: the */advance.md handoff CHAINED branch (plan/advance.md:283, implement/advance.md:290) names only /advance; investigate/advance.md:282 adds /plan:advance; none covers a /<flow>:start or /<flow>:follow-up inline pass, leaving correctness reliant on start.md/follow-up.md external override.
    SUGGESTED FIX: reword each of the 3 */advance.md CHAINED triggers to fire on ANY wrapping flow command — 'CHAINED INLINE by any wrapping flow command (/advance, /plan:advance, or a /<flow>:start / /<flow>:follow-up that runs this pass inline) → SUPPRESS; the outermost wrapper owns the single handoff write.' Prompt-only.
    
    GATE: bun run check green. Frontends stay pure MCP clients. D26 requires reproduce-first (failing symlink test before the realpath fix).
- milestones: ["M48"]

## M49

### G14 — planned

- createdAt: 2026-06-03T20:40:59.340Z
- updatedAt: 2026-06-03T20:44:56.357Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- title: Fix D28 (readLog check-then-read TOCTOU)
- description: |
    DEFECT-SEEDED goal (clarify-skipped, K8 pt4) for D28 (CONFIRMED H18) — a low-severity, pre-existing TOCTOU in FsLedgerStore.readLog surfaced by the T158 reviewer. Linked defect (its ledgerRefs point back here): D28. The fix TASK must ledgerRef defects:D28 + goals:G14 (goals has no ledgerRefs field) so the implement orchestrator closes D28 on merge.
    
    CONFIRMED ROOT CAUSE: readLog computes `real = fs.realpath(resolved)` and validates `real` against realLogsDir inside a try block, but reads `fs.readFile(resolved)` (the non-canonical, symlink-bearing path) after the block. A symlink swapped between the realpath check and the readFile follows to its new target at read time (check-then-read TOCTOU). T158 closed the persistent-symlink escape; this transient race remains. Low severity: read-only tool confined to the server's own docs/logs; an actor able to swap an in-docs/logs symlink already controls returned content (no privilege escalation).
    
    SUGGESTED FIX: hoist `real` out of the try block and read the validated CANONICAL path — `fs.readFile(real)` instead of `fs.readFile(resolved)`. `real` has no symlink components, so the read follows nothing and the validated path === the read path, closing the TOCTOU. PRESERVE ENOENT: when realpath(resolved) throws ENOENT (genuinely missing file), fall back to reading `resolved` so the normal not-found error still surfaces (do NOT mask it). Add a regression test (e.g. assert the canonical path is read, or a post-check symlink swap does not escape). ~2-3 lines + test. Keep the existing D26 escape-rejection + symlinked-root + ENOENT tests green.
    
    GATE: bun run check green. Scope: packages/ledger/src/store/FsLedgerStore.ts (readLog) + test.
- grounding: "Verified against packages/ledger/src/store/FsLedgerStore.ts (main, current tree). readLog() at L1251-1302: `resolved = path.resolve(this.logsDir, relPath)` (L1257); lexical containment check L1258-1265; then a try block (L1276-1294) computes `const real = await fs.realpath(resolved)` (L1277) and validates `real` against `realLogsDir` (L1285-1289) — but `real` is BLOCK-SCOPED to the try and the actual read at L1296 is `const buf = await fs.readFile(resolved)`, the non-canonical symlink-bearing path. Confirms H18 TOCTOU. The existing catch (L1290-1294) already swallows ENOENT (`if (code !== 'ENOENT') throw err`) to let a genuinely-missing file fall through to readFile — so the ENOENT-fallback semantics the fix must preserve already exist at the catch. Fix: hoist `real` to a `let` outside the try, assign inside; after the try, `await fs.readFile(real ?? resolved)` so a missing file (real undefined, ENOENT-swallowed) still reads `resolved` and surfaces the normal not-found error, while the happy path reads the validated canonical `real`. Sibling protections assertWithinDocsRoot (L1326) + the D26 realpath re-assert are the model. Tests live alongside in packages/ledger (D26 escape-rejection / symlinked-root / ENOENT suite must stay green)."
- milestones: ["M50"]

## M51

### G15 — planned

- createdAt: 2026-06-05T18:09:10.959Z
- updatedAt: 2026-06-05T20:26:42.887Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- title: Explorer RW access + pluggable parallel reviewers (cq.toml)
- description: |
    Plan two new features for the coding-agent flow harness.
    
    FEATURE 1 — Explorer read/write access in investigate:* flow:
    Sometimes explorers in the investigate flow might need R/W rights to investigate better. Options under consideration:
    (a) allow explorers writes (bash, etc.) but instruct them to attempt to avoid that unless necessary; or
    (b) allow explorers to RETURN an RW permission request so the orchestrator can re-run the explorer with extended permissions.
    The planner may propose an alternative/third approach.
    
    FEATURE 2 — Pluggable parallel reviewers via cq.toml:
    The `pi` coding agent is available in this sandbox, with Codex and X.AI integrations configured. Goal: be able to use it to run reviews in parallel with, or instead of, Claude reviews.
    - Add a root-directory config file, e.g. `cq.toml`, with a section defining reviewers, e.g. `reviewers = ["claude:opus", "pi:grok-build", "pi:gpt-5.5"]`.
    - When defined, for every review the orchestrator launches all configured reviewers in parallel, then reconciles their outputs.
    - The config file defines the defaults; the user can modify the ACTIVE reviewer set on the fly by saying so (e.g. a command `/cq:reviewers use grok and opus only`).
- grounding: |
    Grounded against the actual harness (2026-06-05) AND folded the Q88-Q93 answers into a concrete design. Assets live under nix/pkg/cq-assets/{commands,agents}/, fanned by nix/hm/dev-llm.nix (mergedCommands -> Claude commands + Codex ~/.codex/prompts + Pi promptTemplates; mergedAgents -> Claude ONLY). The Bun workspace is nix/pkg/cq-ledgers/ (packages/ledger{,-live,-mcp,-tui,-web}); `bun run check` = tsc -b && eslint . && bun test. programs.mcp.servers registry in dev-llm.nix currently wires codegraph + ledger; a new MCP server is added there.
    
    FEATURE 1 design (answers Q88=c, Q89=as-recommended): TWO-TIER explorer. Keep investigate-explorer.md read-only/no-worktree EXACTLY as-is. Add a NEW agent investigate-prober.md (Bash-enabled, runs in an ISOLATED throwaway git worktree) dispatched by commands/investigate/advance.md ONLY when an explorer's returned JSON sets a new optional `probeRequest` field (what it needs to RUN + why). The probe is READ + EXECUTE (repros, bun test, builds, git inspection) inside the throwaway worktree; NO persisted edits to the main checkout; LOCAL-ONLY, no network by default. Scope = investigate:* flow ONLY. The orchestrator harvests the prober's evidence (same citation-revalidation trust model) then DISCARDS the worktree. The explorer's existing fenced-json contract {hypothesisId, evidence[], lean, notes} gains the optional `probeRequest`; the prober emits the SAME evidence-json shape. investigate-explorer's disallowedTools already blocks Bash/worktree; the prober is a separate def so the read-only invariant that makes explorer citations trustworthy stays intact.
    
    FEATURE 2 design (answers Q90, Q91, Q92, Q93): Per-repo root cq.toml read via a NEW `cq-config` MCP server (Q92 — the user explicitly wants an MCP endpoint, NOT a prompt-side Read). cq.toml schema (Q92): an [aliases] table mapping alias->"<harness>:<model>" (e.g. codex="pi:gpt-5.5", grok="pi:grok-build", opus="claude:opus-4.8[1m]") PLUS reviewers=["codex","grok","opus"] (a list of ALIASES, resolved through [aliases]). cq-config MCP exposes a tool (e.g. get_reviewers / get_config) the orchestrators call to obtain the resolved reviewer set; lives as a new package under nix/pkg/cq-ledgers/packages (mirrors ledger-mcp) and is registered in programs.mcp.servers in dev-llm.nix. INVOCATION (Q90): claude:<model> -> native Agent subagent (today's plan-reviewer/implement-reviewer path, UNCHANGED). Non-Claude alias -> orchestrator shells out via Bash to `pi` ONLY (NOT codex CLI): `pi -p <prompt>` selecting provider+model (grok-build via grok-build provider; gpt-5.5 via the openai-codex provider already configured in pi). The pi reviewer must emit the SAME structured-JSON contract the native reviewer returns (plan: a reviews-item-shaped json {summary,new_questions,criticism,defects}; implement: {taskId,verdict,criticism,questions,defects,rationale}). Because pi/codex don't get AGENT files (mergedAgents is Claude-only), the reviewer RUBRIC must be extracted into a SHARED reviewer PROMPT both the native subagent and the pi shellout consume (a commands/* entry is auto-delivered to pi as a promptTemplate). RECONCILIATION (Q91 -> CONFIRMED by Q95 2026-06-05): STRICTEST-WINS verdict (any reviewer's revise/disapprove blocks; go-ahead/approve requires unanimity) + UNION of all reviewers' criticism/questions/defects, each finding tagged by source reviewer (e.g. a [grok] / [codex] prefix), aggregated into the SINGLE reviews item the round records. Q95 explicitly confirmed strictest-wins+union-with-source-tags as the intended semantics over majority-vote / designated-primary, so T175/T176 stand as written (no material change). ON-THE-FLY OVERRIDE (Q93=session-only): /cq:reviewers (commands/cq/reviewers.md, net-new /cq:* namespace) sets the ACTIVE reviewer set for the CURRENT chained run ONLY — NO durable override file, NO gitignored state, NO ledger item. The user re-states it each fresh /plan:advance or /implement:advance. cq-config provides the DEFAULT set from cq.toml; the session override (when stated) supersedes it in-memory for that run. Feature is OFF (single native Claude reviewer, today's exact behaviour) when cq.toml is absent. SPIKE-FIRST (Q90 recommendation): the FIRST task verifies `pi -p` runs non-interactively in this sandbox and emits parseable output, BEFORE the reconciliation tasks depend on it.
    
    R169 (revise) FIXES already folded into the durable plan: (1) T173 gates the native plan-reviewer's reviews-ledger write on mode — direct write ONLY in unconfigured single-reviewer fallback; RETURN json (write nothing) in configured multi-reviewer mode so the orchestrator writes the SINGLE aggregated item (resolves the T173/T175 double-write). (2) T168/T178 VERIFY the real cq-assets source root before adding link-prompts.ts entries and assert the new symlinks resolve to existing files (not a stale 'llm/' root). (3) T172 ALSO registers cq-config in THIS repo's .mcp.json (not just global dev-llm.nix) so in-repo dogfooding can reach get_reviewers. The stale-'llm/'-root pre-existing fault remains a separately-filed out-of-scope defect (R169 file-and-defer bucket).
    
    Parallel-safety: commands/investigate/advance.md, commands/plan/advance.md, commands/implement/advance.md and dev-llm.nix are each touched by multiple tasks across both features -> serialize same-file edits via dependsOn (R137/R138/R139 precedent). The cq-assets README.md is STALE and must be updated to list the investigate/* assets + the new prober/cq.toml/cq-config/reviewers assets.
- sessionLogs: ["docs/logs/20260605-181341-a2e334d56e77d791c.md","docs/logs/20260605-184550-afa26f26f6fc1fad0.md","docs/logs/20260605-185213-a4b0e9587bbebb6a6.md","docs/logs/20260605-185546-af711a488fc88fde4.md","docs/logs/20260605-202254-afdfc963dee5ab691.md","docs/logs/20260605-202254b-a9ddca0b976c0faf3.md"]
- milestones: ["M55","M56"]

## M53

### G16 — planned

- createdAt: 2026-06-05T18:31:39.036Z
- updatedAt: 2026-06-05T18:39:16.091Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- title: Fix D29 — reject empty/whitespace answer on a question's `answered` transition
- description: |
    DEFECT-SEEDED goal (skips clarifying per T35; confirmed root cause embedded). Fix D29: the ledger accepts an empty/whitespace `answer` when a `questions` item transitions to `answered`, violating the invariant that an `answered` question carries a usable answer.
    
    CONFIRMED ROOT CAUSE (H19 backend + H20 frontend, all citations validated against source):
    BACKEND (authoritative): QUESTIONS_SCHEMA.answer is `{type:'string', required:false}` with no content/status-conditional constraint (constants.ts:217). The store transition path applyUpdateItem (core.ts:259-291) runs assertTransitionAllowed + an OPTIONAL StatusChangePrecondition + validateFields; validateFields/assertFieldType only type-check (core.ts:831-859), and the precondition hook is wired ONLY for GOALS_LEDGER (FsLedgerStore.ts:571-581). The MCP update_item handler forwards status+fields verbatim (ledgerTools.ts:309-317); its Zod fieldsSchema accepts '' (ledgerTools.ts:171-173).
    FRONTEND (complementary): all four submit paths are unguarded — web detail submitAnswer/HoldButton (App.tsx:2611/2629), web BatchAnswerModal (App.tsx:1732), TUI answer overlay via TextPrompt Enter (TextPrompt.tsx:30-43), TUI BatchAnswerOverlay Enter (app.tsx:1952).
    
    SUGGESTED FIX:
    1. BACKEND (primary/invariant): reject (from != answered) -> (to == answered) on the questions ledger unless the EFFECTIVE answer = (patch.fields?.answer ?? item.fields.answer) is a non-empty trimmed string. Implement as a questions-specific StatusChangePrecondition mirroring assertGoalPhasePreconditions, wired for QUESTIONS_LEDGER in FsLedgerStore.updateItem AND the in-memory store. Reproduce-first: failing test that update_item(Q, status:'answered', fields:{answer:''}) and {answer:'   '} throw, non-empty still succeeds; dual-tests across FsLedgerStore + InMemoryLedgerStore.
    2. FRONTEND (UX): disable 'save & mark answered' when the trimmed answer is empty (web detail HoldButton App.tsx:2629; web BatchAnswerModal App.tsx:1732; TUI TextPrompt Enter / BatchAnswerOverlay Enter), reusing the answerHasText/setAnswerHasText pattern.
    Planning may weigh the targeted precondition (recommended) vs a general FieldSpec extension. Acceptance: `bun run check` green; reproduce-first red/green on the backend guard.
- sourceRefs: ["defects:D29"]
- milestones: ["M54"]
- grounding: "Plan emitted under work milestone M54 (recorded here). Chose the TARGETED questions-specific StatusChangePrecondition (mirroring assertGoalPhasePreconditions, dual-store) over a general FieldSpec/nonEmpty extension — surgical, low-risk, matches the existing goals-only precedent. Backend = authoritative invariant (T162, reproduce-first dual-tests across FsLedgerStore + InMemoryLedgerStore); frontends = pure MCP clients per CLAUDE.md, so web/TUI guards (T163/T164) are complementary UX only and depend on T162. Same-file serialization honored: both web edits (HoldButton + BatchAnswerModal in App.tsx) are folded into ONE task T163 (repo reviewer policy R137/R138/R139); the two TUI edits live in different files so share T164. Codegraph index not loaded for this tree; citations rely on the investigation's source-validated anchors — implementers must re-cite against live source as line numbers may have drifted."
- sessionLogs: ["docs/logs/20260605-183509-a2857ca64e4c97f47.md","docs/logs/20260605-183755b-a17d3b4e7f4b48f7b.md"]

## M57

### G17 — planned

- createdAt: 2026-06-05T19:00:07.789Z
- updatedAt: 2026-06-05T19:10:04.835Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- title: Fix D30 — repoint link-prompts.ts + cq-assets README off the vanished `llm/` root
- description: |
    DEFECT-SEEDED goal (skips clarifying per T35; confirmed root cause embedded). Fix D30: `bun run link-prompts` silently creates 14 dangling `.claude/**` symlinks because the asset tree moved to `nix/pkg/cq-assets/{commands,agents}/` but link-prompts.ts + the cq-assets README still reference the removed `llm/` root.
    
    CONFIRMED ROOT CAUSE (H21, all 8 citations re-validated against source):
    The asset tree was relocated to `nix/pkg/cq-assets/{commands,agents}/` and `assets.nix` updated (collectMdIn ./commands/./agents, assets.nix:49-50), but `scripts/link-prompts.ts` was not: its 14 LINKS still set `source: 'llm/commands/...' / 'llm/agents/...'` (link-prompts.ts:29-44) resolved against REPO_ROOT = nix/pkg/cq-ledgers/ (link-prompts.ts:19; package.json:13). `nix/pkg/cq-ledgers/llm` no longer exists. The loop stats only the LINK (`linkExists`/lstat absLink), never the TARGET (absSource); symlink(2) succeeds on a nonexistent target and logs success (link-prompts.ts:46-73) — so dangling links are produced silently. `nix/pkg/cq-assets/README.md:1,10-11,40-42` still documents the old `llm/` root.
    
    SUGGESTED FIX:
    1. Repoint link-prompts.ts LINKS `source:` from `llm/...` onto the real tree: change each `source` to resolve from REPO_ROOT to `../cq-assets/commands/...` / `../cq-assets/agents/...` (preferred — explicit), OR restore a `nix/pkg/cq-ledgers/llm -> ../cq-assets` symlink.
    2. HARDEN the loop: assert each `absSource` exists (test -e / lstat) BEFORE `symlink`, throwing loud on a missing target. Add reproduce-first coverage (or a `--check` mode) asserting every produced link resolves.
    3. Update `nix/pkg/cq-assets/README.md` (title, convention block, Three-consumers / Claude-link tables) to the `nix/pkg/cq-assets/...` layout.
    Acceptance: reproduce-first (a test/assertion that FAILS on the current dangling output, passes after); after fix `bun run link-prompts` yields only non-dangling links (every target `test -e`); `bun run check` green.
    
    NOTE coordination with G15: G15's tasks T168/T178 ADD new link entries (investigate-prober, /cq:*) and were revised to verify their source root independently — sequence so D30's repoint lands first or the two are reconciled to avoid edit collisions on link-prompts.ts.
- sourceRefs: ["defects:D30"]
- grounding: "Re-validated against source 2026-06-05. scripts/link-prompts.ts (nix/pkg/cq-ledgers/): REPO_ROOT = dirname(script)/.. = nix/pkg/cq-ledgers/ (L19); run via package.json:13 `link-prompts`. 14 LINKS (L29-44) set source:'llm/commands/...' / 'llm/agents/...'; nix/pkg/cq-ledgers/llm does NOT exist. The creation loop (L56-74) stats only the LINK (linkExists/lstat absLink, L64-65), NEVER the target absSource (L58), so symlink(2) (L72) succeeds on a nonexistent target and L73 logs success -> 14 dangling .claude/** symlinks produced silently. Real assets live at nix/pkg/cq-assets/{commands,agents}/ (assets.nix:49-50 collectMdIn ./commands/./agents); cq-assets is a SIBLING of cq-ledgers, so from REPO_ROOT the correct source is `../cq-assets/commands/...` / `../cq-assets/agents/...`. Explicit repoint preferred over restoring a hidden `llm -> ../cq-assets` symlink. nix/pkg/cq-assets/README.md still documents `llm/` root: title L1, convention block L9-13, current-assets table L18-29 (commands/.. relative, OK but header context stale), three-consumers Claude-link table L38-49 (llm/ sources), narrative L31,54. No existing test covers link-prompts.ts (package.json test = `bun test --pass-with-no-tests`). COORDINATION: G15 T168/T178 also edit scripts/link-prompts.ts (add investigate-prober / cq:* entries) — same-file, must be serialized with G17."
- milestones: ["M58"]
- sessionLogs: ["docs/logs/20260605-190250-a847f24eb64249876.md","docs/logs/20260605-190732-acc3a65f452db3ad0.md","docs/logs/20260605-190853b-a4d9f6096ca33a3fa.md"]

## M59

### G18 — planned

- createdAt: 2026-06-05T21:58:20.012Z
- updatedAt: 2026-06-05T22:33:18.726Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- title: Merge cq-config into ledger MCP + pluggable parallel planners
- description: |
    Two follow-up changes to the just-built G15 harness work (Feature 2 / M56).
    
    PART 1 — Consolidate cq-config into the ledger MCP (scope correction):
    The G15 build created a SEPARATE `cq-config` MCP server (package `@cq/config-mcp` + `cq-config-mcp` bin + Nix package `.#cq-config-mcp` + registrations in dev-llm.nix `programs.mcp.servers` and this repo's `.mcp.json`). The user wanted just a cq-config TOOL added to the EXISTING ledger MCP server — NOT a standalone server. ACTION: merge the cq-config functionality (the `get_reviewers`/`get_config` tools over the `@cq/config` parser) INTO the ledger MCP server as tool(s), then REMOVE the unnecessary standalone server: the `@cq/config-mcp` package, the `cq-config-mcp` bin, the `.#cq-config-mcp` flake attr/derivation, and the dev-llm.nix + .mcp.json `cq-config` server registrations. The `@cq/config` parser package can stay (it is the reusable library); only the separate SERVER/transport is removed. All consumers (the reconciliation wiring in plan/advance.md + implement/advance.md + /cq:reviewers) must be updated to call the tool on the ledger MCP (e.g. `mcp__ledger__get_reviewers`) instead of `mcp__cq-config__*`.
    
    PART 2 — Pluggable parallel PLANNERS (mirror parallel reviewers):
    We now support parallel REVIEWERS (cq.toml `reviewers = [...]`, strictest-wins+union reconciliation, `/cq:reviewers` per-session override). Add the SAME capability for PLANNERS: define a default planner set in the config (e.g. `planners = ["claude:opus", "pi:grok-build", ...]`); when defined, the plan flow launches all configured planners in parallel and reconciles their plans; the user can modify the ACTIVE planner set per-session with a command (e.g. `/cq:planners use grok and opus only`), exactly the way `/cq:reviewers` works. The planner reconciliation semantics (how N parallel plans are merged into one) are for clarifying/planning to settle.
- sourceRefs: ["goals:G15"]
- grounding: |
    Grounded against just-merged G15/M56 artifacts (HEAD f2b69be). [v2 — folds in Q97–Q102 answers + a second grounding pass on ledgerTools.ts/cq-config-mcp/main.ts/cq-config parser/plan-advance.md/reviewers.md/plan+implement advance.md.]
    
    === DECISIONS LOCKED BY ANSWERS ===
    - Q97 (a): port BOTH tools verbatim -> mcp__ledger__get_reviewers + mcp__ledger__get_config (consumer call-sites become 1:1 renames). Tool count 18->20 (PART 1); ->21 after PART 2 adds get_planners.
    - Q98: DELETE the standalone server outright (no shim) AND keep @cq/ledger config-agnostic -> thread a CONFIG capability from @cq/ledger-mcp into the tool factory, mirroring the readLog capability (createLedgerMcpTools(store, readLog?) gains a configCapability? param resolving cq.toml against the store root). => @cq/config becomes a dep of @cq/ledger-MCP (NOT @cq/ledger core).
    - Q99: cq.toml stays at repo root = ledger MCP --cwd/$LEDGER_ROOT; drop the redundant $CQ_CONFIG_ROOT. Schema unchanged except PART 2 adds sibling planners=[].
    - Q100 (CORE): GENERATE-N-then-JUDGE, and the judge must SYNTHESIZE — when non-best planners produced something important, factor those good parts in (NOT blind pick-best). Orchestrator writes only the final synthesized plan.
    - Q101: under model (a), pi:* planners ALLOWED as candidate-emitters (they emit a structured task-DAG via stdout; the orchestrator owns ALL ledger writes). Claude planners run as plan-advance subagents in a new CANDIDATE MODE.
    - Q102: SHARED [aliases] table; sibling planners=[] list; new commands/cq/planners.md mirroring reviewers.md (reuse same fallback map grok->pi:grok-build, opus->claude:opus-4.8[1m], codex->pi:gpt-5.5); add resolvePlanners(); add get_planners tool + a planners field on get_config.
    
    === PART 1 surface (verified) ===
    - @cq/config PARSER lib (packages/cq-config/src/{index,types,config,toml}.ts): loadConfig(repoRoot)->CqConfig|null, resolveReviewers, parseReviewerToken, CQ_CONFIG_FILENAME='cq.toml', HARNESSES=['claude','pi']. STAYS. CqConfig={aliases:Record<string,ReviewerToken>, reviewers:readonly string[]}. parseConfig/parseToml currently reject any top-level key other than 'reviewers' (toml.ts L139-143) — PART 2 must extend BOTH the toml whitelist and CqConfig/parseConfig for 'planners'.
    - @cq/config-mcp STANDALONE SERVER (packages/cq-config-mcp/src/main.ts): raw @modelcontextprotocol/sdk McpServer+StdioServerTransport+registerTool (NOT the claude-agent-sdk tool() shape). Payload builders computeReviewers/computeConfig + ResolvedReviewer/GetReviewersResult/GetConfigResult types are the REUSABLE logic to lift into the merged tool. Root precedence --cwd>$CQ_CONFIG_ROOT>cwd. TO DELETE entirely (server+bin+package dir).
    - MERGE TARGET packages/ledger/src/mcp/ledgerTools.ts: factory createLedgerMcpTools(store, readLog?) returns tool()[] (names auto-prefixed mcp__cq__*). Header documents '18 tools' (L7) + the LEDGER_TOOL_NAMES asserted list (test surface) — both bump to 20 (PART1)/21 (PART2). readLog capability is injected (ReadLogCapability from ./readLog.js, threaded from ledger-mcp buildServer) — the config capability follows the SAME injection pattern. Re-express get_reviewers/get_config in tool()+zod (empty input schema {} as Record<string,never>, jsonResult(...) return) calling computeReviewers/computeConfig against the resolved store root.
    - ledger-mcp/src/main.ts buildServer(store, displayName) -> registerLedgerStdioTools(server, store, readLog); --cwd>$LEDGER_ROOT>cwd. Wire @cq/config here: construct a config capability bound to the resolved root and pass it into the factory (mirror readLog). embedded TUI/web buildServer paths get the same wiring.
    - flake.nix: remove cqConfigMcp derivation (~247-304), packages.cq-config-mcp + apps.cq-config-mcp (~449,494), node-modules FOD fileset+installPhase entries for packages/cq-config-mcp (~59,102,106). @cq/config stays in FOD. Because @cq/config becomes a dep of @cq/ledger-mcp, the ledger-mcp derivation installPhase must add a @cq/config workspace symlink under packages/ledger-mcp/node_modules/@cq/config (mirror the @cq/ledger link), and embedServerClosure for TUI/web likewise. FOD-hash refresh required (set outputHash to 52 A's -> nix build .#node-modules -> paste got: hash).
    - dev-llm.nix: remove cqConfigPkg = ledgerPkgs.cq-config-mcp (~105) + programs.mcp.servers.cq-config (~567-570). piMcpJson keep-alive remap is generic, so removing the entry covers Pi too.
    - .mcp.json: remove the 'cq-config' server entry (~7-10).
    - Consumers (switch mcp__cq-config__get_reviewers/get_config -> mcp__ledger__* + frontmatter allowed-tools): commands/plan/advance.md (frontmatter L4 grants mcp__cq-config__get_reviewers; step 2.1 calls get_reviewers), commands/implement/advance.md (frontmatter L4 grants mcp__cq-config__get_reviewers; reviewer-resolution block), commands/cq/reviewers.md (frontmatter L4 grants both get_reviewers+get_config; steps 1-2 call get_config).
    
    === PART 2 surface (verified) ===
    - Reviewer template = commands/plan/advance.md step 2: 2a single-reviewer fallback (native plan-reviewer writes its own review); 2b multi-reviewer (orchestrator launches ALL reviewers in parallel — claude:* via Agent subagent_type plan-reviewer in 'configured mode' returning JSON; pi:* via Bash `pi -p --no-tools --no-session --provider P --model M '<prompt>'` per K30, strip code fence; reconcile strictest-wins+tagged-union; orchestrator writes the ONE aggregated reviews item). The multi-PLANNER step mirrors 2b STRUCTURE but with generate-N-then-JUDGE+SYNTHESIS reconciliation (NOT strictest-wins, which only works for commensurable verdicts).
    - Native planner agents/plan-advance.md: one state-step per call; disallowedTools Write/Edit/MultiEdit/NotebookEdit/Bash (so candidate mode is READ-ONLY — emits a structured task-DAG JSON in its REPLY, writes no ledger; consistent with its disallow list). Currently SINGLE; gains a CANDIDATE MODE branch (when invoked by the orchestrator as one of N: ground + produce a full candidate plan as fenced JSON {milestones:[...], tasks:[{headline,description,acceptance,suggestedModel,dependsOn,ledgerRefs}], rationale}, write NOTHING).
    - /cq:reviewers (commands/cq/reviewers.md) is the session-only NL override (parses NL->alias names, resolves via cq.toml [aliases] + hardcoded fallback map, echoes active set, writes nothing). /cq:planners mirrors it 1:1 (same fallback map, same SESSION-ONLY semantics, reads get_planners/get_config).
    - KEY: N plans are alternative DAGs, NOT unionable -> generate-N-then-judge+synthesis. The judge is a synthesis step (orchestrator, or a dedicated plan-synthesizer subagent) that PICKS a base candidate AND folds in valuable parts of the others; only that ONE synthesized plan is written to the ledger by the orchestrator. pi:* planners participate as candidate-emitters because the orchestrator owns all writes.
- sessionLogs: ["docs/logs/20260605-220206-a2104c6c950c88db3.md","docs/logs/20260605-222325-a0458c766de7ac50b.md","docs/logs/20260605-222806-a85471b82ade9e93e.md","docs/logs/20260605-223004-a8f8d7161f2ec8bdf.md","docs/logs/20260605-223202-a0aae2a8104718584.md","docs/logs/20260605-223202b-ac77d7a55c4c9dd79.md"]
- milestones: ["M61","M62"]

## M63

### G19 — planned

- createdAt: 2026-06-06T00:35:45.432Z
- updatedAt: 2026-06-06T00:39:50.924Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- title: Fix D32 — repoint cq-assets/README.md off the removed cq-config MCP server
- description: "Defect-seeded goal (D32, confirmed root cause H23 — clarification skipped per K8 pt4). CONFIRMED ROOT CAUSE: nix/pkg/cq-assets/README.md is the last live consumer documenting the removed standalone cq-config MCP server; staleness confined to the 'Configuration' section — L77 heading '## Configuration — cq.toml and cq-config MCP' and L82-85 prose 'The `cq-config` MCP server exposes `get_reviewers` over the `.mcp.json` interface ...'. After G18 PART 1 the standalone server/package/flake-attr/registrations were deleted and get_reviewers/get_config merged into the ledger MCP (mcp__ledger__*; get_planners added PART 2). SUGGESTED FIX (verbatim): Edit README.md 'Configuration' section ONLY — (1) L77 heading → 'Configuration — cq.toml and the ledger MCP' (or drop the server name); (2) L82-85 prose → cq.toml is parsed by the @cq/config parser and surfaced by the LEDGER MCP server, which exposes get_reviewers/get_config (and get_planners) as mcp__ledger__* over .mcp.json — no standalone cq-config server; optionally note planners mirror reviewers via the shared [aliases] table. Doc-only; bun run check stays green. Linked defect: D32. Single fix task expected; acceptance: README 'Configuration' section repointed to the ledger MCP, no standalone-cq-config-SERVER reference remains in README, bun run check green."
- milestones: ["M64"]
- sessionLogs: ["docs/logs/20260606-003711-af72aa0c4af9b4c73.md","docs/logs/20260606-003711-a6ec41c8478ee27ba.md"]

## M65

### G20 — clarifying

- createdAt: 2026-06-06T10:37:42.559Z
- updatedAt: 2026-06-06T10:42:01.567Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- title: "cq.toml [webui] config + new cq CLI (init/reset/erase)"
- description: |
    Two minor feature requests (greenfield).
    
    FEATURE 1 — `[webui]` section in cq.toml + port auto-increment:
    Add a `[webui]` section to cq.toml with two entries: `host` and `port`. The web UI should read its host/port settings from there. If CLI args (the existing `--host`/`--port` flags) are set, the CLI args MUST be preferred over the cq.toml values. If the configured/requested port is already occupied, the web UI should increment the port number until it finds the first available port, listen on it, and REPORT the actual host/port it ended up listening on to stdout.
    
    FEATURE 2 — new `cq` CLI tool with subcommands:
    Introduce a new CLI tool named `cq` with three subcommands:
    - `cq init` — creates empty ledgers if there are none.
    - `cq reset` — move the ledgers RESET logic OUT of the MCP server and into this subcommand (relocate the existing reset capability from the MCP).
    - `cq erase` — destroys existing ledgers.
    
    Both are described by the user as MINOR feature requests.
- grounding: |
    Grounded read-only against HEAD 32cfe43 (2026-06-06). Bun workspace = nix/pkg/cq-ledgers/packages/{ledger,ledger-mcp,ledger-web,ledger-tui,cq-config}. bun run check = tsc -b && eslint . && bun test (run from nix/pkg/cq-ledgers/). Nix bins packaged in repo-root flake.nix (.#ledger-mcp/.#ledger-tui/.#ledger-web) + node-modules FOD.
    
    === FEATURE 1 (cq.toml [webui] + port auto-increment) ===
    - @cq/config (packages/cq-config/src/{toml,config,types}.ts) is a MINIMAL hand-rolled TOML parser, intentionally NOT full TOML. parseToml's table handling whitelists ONLY the [aliases] table and top-level keys reviewers/planners; ANY other top-level key OR table THROWS TomlSyntaxError ('unexpected table [..]' / 'unexpected top-level key ..'). Value parsing supports ONLY double-quoted STRINGS (parseString) and single-line arrays of strings (parseStringArray) — NO numbers/bools. => [webui] is a NEW table: BOTH parseToml (add a [webui] branch) AND the typed model (RawToml/CqConfig/parseConfig in toml.ts+config.ts+types.ts) must be extended; `port` being a NUMBER needs either integer support added to the parser or port kept as a quoted string. loadConfig(repoRoot) reads <repoRoot>/cq.toml, returns null if absent, and EAGERLY resolveReviewers+resolvePlanners (throws on dangling alias) — [webui] is orthogonal but shares this load path.
    - ledger-web entrypoint = packages/ledger-web/src/serve.ts (bin 'ledger-web' -> ./src/serve.ts). parseArgs already handles --host (DEFAULT_HOST 127.0.0.1) / --port (DEFAULT_PORT 5180) / --mcp-url / --cwd; ledger root resolves --cwd > $LEDGER_ROOT > process.cwd(). Default mode is EMBEDDED MCP (co-hosts /mcp + /ws in-process via attachMcpHttp + createEmbeddedStore); --mcp-url switches to reverse-proxy. cq.toml root for [webui] = that resolved cwd (same root the embedded store/ledger MCP uses; matches G18 Q99 'config root IS the ledger root').
    - Bun.serve binds opts.port directly and does NOT auto-increment on EADDRINUSE (it throws). The increment-until-free loop is NET-NEW. main() currently prints startup line to STDERR ('ledger-web: serving http://host:server.port/ -> backend'), using Bun's server.port (the actual bound port). Goal wants the actual host/port reported to STDOUT — that is a CHANGE of stream + possibly format. ledger-web does NOT read cq.toml today at all; threading loadConfig into serve.ts is new wiring.
    
    === FEATURE 2 (cq CLI: init/reset/erase) ===
    - NO `cq` bin exists today (net-new package/bin; would mirror ledger-mcp packaging in flake.nix + node-modules FOD).
    - RESET already exists at TWO layers: (1) library FsLedgerStore.reset() in @cq/ledger (packages/ledger/src/store/FsLedgerStore.ts) — public operator-facing: counts items, drops non-canonical FTS, calls private backupAndReinit() which snapshots docs/*.md + docs/ledgers.yaml to docs/.backup/<sanitized-ISO>/ then rewrites the canonical empty set, reloads via init(); returns ResetSummary{backupDir, ledgers[]}. (2) CLI surface in packages/ledger-mcp/src/main.ts: parseArgs --reset/--yes(-y) + runReset() (ResetIo-injectable; confirmation policy: --yes => proceed; TTY no --yes => prompt y/N; non-TTY no --yes => REFUSE exit 2; backup to docs/.backup/) + main() short-circuit that exits WITHOUT serving. So 'relocate reset OUT of the MCP' = move the CLI WRAPPER (runReset + --reset parsing) to `cq reset`; FsLedgerStore.reset() library method STAYS in @cq/ledger (it's the reusable core). Removing --reset from ledger-mcp is a CLI-surface change (any script/Nix app invoking `ledger-mcp --reset` would break).
    - INIT (create-if-none): store.init() (FsLedgerStore) bootstraps docs/ledgers.yaml (EMPTY_REGISTRY if missing) + every CANONICAL_LEDGER (milestones seeded with active group + M-AMBIENT; others empty) when files are absent; it is IDEMPOTENT and already runs on EVERY server start (ledger-mcp, embedded ledger-web). `cq init` ~= run init() (creates empty ledgers if none; no-op/leaves data if present).
    - ERASE (destroy): NO existing implementation. reset() backs-up-then-reinits (data recoverable in docs/.backup/); erase = destroy WITHOUT reinit/backup — net-new + most destructive + most ambiguous (what exactly: docs/*.md only? docs/ entirely incl. archive/.backup/logs/.locks? leave dir empty vs re-init?). Needs a confirmation/safety policy (reuse ResetIo pattern).
    - 'empty ledgers' = docs/ledgers.yaml registry + per-ledger docs/<name>.md files (milestones with bootstrap group + ambient milestone, others empty), under <root>/docs/.
    
    === COORDINATION ===
    G18 PART 2 (status: planned, not yet built) extends THIS SAME @cq/config parser for `planners` (toml whitelist + CqConfig + resolvePlanners + get_planners tool). G20's [webui] touches the same parser files (toml.ts/config.ts/types.ts) — must coordinate/sequence to avoid conflicting edits. G15 already built the cq.toml [aliases]+reviewers parser; G18 PART1 merged cq-config into the ledger MCP (no standalone server).
- sessionLogs: ["docs/logs/20260606-104144-a7535a8456c8bf94d.md"]
