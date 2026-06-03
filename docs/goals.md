---
ledger: goals
counters:
  milestone: 0
  item: 12
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
