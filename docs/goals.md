---
ledger: goals
counters:
  milestone: 0
  item: 10
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
