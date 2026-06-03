---
ledger: milestones
counters:
  milestone: 0
  item: 30
archives:
  - id: M5
    path: ./archive/milestones/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
    title: ""
    status: ""
  - id: M2
    path: ./archive/milestones/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: ""
    status: ""
  - id: M3
    path: ./archive/milestones/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: ""
    status: ""
  - id: M4
    path: ./archive/milestones/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: ""
    status: ""
  - id: M6
    path: ./archive/milestones/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
    title: ""
    status: ""
  - id: M7
    path: ./archive/milestones/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
    title: ""
    status: ""
  - id: M8
    path: ./archive/milestones/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
    title: ""
    status: ""
  - id: M9
    path: ./archive/milestones/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
    title: ""
    status: ""
  - id: M12
    path: ./archive/milestones/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
    title: ""
    status: ""
  - id: M13
    path: ./archive/milestones/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
    title: ""
    status: ""
  - id: M16
    path: ./archive/milestones/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
    title: ""
    status: ""
  - id: M17
    path: ./archive/milestones/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
    title: ""
    status: ""
  - id: M19
    path: ./archive/milestones/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
    title: ""
    status: ""
  - id: M14
    path: ./archive/milestones/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: ""
    status: ""
  - id: M18
    path: ./archive/milestones/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: ""
    status: ""
  - id: M22
    path: ./archive/milestones/M22.md
    summary: G4-W D2 backup-and-reinit — COMPLETE. T94 backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant, fresh canonical + WARNING); T95 init() !schemasEqual branch → backup-and-reinit by default + onSchemaDivergence:'abort' opt-out; T96 tests (divergence/abort/no-divergence/empty-dir) + abort-suite migration; T97 repo gate. Defect D2 RESOLVED. Reviews R80/R85/R89/R91. Shipped on main; check 661.
    title: ""
    status: ""
  - id: M24
    path: ./archive/milestones/M24.md
    summary: G5 Fix Unit A @cq/ledger packaging — COMPLETE. T98 realigned package.json main+exports → ./dist/src/* (consistent w/ ./columns); T99 browser-safe ./constants subpath export + web tsconfig paths; T100 App.tsx consumes @cq/ledger/constants, deletes MILESTONE_STATUS_SCHEMA dup; T101 package-exports.test.ts (asserts all export targets exist post-build). Defects D3 + D6 RESOLVED. Reviews R81/R86/R87/R88. Shipped on main.
    title: ""
    status: ""
  - id: M25
    path: ./archive/milestones/M25.md
    summary: G5 Fix Unit B column eligibility — COMPLETE. T102 added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence) + first columns.test.ts; suggestedModel still eligible. Defect D4 RESOLVED. Review R82. Shipped on main.
    title: ""
    status: ""
  - id: M26
    path: ./archive/milestones/M26.md
    summary: "G5 Fix Unit C archived-head status badge — COMPLETE. T104 passes archived pointer status as milestoneStatus to the archived MilestoneSubsection (empty-status guarded) → T80 badge renders for archived heads; happy-dom test. T103 withdrawn (R77: no @cq/shared wire mirror — T91's ArchivePointer.status flows over the wire as-is). Defect D5 RESOLVED. Review R92. Shipped on main; check 661."
    title: ""
    status: ""
  - id: M21
    path: ./archive/milestones/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
  - id: M30
    path: ./archive/milestones/M30.md
    summary: "G7 fixes COMPLETE — six confirmed dogfood defects fixed + merged. T110 (D16: backfill non-milestones archive-pointer titles from docs/archive/milestones/<id>.md by id; 48f4e93). T111 (D14: spawnWithFreePort retry-on-EADDRINUSE closes the bind-then-close TOCTOU; 6e223bb). T112 (D15: bounded wait-for de-flakes the live-badge test; 40385f6). T113 (D17: removed archived badge from row id cell; 1dec462). T114 (D18: per-suggestion pick buttons in the batch answer modal; ae0e5f8). T115 (D19: batch modal closes on open-set drain; 051fb27). Reviews R105-R110 (all go-ahead). Decision K19. Defects D14-D19 resolved. Final integration check 696 pass / 0 fail. Seeded + driven by the simulated /advance pipeline."
    title: "G7 fixes: confirmed dogfood UI/store defects (D14-D19)"
    status: done
---

# milestones

## active

### M-AMBIENT — open

- createdAt: 2026-06-01T19:15:33.341Z
- updatedAt: 2026-06-01T19:15:33.341Z
- title: ambient

### M1 — done

- createdAt: 2026-06-01T19:24:22.101Z
- updatedAt: 2026-06-02T22:56:35.858Z
- title: "Plan: /implement:* command family"
- description: "Coordination milestone for the goal of building the /implement:* command family (start/advance) that executes the planned roadmap: DAG-ordered task pickup, per-task worktree + implementor subagent, reviewer subagent gate, autonomous criticism loop, and user-answered questions. Groups the goal, its clarifying questions, reviews, and final approval decision. Work tasks live under separate work milestones recorded on the goal's fields.milestones."

### M10 — open

- createdAt: 2026-06-02T08:26:54.034Z
- updatedAt: 2026-06-02T08:26:54.034Z
- title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
- description: "Coordination milestone for goal G2: UI/schema enhancements for the ledger-suite frontends (TUI + web) — a follow-on to the completed G1. Groups the goal, its clarifying questions, reviews, and final approval decision. Work tasks live under separate work milestones recorded on the goal's fields.milestones during planning."

### M11 — open

- createdAt: 2026-06-02T08:36:51.936Z
- updatedAt: 2026-06-02T08:36:51.936Z
- title: "Investigate: mcp-fails-uninitialized-ledger"
- description: "Coordination milestone for investigating defect: @cq/ledger-mcp fails to connect when started in a directory with no initialized ledger; should auto-init the canonical ledger set instead. Holds the defect, its hypothesis tree, and any clarifying questions."

### M15 — open

- createdAt: 2026-06-02T09:11:53.285Z
- updatedAt: 2026-06-02T09:11:53.285Z
- title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
- description: "Coordination milestone for goal G3: prompt-suite behavior changes to the plan:*/implement:*/investigate:* command flows — (A) make plan:* investigate defects automatically (revisit K8 file-and-defer) and (B) forbid the orchestrator from auto-closing a goal. Groups the goal, its clarifying questions, reviews, and the final approval decision. Work tasks live under separate work milestones recorded on the goal's fields.milestones during planning."

