---
ledger: reviews
counters:
  milestone: 0
  item: 167
archives:
  - id: M5
    path: ./archive/reviews/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
    title: "Dogfood: implement-flow smoke test"
    status: done
  - id: M6
    path: ./archive/reviews/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
    title: "UI/schema follow-up: archives, milestone grouping, TUI table, reviews summary"
    status: done
  - id: M7
    path: ./archive/reviews/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
    title: investigate:* flow — research-loop-style defect investigation assets
    status: done
  - id: M8
    path: ./archive/reviews/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
    title: defect-awareness in plan:* and implement:* prompts
    status: done
  - id: M9
    path: ./archive/reviews/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
    title: defect/hypothesis relationship views in TUI + web (Full scope, Q28)
    status: done
  - id: M12
    path: ./archive/reviews/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
    title: "G2-W1: Shared status→color foundation (revise bucket + graph colorization)"
    status: done
  - id: M13
    path: ./archive/reviews/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
    title: "G2-W2: Questions UX (field order + suggestions-as-list)"
    status: done
  - id: M16
    path: ./archive/reviews/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
    title: "G3-B: never auto-close goals (prompt edits)"
    status: done
  - id: M17
    path: ./archive/reviews/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
    title: "G3-A: auto-investigate from plan:* (prompt edits + K8 supersession)"
    status: done
  - id: M19
    path: ./archive/reviews/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
    title: "G2 follow-up: per-suggestion pick-as-answer + disable answer-fill when typing (#14-#15)"
    status: done
  - id: M14
    path: ./archive/reviews/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/reviews/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M22
    path: ./archive/reviews/M22.md
    summary: G4-W D2 backup-and-reinit — COMPLETE. T94 backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant, fresh canonical + WARNING); T95 init() !schemasEqual branch → backup-and-reinit by default + onSchemaDivergence:'abort' opt-out; T96 tests (divergence/abort/no-divergence/empty-dir) + abort-suite migration; T97 repo gate. Defect D2 RESOLVED. Reviews R80/R85/R89/R91. Shipped on main; check 661.
    title: "G4-W: D2 backup-and-reinit on ledger schema divergence"
    status: done
  - id: M24
    path: ./archive/reviews/M24.md
    summary: G5 Fix Unit A @cq/ledger packaging — COMPLETE. T98 realigned package.json main+exports → ./dist/src/* (consistent w/ ./columns); T99 browser-safe ./constants subpath export + web tsconfig paths; T100 App.tsx consumes @cq/ledger/constants, deletes MILESTONE_STATUS_SCHEMA dup; T101 package-exports.test.ts (asserts all export targets exist post-build). Defects D3 + D6 RESOLVED. Reviews R81/R86/R87/R88. Shipped on main.
    title: G5 Fix Unit A — @cq/ledger packaging (D3 + D6)
    status: done
  - id: M25
    path: ./archive/reviews/M25.md
    summary: G5 Fix Unit B column eligibility — COMPLETE. T102 added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence) + first columns.test.ts; suggestedModel still eligible. Defect D4 RESOLVED. Review R82. Shipped on main.
    title: G5 Fix Unit B — column eligibility (D4)
    status: done
  - id: M26
    path: ./archive/reviews/M26.md
    summary: "G5 Fix Unit C archived-head status badge — COMPLETE. T104 passes archived pointer status as milestoneStatus to the archived MilestoneSubsection (empty-status guarded) → T80 badge renders for archived heads; happy-dom test. T103 withdrawn (R77: no @cq/shared wire mirror — T91's ArchivePointer.status flows over the wire as-is). Defect D5 RESOLVED. Review R92. Shipped on main; check 661."
    title: G5 Fix Unit C — archived-head status badge (D5)
    status: done
  - id: M21
    path: ./archive/reviews/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
  - id: M30
    path: ./archive/reviews/M30.md
    summary: "G7 fixes COMPLETE — six confirmed dogfood defects fixed + merged. T110 (D16: backfill non-milestones archive-pointer titles from docs/archive/milestones/<id>.md by id; 48f4e93). T111 (D14: spawnWithFreePort retry-on-EADDRINUSE closes the bind-then-close TOCTOU; 6e223bb). T112 (D15: bounded wait-for de-flakes the live-badge test; 40385f6). T113 (D17: removed archived badge from row id cell; 1dec462). T114 (D18: per-suggestion pick buttons in the batch answer modal; ae0e5f8). T115 (D19: batch modal closes on open-set drain; 051fb27). Reviews R105-R110 (all go-ahead). Decision K19. Defects D14-D19 resolved. Final integration check 696 pass / 0 fail. Seeded + driven by the simulated /advance pipeline."
    title: "G7 fixes: confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M15
    path: ./archive/reviews/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M20
    path: ./archive/reviews/M20.md
    summary: G4 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G4 (D2 backup-and-reinit on schema divergence) done; work milestone M22 archived; decision K15; reviews R75/R76. D2 resolved.
    title: "Plan: fix D2 — graceful backup-and-reinit on ledger schema divergence"
    status: done
  - id: M23
    path: ./archive/reviews/M23.md
    summary: G5 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G5 (@cq/ledger packaging + UI-eligibility defects D3-D6) done; work milestones M24/M25/M26 archived; decision K16; reviews R77/R78. D3-D6 resolved.
    title: "Plan: @cq/ledger packaging + UI-eligibility defect cleanup (D3-D6)"
    status: done
  - id: M28
    path: ./archive/reviews/M28.md
    summary: G6 work milestone M28 — COMPLETE (auto-archived by the milestone-completion rule). Tasks T105 (D9), T106 (D10), T107 (D11), T108+T109 (D12) done; defects D9/D10/D11/D12 + the out-of-scope D14/D15/D16/D17 all resolved (via G7/M30); reviews R98-R102. Decisions K17/K18. Integration green.
    title: "G6 fixes: D9 test flake, D10 store parity, D11 sticky toolbar"
    status: done
  - id: M31
    path: ./archive/reviews/M31.md
    summary: "G6 #2/#4B — COMPLETE. T125 (authored llm/commands/advance.md universal sequencer), T126 (wired into link-prompts.ts + committed .codex/prompts/advance.md symlink), T127 (implement worker cap N=4→8), T128 (factored milestone auto-close+archive sweep predicate in advance.md + implement/advance.md), T129 (one-shot backlog sweep: archived M15/M20/M23/M28; guard-skipped M10/M11/M29/M27/M32/M33). Reviews R119/R122/R123/R124. Integration green."
    title: "G6 #2/#4B — universal /advance command, parallelism bump (N=4→8), milestone auto-close+archive sweep"
    status: done
  - id: M36
    path: ./archive/reviews/M36.md
    summary: "G8 fix — COMPLETE. T130 (bfa70ed): de-flaked the ledger-tui ink-testing-library suite (fixed-tick→poll-until-condition across all flaky sites; navMemo T85 explicit timeout + reduced N; settle-then-assert for negative inert-key tests) → deterministic full-suite `bun run check` (725/0). T131 (8c33435): reset()/backupAndReinit now back up + unlink non-canonical ledger .md files and remove their FTS docs (no orphans/stale index). Reviews R127/R128. Decision K21. Defects D20+D21 resolved; residuals D22 (s-test vacuity, low) + D23 (advance()-helper flake, medium) filed."
    title: "G8 fix: D20 ledger-tui test flakiness + D21 reset non-canonical ledgers"
    status: done
  - id: M38
    path: ./archive/reviews/M38.md
    summary: "G10 work milestone — COMPLETE. T132 (6bd6623): enabled ink incrementalRendering via exported TUI_RENDER_OPTIONS in ledger-tui/src/main.tsx → ~53% per-move stdout-write reduction (D13). T134 (effbd60): advance() test-helper deadline 1500→4000ms + 20_000ms per-test timeout (D23). T133 (bbbfb44): deterministic per-move byte-count regression guard navRenderBytes.test.tsx (negative-control verified). T135: no-op (UX defer not needed). Reviews R132/R133/R134 go-ahead. Defects D13+D23 resolved. bun run check green 728/0."
    title: G10 fix work — D13 TUI nav-perf memo boundaries + D23 multi-step-form test flake (file-disjoint, parallel-safe)
    status: done
  - id: M1
    path: ./archive/reviews/M1.md
    summary: G1 coordination — COMPLETE. Goal G1 (build the /implement:* command family) done; work milestones M3/M6/M7/M8/M9 archived; clarifying questions answered, reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: /implement:* command family"
    status: done
  - id: M10
    path: ./archive/reviews/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/reviews/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M29
    path: ./archive/reviews/M29.md
    summary: G7 coordination — COMPLETE. Goal G7 (fix confirmed dogfood UI/store defects D14-D19) done; work milestone M30 archived; defects D14-D19 resolved; reviews + approval decision (K19) terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M32
    path: ./archive/reviews/M32.md
    summary: "G6 #3 work milestone — COMPLETE. ledger-mcp --reset (backup-first whole-tree reset) shipped; tasks T123/T131 done; defect D21 (reset ignored non-canonical ledgers) resolved; reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #3 — ledger-mcp --reset command (backup-first whole-tree reset)"
    status: done
  - id: M33
    path: ./archive/reviews/M33.md
    summary: "G6 #4A work milestone — COMPLETE. Formal defect-lifecycle states (open/wip/root-caused/inconclusive/resolved/wontfix) landed in @cq/ledger CANONICAL_LEDGERS + investigate/plan/implement flow prompts; live open-defect migration done; tasks + reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #4A — formal defect-lifecycle states (root-caused/inconclusive) across schema + flow prompts"
    status: done
  - id: M35
    path: ./archive/reviews/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
  - id: M41
    path: ./archive/reviews/M41.md
    summary: "G12 work milestone — COMPLETE. T136 (b8df1c6): made the 's'-key-inert archived-item test regression-sensitive (content-pane '[archived · read-only]' badge-present + content-pane-scoped picker-absence), resolving D24 (ex-D22). Review R141 go-ahead. Integration check green 783/0. G12 goal is `planned` and ready for the user to close."
    title: "G12 fix: regression-sensitive 's'-key-inert archived-item test (D24)"
    status: done
  - id: M42
    path: ./archive/reviews/M42.md
    summary: G11 W1 (@cq/ledger schema + store foundations) — COMPLETE. T137 handoffs CANONICAL_LEDGERS entry (idPrefix HO, all-terminal); T138 sessionLogs:string[] on 6 work-producing schemas; T139/T140 fts (status:open OR status:wip) adjudicated GREEN (usage artifact, docs-only); T141 reopenItem + group-keyed unarchiveItem (both stores); T142 projectCompact + paginate (strips grounding/recommendation/suggestions); T143 cross-ledger snapshot(). Reviews R142-R147 go-ahead. Shipped on main.
    title: G11 W1 — @cq/ledger schema + store foundations
    status: done
  - id: M43
    path: ./archive/reviews/M43.md
    summary: G11 W2 (@cq/ledger-mcp tool surface) — COMPLETE. T144 fetch_ledger compact/offset/limit params (fixes 51.8KB/142.7KB overflow); T145 snapshot tool; T146 reopen_item + unarchive_item; T147 read_log (bounded, root-confined); T148 tool-count reconciliation (14→18 across all refs); T149 query-language doc clarifications. Reviews R148-R153 go-ahead. Out-of-scope defects D25/D26 filed here, both later resolved (G13). Shipped on main.
    title: G11 W2 — @cq/ledger-mcp tool surface
    status: done
  - id: M44
    path: ./archive/reviews/M44.md
    summary: G11 W3 (@cq/ledger-web HoldButton + sessionLogs viewer) — COMPLETE. T150 reusable HoldButton (HOLD_MS=1000, pointer+keyboard hold-to-confirm, progress bar, injectable HoldClock); T151 all 10 state-mutating web buttons hold-gated; T152 sessionLogs rendered as clickable links → popup via read_log MCP tool. Reviews R154/R157/R160 go-ahead (T151 r0 missed the 2 quick-transition buttons, fixed r1). Recovered a partial-cherry-pick of T151 during merge-back. Shipped on main.
    title: G11 W3 — @cq/ledger-web HoldButton + sessionLogs viewer
    status: done
  - id: M45
    path: ./archive/reviews/M45.md
    summary: G11 W4 (flow-prompt wiring) — COMPLETE. T153 advance.md §Provenance permits the single run-level handoffs write; T154 per-flow handoff writes with contextual /advance suppression; T155 sessionLogs population in each outcome write; T156 snapshot-first /advance bootstrap recipe. Reviews R155/R156/R158/R159 go-ahead (T154 r0 used an env var, fixed r1 → contextual). Out-of-scope defect D27 filed here, later resolved (G13). Docs/prompt-only. Shipped on main.
    title: G11 W4 — flow-prompt wiring (handoff writes + bootstrap recipe + docs)
    status: done
  - id: M46
    path: ./archive/reviews/M46.md
    summary: "G11 W5 (integration verification) — COMPLETE. T157 verification-only gate: bun run check green 847/0 on main (697aec8); bun.lock unchanged → no flake FOD refresh; all 5 ergonomics wins demonstrated via passing tests (snapshot one-call, fetch_ledger compact no-overflow, reopen/unarchive recovery, handoffs bootstrap, web hold-gate+sessionLogs popup). Review R161 go-ahead. G11 fully built (21 tasks); goal planned, ready for the user to close."
    title: G11 W5 — integration verification (bun run check)
    status: done
  - id: M48
    path: ./archive/reviews/M48.md
    summary: "G13 fix work (D25/D26/D27 G11 follow-up cleanup) — COMPLETE. T158 (D26): readLog symlink-escape hardening (realpath both target+root); T159 (D25): removed stale eslint-disable; T160 (D27): reworded CHAINED handoff trigger + made start/follow-up wrappers the single handoff writer (7 files). Reviews R163/R164/R165 go-ahead (T158/T160 each r0 disapprove→r1 approve). H15/H16/H18 confirmed. Defects D25/D26 resolved (also D28 filed here from T158 review, resolved via G14). Merged 311b8a1."
    title: "G13 fix tasks: D25/D26/D27 code-quality cleanup"
    status: done
  - id: M50
    path: ./archive/reviews/M50.md
    summary: "G14 fix work (D28 readLog TOCTOU) — COMPLETE. T161: readLog now reads the validated canonical path (fs.readFile(real ?? resolved)) instead of the symlink-bearing resolved, closing the check-then-read TOCTOU; ENOENT unmasked. Deterministic TOCTOU regression test (spies fs.realpath to swap the target at the check→use boundary; verified to fail against the pre-fix read). Review R167 go-ahead (r0 disapprove: non-discriminating test → r1 made it fail against pre-fix code). Defect D28 resolved. Merged 537017f."
    title: Close D28 readLog check-then-read TOCTOU (read validated canonical path)
    status: done
---

# reviews

## M37

### R129 — revise

- createdAt: 2026-06-03T10:31:46.684Z
- updatedAt: 2026-06-03T10:31:46.684Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- criticism: ["VERDICT (revise): D23 fix (T134) is sound, grounded, correctly scoped; D13 fix (T132/T133) has a fix-to-symptom gap — as specified, neither the React.memo boundaries nor useMemo([text]) reduces the per-cursor-MOVE cost the user reported, and the acceptance/regression guard are confounded by constant-text fixtures. File-disjoint (Unit A src vs Unit B test app.test.tsx) and T133 dependsOn:[T132] are correct. Four in-scope plan defects below; no user questions required.","D13 fix-to-symptom gap (T132 leg 1, the 'HIGHEST LEVERAGE'): the symptom is latency per cursor MOVE. On a real move the selected item changes, so the markdown `text` changes, so useMemo(()=>parseBlocks(text),[text]) (a one-slot memo) MISSES every move and re-parses. The investigation bench debug/20260603-101700-d13-navperf.tsx confounds this: makeItems(n,desc) (lines 67-82) gives EVERY item the SAME description (LONG_MD), so in the bench the memo hits across moves and the amplifier appears removed — but in production adjacent items have DIFFERENT markdown, where the one-slot memo gives no per-move benefit. T132 must either reframe leg 1 as a text-keyed bounded (LRU) parse cache so toggling/adjacent navigation actually hits, or explicitly drop the claim that it removes the measured per-move markdown amplifier.","D13 React.memo legs (T132 leg 2) do not address the per-move path: on a cursor move `cur` changes (ContentPane.row prop) and top.cursor changes (ScrollList.cursor prop, app.tsx:1002), so React.memo CANNOT skip re-rendering either component on a move — by construction both must re-render to show the new selection/highlight. React.memo only skips when App re-renders while selection is STABLE (overlay open/close, async data arrival, connErr). T132 must state which scenario each memo boundary targets and stop claiming it reduces per-cursor-move latency. Also: ScrollList receives inline getLabel/renderLabel closures (app.tsx:981-1001) recreated every render, so React.memo on ScrollList is inert unless those props are memoized — add memoizing them as required work in T132.","T132 acceptance is vacuous for the reported symptom: 'a pure cursor move no longer re-parses unchanged markdown' — on a move the markdown is the NEW item's, so 'unchanged markdown' never applies to a move. It does not verify per-move latency reduction. Replace with an operational, N-independent per-move criterion: assert per-move parseBlocks/ContentPane invocation counts and/or wall-clock do not grow when navigating across items with DISTINCT long markdown, against a target derived from the existing bench (e.g. long-md per-move ≈ empty-desc per-move).","T133 regression guard risks reproducing the bench artifact: it must give each item DISTINCT long-markdown (not a shared constant, as navMemo.test.tsx and the bench do), else the guard passes via constant-text memo hits while real navigation stays slow. Specify: distinct per-item markdown; instrument parseBlocks via a module-global counter + reset mirroring derivationCounters/resetDerivationCounters already exported from app.js (navMemo.test.tsx:26,155,170); assert on the production navigation pattern (move BETWEEN items, not re-select one). Correction: T133's parseBlocks instrumentation hook lands in markdownText.tsx, which T132 also edits — so T133 is NOT 'test-only / file-disjoint' as its scope note states; the dependsOn:[T132] ordering already covers the conflict, just fix the scope note."]
- new_questions: []
- ledgerRefs: ["goals:G10"]

### R130 — revise

- createdAt: 2026-06-03T10:42:35.569Z
- updatedAt: 2026-06-03T10:42:35.569Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: "All four R129 criticisms resolved; plan is fine-grained, sequenced, grounded, complete. One in-scope feasibility correction on T132: ink 7.0.5 (pinned) does NOT ship the incrementalRendering option that T132's leading direction (1) names."
- new_questions: []
- criticism: ["T132 direction (1) 'enable ink INCREMENTAL rendering' names an option the PINNED ink version does not have. Verified against upstream: the render() `incrementalRendering` option was added by ink PR #781, merged to master 2025-11-12 as an opt-in feature, and is NOT present in ink 7.0.5 (the version in packages/ledger-tui/package.json, released long before that PR). T132 correctly hedges ('check the installed ink version's render() signature + options in node_modules before assuming an API'), so this is not a blocker — but as written the HEADLINE and the leading/'HIGHEST LEVERAGE' direction of the central task both lead with an unavailable API, which risks a wasted implement cycle or an unrequested ink dependency bump (a bun.lock + FOD-hash change per CLAUDE.md). Fix: record the version reality in T132 and either (a) promote direction (2) — clamp the laid-out detail content — to the primary non-UX direction (it is independently verified feasible: ContentPane at app.tsx:1412-1414 renders ALL fields/blocks then scrolls via marginTop={-clamped} with overflow=hidden, so yoga DOES lay out every offscreen detail line regardless of the visible clamp), or (b) scope an ink upgrade to a version that ships incrementalRendering as its OWN explicit step (dependency change + FOD-hash refresh), not folded silently into T132.","T133 acceptance permits a pure wall-clock per-move threshold ('wall-clock and/or instrumented redraw/render counts'). A wall-clock-only assertion is contention-sensitive and would reintroduce exactly the D20/D23 timing-flake class this same goal is fixing (T134). Tighten T133 to REQUIRE an instrumented render/redraw-count assertion (the derivationCounters/resetDerivationCounters idiom already exported from app.js) as the regression signal, with wall-clock numbers reported for context only — not used as the pass/fail gate."]
- ledgerRefs: ["goals:G10"]

### R131 — go-ahead

- createdAt: 2026-06-03T10:46:36.227Z
- updatedAt: 2026-06-03T10:46:36.227Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: Both R130 criticisms resolved; revised plan is fine-grained, sequenced, testable, grounded (all citations verified against source), and complete — ready to build.
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G10"]

## M39

### R135 — revise

- createdAt: 2026-06-03T15:18:45.206Z
- updatedAt: 2026-06-03T15:18:45.206Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: T136 is correctly scoped (test-only) and citation-accurate, but its acceptance offers an unsound assertion path — a whole-frame '› '-absent check — that can never pass because the list-pane cursor always renders '› '; require content-pane scoping.
- new_questions: []
- criticism: ["T136 acceptance offers two assertion paths joined by 'AND/OR', and one of them is INCORRECT: 'assert \"› \" absent from the whole frame'. The list-pane SelectList renders \"› \" for the SELECTED row (app.tsx:1294, `sel ? \"› \" : \"  \"`); in this test the cursor sits on the archived row after A+DOWN, so the list pane always renders \"› archived task\" and \"› \" is present in the whole frame INDEPENDENT of whether the status overlay opened. The test file itself documents this exact trap — the listSide() helper (app.test.tsx L1257-1263) exists precisely because 'a substring check against the whole frame cannot tell a list COLUMN apart from a detail FIELD'. Consequently a whole-frame '› '-absent assertion FAILS even with the !cursorInArchive guard correctly in place (it is red on a CORRECT codebase, never passes) — the opposite of regression-sensitive, and it would also fail acceptance step 2 ('with the guard restored, the test passes'). FIX: T136 must REQUIRE that any '› '-absence assertion be CONTENT-PANE-SCOPED (slice the content pane — the complement of listSide, the text to the RIGHT of the second '│' — and assert '› ' absent there), OR drop the '› '-absence path entirely and assert only the read-only badge '[archived · read-only]' (app.tsx:1424) PRESENT. The badge path is verified sound and regression-sensitive: contentEl always renders ContentPane with readOnly={cursorInArchive} (app.tsx:1012-1021) so the badge shows whenever the cursor is on an archived row regardless of focus, while opening the status overlay swaps the content-pane Box to <Overlays/> (app.tsx:1071-1073), removing the badge — exactly mirroring the proven 'e'-inert test (app.test.tsx:1008). Remove the misleading parenthetical 'or assert › absent from the whole frame (the archived read-only content pane renders no SelectList)': it is true of the content pane but ignores the list-pane cursor."]
- ledgerRefs: ["goals:G12"]

### R136 — go-ahead

- createdAt: 2026-06-03T15:21:23.794Z
- updatedAt: 2026-06-03T15:21:23.794Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: "T136 (revised) resolves R135: PRIMARY assertion = '[archived · read-only]' badge PRESENT is regression-sensitive (overlay swaps content-pane Box, removing badge), any '› '-absence is content-pane-scoped, whole-frame '› '-absent is explicitly FORBIDDEN; all citations verified against source; test-only, red/green + bun run check."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G12"]

## M40

### R137 — revise

- createdAt: 2026-06-03T15:31:39.298Z
- updatedAt: 2026-06-03T15:31:39.298Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: Plan is complete vs Q74-Q87 and well-grounded, but the unarchive design (T141/T146) is mis-grounded against the milestone-group-keyed archive layout, and four same-file tasks run DAG-parallel (ledgerTools.ts T144-T147; App.tsx T151/T152; advance.md T153/T156) violating implement-flow parallel-safety.
- new_questions: []
- criticism: ["T141/T146 unarchiveItem is mis-grounded. The plan specifies unarchiveItem(ledger,itemId) restoring 'from ./archive/<ledger>/<id>.md' treating <id> as the ITEM id. But FsLedgerStore archives non-milestones ledgers as a milestone-GROUP file keyed by MILESTONE id (./docs/archive/<ledger>/<milestoneId>.md, confirmed in FsLedgerStore.ts:7 and the archive_milestone tool description ledgerTools.ts:365); only the milestones ledger has per-item archive files. The actual D22 footgun (evidence #5) was a defects item swept inside its milestone-group archive. So 'restore one item by item-id' has no per-item file to read — the op must locate the group archive containing the item, extract that single item, re-attach it to the active ledger, and decide the fate of the remaining group + the archive pointer. Re-specify T141/T146 against the group-keyed layout (e.g. a signature carrying the milestone-id, or scanning group files), and update T141's acceptance and the dual-tests accordingly. The reopen-terminal half of T141 is correctly grounded and unaffected.","File-collision / parallel-safety: T144,T145,T146,T147 all edit packages/ledger/src/mcp/ledgerTools.ts but have NO mutual dependsOn (each depends only on a distinct W1 helper). Under the implement flow's isolated-worktree parallel execution these four workers will edit the same file concurrently and clobber on merge-back. Serialize them via a dependsOn chain (or collapse into fewer tasks) so the shared ledgerTools.ts edits are not concurrent.","File-collision: T151 (apply HoldButton to all buttons in App.tsx) and T152 (render sessionLogs popup in App.tsx) both edit packages/ledger-web/src/App.tsx with no dependsOn between them (T151->T150, T152->T147). They are DAG-parallel on the same file. Add a dependsOn edge (e.g. T152 dependsOn T151) or otherwise serialize the two App.tsx edits.","File-collision: T153 (amend advance.md §Provenance) and T156 (add the snapshot-first bootstrap recipe to advance.md) both edit llm/commands/advance.md with no dependsOn between them (T153->T137, T156->T145). Serialize them (e.g. T156 dependsOn T153) so the two advance.md edits do not run concurrently. T154 already serializes after T153 and touches different files (plan/implement/investigate prompts) — fine.","T142/T144 projection completeness: the grounding's LONG_FIELD_DENYLIST (columns.ts:35-47) does NOT include the goals 'grounding' field, yet evidence #2 names the goals ledger as a primary cause of the 51.8KB overflow and the GOALS_SCHEMA 'grounding' field holds a large per-goal repo-grounding blob. Reusing LONG_FIELD_DENYLIST verbatim will NOT strip 'grounding', so compact fetch_ledger over goals may still overflow — defeating the motivating fix and contradicting T144's own acceptance ('the previously-overflowing goals/questions ledgers fit'). Either extend the projection set used by projectCompact to include 'grounding' (and verify other large non-denylisted fields), or make T142/T144 acceptance prove the goals ledger fits under the token limit with grounding stripped.","T147 read_log confinement root is underspecified. The tool must confine reads to <root>/docs/logs, but the LedgerStore interface exposes no root/cwd accessor and the InMemoryLedgerStore (the dual-tests dummy the plan names) has no filesystem. Specify where read_log obtains its confinement root (e.g. an explicit root passed to the tool factory, distinct from the store) and how the traversal-rejection + truncation tests run when the store is the in-memory dummy; as written T147's dual-tests acceptance is not realizable against the in-memory store."]
- ledgerRefs: ["goals:G11"]

### R138 — revise

- createdAt: 2026-06-03T15:38:07.312Z
- updatedAt: 2026-06-03T15:38:07.312Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: All six R137 criticisms resolved and correctly re-grounded, but the same-file parallel-safety invariant was applied only to the three files R137 named — two NEW un-serialized same-file collisions remain (T141<->T143 on the LedgerStore trio; T148<->T149 on ledger-mcp/main.ts).
- new_questions: []
- criticism: ["File-collision (same class as R137 #2, newly surfaced): T141 (reopenItem+unarchiveItem on the LedgerStore interface — edits packages/ledger/src/store/LedgerStore.ts + FsLedgerStore.ts + InMemoryLedgerStore.ts) and T143 (cross-ledger snapshot, specified as 'a single store-level method (e.g. snapshot())' built on the store, which lands the new method in the SAME three files) are BOTH W1 roots with NO mutual dependsOn, so they are concurrently DAG-ready and will edit LedgerStore.ts/FsLedgerStore.ts/InMemoryLedgerStore.ts in parallel isolated worktrees and clobber on merge-back. Resolve by either serializing them (e.g. T143 dependsOn T141) or re-specifying T143's snapshot as a free function over the public store interface (snapshot(store)) in its OWN file and stating that explicitly so it shares no file with T141. T142 (projectCompact) is described as a pure isolation-testable helper not touching columns.ts/the store — confirm it lands in its own module (not the store trio); if it instead adds a store method it joins this same collision and must also be ordered.","File-collision (same class as R137 #2, newly surfaced): T148 (update the '14 tools' count comment + LEDGER_TOOL_NAMES + tests — edits packages/ledger-mcp/src/main.ts) and T149 (clarify SERVER_INSTRUCTIONS query-language docs — also edits packages/ledger-mcp/src/main.ts, the SERVER_INSTRUCTIONS string at main.ts:164) BOTH edit packages/ledger-mcp/src/main.ts but have NO mutual dependsOn. Their dep-sets differ (T148 dependsOn T144-T147; T149 dependsOn T140,T144,T145), so T149 becomes ready before T148 and the implement flow can dispatch them in overlapping ready-waves, clobbering main.ts on merge-back. Add a dependsOn edge between them (e.g. T148 dependsOn T149, since T149's instruction edit is independent of the tool-count sweep) so the two main.ts edits are serialized."]
- ledgerRefs: ["goals:G11"]

### R139 — revise

- createdAt: 2026-06-03T15:43:46.135Z
- updatedAt: 2026-06-03T15:43:46.135Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: "R138's two collisions fixed (T143->T141, T148->T149) and T155 narrowed off advance.md correctly; projection now strips grounding/recommendation/suggestions; DAG acyclic. But the full sweep missed a THIRD same-file collision of the same class: T149 also edits ledgerTools.ts (fts_search + snapshot + fetch_ledger tool descriptions) yet forks parallel to T146/T147, which is left un-serialized."
- new_questions: []
- criticism: ["File-collision (same class as R137 #2 / R138, still un-serialized): T149 edits THREE files, not two. Its description amends QUERY_LANGUAGE_HELP (query.ts), SERVER_INSTRUCTIONS (main.ts:164), AND the fts_search tool description plus the new snapshot/fetch_ledger-compact tool descriptions — all three of which live in packages/ledger/src/mcp/ledgerTools.ts (QUERY_LANGUAGE_HELP is imported there at ledgerTools.ts:34 and every per-tool description string is constructed in that file's tool factory). The planner serialized the ledgerTools.ts write-chain as T144->T145->T146->T147 and serialized T149 only against main.ts (T148 dependsOn T149) and query.ts (T139->T140->T149) — but DID NOT place T149 in the ledgerTools.ts chain. T149 dependsOn {T140, T144, T145}, so it becomes ready right after T145 and runs DAG-parallel to T146 (dependsOn {T141, T145}) and T147 (dependsOn T146), both of which also edit ledgerTools.ts. After T145 merges, T146 and T149 are co-ready; after T146 merges, T147 and T149 can be co-ready. Two isolated-worktree workers (T149 and T146/T147) will then edit ledgerTools.ts concurrently and clobber on merge-back — the exact parallel-safety invariant R137 #2 and R138 enforce for every other shared file. The planner's reported file->task grouping classified T149 as a main.ts/query.ts task only and omitted it from the ledgerTools.ts group, which is why the sweep missed it. FIX: serialize T149 against the tail of the ledgerTools.ts chain, e.g. add T149 dependsOn T147 (T149 keeps its T140/T144/T145 deps; placing it after T147 puts it strictly after the whole T144->T145->T146->T147 chain). T148 already dependsOn T149, so T148 still trails correctly and the main.ts pair stays serialized; the only effect is that the ledgerTools.ts edits become strictly sequential. Update T149's acceptance/sequencing note to record that it edits ledgerTools.ts tool descriptions and is the last writer in that file's chain."]
- ledgerRefs: ["goals:G11"]

### R140 — go-ahead

- createdAt: 2026-06-03T15:47:47.514Z
- updatedAt: 2026-06-03T15:47:47.514Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: "4th pass: R139's fix applied (T149 dependsOn T147) — ledgerTools.ts chain T144->T145->T146->T147->T149 is now total; all shared-file task pairs verified totally ordered; DAG acyclic; R137/R138/R139 fixes intact; plan complete + faithful to Q74-Q87."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G11"]

## M47

### R162 — go-ahead

- createdAt: 2026-06-03T20:09:39.421Z
- updatedAt: 2026-06-03T20:09:39.421Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: "G13/M48 plan is fine-grained, parallel, testable, grounded: all 3 fix tasks (T158/T159/T160) correctly scope+accept their confirmed root causes (D26 realpath reproduce-first w/ ENOENT carve-out, D25 stale eslint-disable removal, D27 CHAINED-trigger reword), each ledgerRefs defects:D<n>+goals:G13, and the disjoint file scopes justify the no-dependsOn parallel DAG. Verified all 3 defect locations against the repo. No revisions needed."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G13"]

## M49

### R166 — go-ahead

- createdAt: 2026-06-03T20:44:17.656Z
- updatedAt: 2026-06-03T20:44:17.656Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- summary: "G14/M50 plan go-ahead, round 0. Single fine-grained task T161 closes the confirmed D28 check-then-read TOCTOU: read `real ?? resolved` (validated canonical, no symlink components) instead of the symlink-bearing `resolved` at FsLedgerStore.ts L1296. Verified against source L1251-1302 — fix correctly closes the race (read-path === validated-path); ENOENT preserved (realpath ENOENT swallowed at L1290-1294 leaves hoisted `let real` undefined → reads `resolved` → genuine not-found surfaces, not masked); escape-rejection LedgerError still rethrows (code undefined). Acceptance is reproduction-first (regression test must FAIL pre-fix) and requires the D26 escape-rejection + symlinked-root + ENOENT suite stay green + bun run check. ledgerRefs defects:D28+goals:G14 correct for orchestrator-owned closure (D28.dependsOn=[T161] reciprocates). Scope surgical (~2-3 lines + one test, one file), no over-reach, no missing prerequisite (T158/D26 realpath re-assert already merged on main). No user-only gaps, no planner-fixable defects, no out-of-scope faults."
- criticism: []
- new_questions: []
- ledgerRefs: ["goals:G14"]