### M20 — open

- createdAt: 2026-06-02T11:26:47.033Z
- updatedAt: 2026-06-02T11:26:47.033Z
- title: "Plan: fix D2 — graceful backup-and-reinit on ledger schema divergence"
- description: "Coordination milestone for the defect-seeded goal G4: fix D2 (ledger-mcp aborts with BootstrapViolationError on schema divergence) by replacing the fatal throw in FsLedgerStore.init() with backup-and-reinit. Holds the goal, its reviews, and approval decision."

### M23 — open

- createdAt: 2026-06-02T17:25:15.494Z
- updatedAt: 2026-06-02T17:25:15.494Z
- title: "Plan: @cq/ledger packaging + UI-eligibility defect cleanup (D3-D6)"

### M27 — open

- createdAt: 2026-06-02T19:51:11.686Z
- updatedAt: 2026-06-02T19:51:11.686Z
- title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"

### M28 — open

- createdAt: 2026-06-02T19:52:19.215Z
- updatedAt: 2026-06-02T19:52:19.215Z
- title: "G6 fixes: D9 test flake, D10 store parity, D11 sticky toolbar"
- description: "Work milestone for defect-seeded goal G6. Three file-disjoint, parallel-safe low-severity fix tasks: D9 (ledger-tui HTTP test-harness flake), D10 (ledger store-abstract dual-store no-partial-mutation assertion), D11 (ledger-web sticky .lw-toolbar). Gate: bun run check."

### M29 — open

- createdAt: 2026-06-02T22:48:12.040Z
- updatedAt: 2026-06-02T22:48:12.040Z
- title: "Plan: fix confirmed dogfood UI/store defects (D14-D19)"
- description: Coordination milestone for the defect-seeded goal G7 — fix the batch of confirmed/grounded defects surfaced during G6 dogfooding (D14 freePort TOCTOU, D15 ledger-tui live-badge flake, D16 non-milestones archived-title backfill gate, D17 archived-badge in id column, D18 batch modal missing pick buttons, D19 batch modal no close-on-last). Holds the goal, its reviews, and approval decision. Work tasks live under a separate work milestone.
