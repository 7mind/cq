---
ledger: reviews
counters:
  milestone: 0
  item: 241
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
  - id: M54
    path: ./archive/reviews/M54.md
    summary: "G16/D29 fix built+merged: backend questions-answer StatusChangePrecondition (dual-store) + web/TUI empty-answer UX guards. Tasks T162/T163/T164 done, reviews R172/R174/R175 go-ahead. Integrated bun run check green 908/0. D29 resolved."
    title: D29 fix — reject empty/whitespace answer on a question's `answered` transition
    status: done
  - id: M58
    path: ./archive/reviews/M58.md
    summary: "G17/D30 fix built+merged: link-prompts.ts made import-safe + repointed 14 LINKS off the vanished llm/ root onto ../cq-assets/, hardened to throw on missing targets; cq-assets README de-staled. Tasks T179/T180/T181 done, reviews R173/R176/R177 go-ahead. D30 resolved; bun run link-prompts now produces non-dangling symlinks."
    title: "G17 fix: repoint link-prompts.ts + cq-assets README off vanished `llm/` root (D30)"
    status: done
  - id: M55
    path: ./archive/reviews/M55.md
    summary: "G15 Feature 1 (explorer two-tier RW) built+merged: investigate-explorer JSON contract extended with optional probeRequest (T165); new execution-capable investigate-prober.md agent (Bash + throwaway worktree, read+execute, local-only/no-network) (T166); prober dispatch wired into investigate/advance.md gated on probeRequest with harvest-then-discard (T167); prober registered in link-prompts.ts + README (T168). Tasks T165-T168 done, reviews go-ahead. Integrated bun run check green."
    title: G15 W1 — Explorer two-tier RW (investigate-prober)
    status: done
  - id: M56
    path: ./archive/reviews/M56.md
    summary: "G15 Feature 2 (pluggable parallel reviewers) built+merged: pi non-interactive spike confirmed (K30 invocation contract) (T169); @cq/config cq.toml parser package (T170) + cq-config MCP server exposing get_reviewers + Nix package (T171); registered in dev-llm.nix + .mcp.json (T172); shared /cq:plan-review (T173) + /cq:implement-review (T174) rubrics; reconciliation (strictest-wins+union-with-source-tags, get_reviewers MCP tool, pi shellout) wired into plan/advance.md (T175) + implement/advance.md (T176); /cq:reviewers session-only override (T177); cq.toml.example + cq/* link entries + README (T178). Tasks T169-T178 done, reviews go-ahead, K30 locked. Integrated bun run check green 930/0; all new asset symlinks resolve."
    title: G15 W2 — Pluggable parallel reviewers (cq.toml + cq-config MCP + pi shellout)
    status: done
  - id: M62
    path: ./archive/reviews/M62.md
    summary: "G18 PART 2 — pluggable parallel planners — COMPLETE. All 6 tasks done + merged to main (T12 84f1bfe @cq/config planners=[] parser/resolvePlanners; T13 7a3806d get_planners + get_config.planners on BOTH ledger-MCP surfaces, count 20→21 + drift-guard + e2e stdio; T14 6f2397e plan-advance CANDIDATE mode emitting task-DAG JSON; T15 d949db6 multi-planner generate-N-then-JUDGE+SYNTHESIS step in plan/advance.md; T16 b3278b3 commands/cq/planners.md session-only override; T17 7e403fe convergence gate — assets glob picks up planners.md, cq.toml.example planners= example, mcp__cq-config__ grep clean). Reviews R206-R211 all go-ahead (T12 + T13 each after 1 criticism round: T12 empty-test→real reproduction, T13 5 stale '20-tool' strings→21). bun run check green 931/0. Tip 7e403fe."
    title: G18 PART 2 — Pluggable parallel planners (generate-N-then-judge w/ synthesis)
    status: done
  - id: M64
    path: ./archive/reviews/M64.md
    summary: D32 fix COMPLETE. Single doc-only task T182 (commit 418b641, merged to main) repointed nix/pkg/cq-assets/README.md 'Configuration' section off the removed standalone cq-config MCP server to the ledger MCP (heading 'cq.toml and the ledger MCP'; prose attributes parsing to the @cq/config parser package + surfacing to the ledger MCP exposing get_reviewers/get_config/get_planners as mcp__ledger__*). Review R213 go-ahead. D32 resolved (orchestrator-owned closure). bun run check 931/0.
    title: Repoint cq-assets/README.md Configuration section off cq-config MCP server (D32 fix)
    status: done
  - id: M61
    path: ./archive/reviews/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M67
    path: ./archive/reviews/M67.md
    summary: G21/D31 fix — COMPLETE. T183 (reproduce-first RED happy-dom test for the press-started-inside backdrop dismiss, d073a27) + T184 (shared useBackdropDismiss hook — closes only when target===currentTarget on BOTH pointerdown/mousedown and click — wired into all three overlays batch/help/log, 99576bc). Reviews R219/R220 go-ahead. D31 RESOLVED; bun run check green 977/0 at merge. main bdd2720.
    title: G21/D31 fix — safe modal backdrop (press must start on backdrop to dismiss)
    status: done
  - id: M68
    path: ./archive/reviews/M68.md
    summary: G20 FEATURE 1 (cq.toml [webui] + ledger-web port auto-increment) — COMPLETE. T185 (swap @cq/config parser to smol-toml 1.6.1 + typed [webui] host/integer-port, whitelist preserved, G18 planners intact — 96b7031) + T186 (resolveWebOpts per-field CLI>cq.toml>default + bounded scanForPort MAX=64 EADDRINUSE-only host-immutable — f71f9b9) + T187 (main() wires loadConfig+resolveWebOpts+scanForPort, reports actual bound URL to STDOUT keeping the stderr line, + ledgerWeb @cq/config flake symlink — 0c21f43). Reviews R217/R221/R223 go-ahead (one plan revise round R215→R216). bun run check green; nix build .#ledger-web verified in T192.
    title: G20 FEATURE 1 — cq.toml [webui] + ledger-web port auto-increment (depends on G18 landing)
    status: done
  - id: M69
    path: ./archive/reviews/M69.md
    summary: "G20 FEATURE 2 (new `cq` CLI init/reset/erase) — COMPLETE. T188 (scaffold @cq/cli package + dispatcher + injectable ConfirmIo — 8f60e59) + T189 (cq init: idempotent FsLedgerStore.init-if-none, no cq.toml — da1aa82) + T190 (cq reset: relocate the wrapper off ledger-mcp via FsLedgerStore.reset+ConfirmIo, REMOVE --reset from ledger-mcp — 3d96f3c) + T191 (cq erase: bounded irreversible delete of <root>/docs + cq.toml, no path-escape, confirm-gated — e597b68) + T192 (closing gate: cqCli flake.nix derivation + apps.cq + node-modules FOD entry + consolidated hash refresh; nix build .#cq/.#node-modules/.#ledger-mcp/.#ledger-tui/.#ledger-web all green + cq bin init/reset/erase e2e — bdd2720). Reviews R218/R222/R224/R225/R226 go-ahead. bun run check green 986/0. main bdd2720."
    title: G20 FEATURE 2 — new `cq` CLI (init / reset / erase)
    status: done
  - id: M71
    path: ./archive/reviews/M71.md
    summary: "G22 parts 1-3 (web UI): T193 sidebar group-ordered nav with splitters, T194 help dialog fixed large size with internal scroll, T195 state-machine SVGs uniformly left-aligned (xMinYMid meet + width:100%). All 3 tasks done, all reviews go-ahead, bun run check green (985/0)."
    title: "G22 web UI: sidebar reorder + help fixed-size + SVG left-align (parts 1-3)"
    status: done
  - id: M72
    path: ./archive/reviews/M72.md
    summary: "G22 part 4 (cq: command renames): T196 git-mv'd advance/plan:start/investigate:start command files into commands/cq/{advance,plan,investigate}.md + rewrote in-file refs, T197 updated link-prompts.ts LINKS to cq/ paths, T198 swept all remaining cross-refs across nix/pkg (7 markdown files + 2 MCP tool-description strings) to cq:* names. All 3 tasks done, all reviews go-ahead, bun run check green (985/0)."
    title: "G22 cq: command renames (part 4) — advance/plan:start/investigate:start → cq:*"
    status: done
  - id: M76
    path: ./archive/reviews/M76.md
    summary: "G24 fix landed: computeDagLayout re-based to min-layer 0 (T199, commit e9bf762), reviewed (R239 go-ahead), bun run check green. Resolves D33's left-gap on cyclic state-machine diagrams."
    title: Fix D33 — re-base DAG layer numbering so cyclic state-machine diagrams left-align
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

## M53

### R168 — go-ahead

- createdAt: 2026-06-05T18:37:37.196Z
- updatedAt: 2026-06-05T18:38:12.427Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "G16/M54 plan go-ahead, round 0. Plan for D29 is fine-grained, correctly sequenced (T163/T164 dependsOn T162), reproduce-first, fully grounded against live source, and complete across backend dual-store + all four frontend submit paths. Verified: applyUpdateItem (core.ts:277) fires precondition(item.status,patch.status) BEFORE applying patch.fields (L281), so the questions guard must read the EFFECTIVE answer = (patch.fields?.answer ?? item.fields.answer) via closure — T162 specifies exactly this (not the mis-grounded post-patch read). Goals-only precondition wiring confirmed in BOTH FsLedgerStore.updateItem (L571-581) AND InMemoryLedgerStore.updateItem (L307-317) — both need the questions branch; T162 names both stores + dual-tests. QUESTIONS_SCHEMA.answer={type:string,required:false} (constants.ts:217), validateFields type-checks only — confirmed. Frontend anchors verified real: web submitAnswer App.tsx:2611, HoldButton:2629 (no disabled guard today), answerHasText/setAnswerHasText pattern present (2626/2635); TUI BatchAnswerOverlay app.tsx:1952 (key.return->onAnswer(row,value)), TextPrompt components/TextPrompt.tsx:32-33 (key.return->onSubmit(value)). Same-file safety: both web edits folded into T163 (R137-R139 precedent); T164's two TUI edits are different files; T163/T164 in disjoint package trees, both depend on T162 (ledger pkg, disjoint). No DAG-parallel pair shares a file. Note (not a defect): TextPrompt is a generic single-line input — the empty-guard belongs at the answer-overlay caller, not inside the shared component; T164's acceptance is correctly scoped to the answer overlay's behavior. Scope surgical (targeted precondition, not a general FieldSpec extension), no over-reach. No user-only gaps, no planner-fixable defects, no out-of-scope faults."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G16"]
- sessionLogs: ["docs/logs/20260605-183755-a10a9c55f675c1aa4.md"]

## M51

### R169 — revise

- createdAt: 2026-06-05T18:51:39.883Z
- updatedAt: 2026-06-05T18:52:31.940Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Well-grounded plan; DAG acyclic with same-file edits serialized (link-prompts.ts/README via T178->T168, package.json/cq-config via T171->T170). Revise on three planner-fixable defects: T173/T175 double-write of the reviews item in multi-reviewer mode, a stale/unverified link-prompts.ts 'llm/' source root in T168/T178, and no .mcp.json registration of cq-config for in-repo dogfooding. One confirming question on the empty-answer Q91 reconciliation semantics."
- criticism: ["T173 vs T175 contradiction (single-reviews-item invariant). T173 says 'keep native plan-reviewer.md as-is — the claude:* path still writes the reviews item directly', while T175 has each claude reviewer RETURN verdict json so the ORCHESTRATOR writes the single aggregated reviews item. In configured multi-reviewer mode these combine to produce TWO reviews items per round (the native reviewer's direct write + the orchestrator's aggregate), breaking the single-aggregated-reviews-item-per-round invariant the whole strictest-wins+union reconciliation (Q91) depends on. Resolve the 'rather than (or in addition to) writing the ledger' hedge in T175: in configured/multi-reviewer mode the native claude plan-reviewer must NOT write the reviews ledger — only the orchestrator writes the one aggregated item; the direct-write path is retained ONLY for the unconfigured single-reviewer fallback (today's behaviour). Note the implement side is already clean (implement-reviewer.md returns json and never writes the ledger — verified), so make the plan-side reconciliation symmetric to that: have the claude plan-reviewer RETURN json in configured mode.","T168 and T178 build on an unverified/stale link-prompts.ts source root. scripts/link-prompts.ts resolves every LINKS `source` as 'llm/commands/...' / 'llm/agents/...' relative to nix/pkg/cq-ledgers/, but the actual assets live under nix/pkg/cq-assets/{commands,agents}/ and the 'llm/' tree does not resolve under cq-ledgers (verified: Read of nix/pkg/cq-ledgers/llm/agents/plan-reviewer.md and llm/commands/plan/advance.md both fail with 'File does not exist' while their nix/pkg/cq-assets/ equivalents read fine). The instruction 'match existing entries source-path style exactly (do not invent a new root)' would replicate a stale/broken root, and the acceptance 'bun run link-prompts runs clean and creates the symlink' is not safely achievable if that root is wrong (symlink() succeeds for a nonexistent target, yielding a DANGLING link that Claude cannot load). T168/T178 must FIRST verify the real source root against the current tree (check whether nix/pkg/cq-ledgers/llm is a symlink to ../cq-assets or simply stale) and pin link entries to the correct path before adding the investigate-prober / cq:* entries; acceptance must assert the new symlinks resolve to existing files (e.g. `test -e` the link target), not merely that link-prompts runs.","No task registers the new cq-config MCP server in THIS repo's project-local .mcp.json. .mcp.json currently wires only the ledger server (command `nix run .#ledger-mcp`); T172 wires cq-config only into the home-manager global dev-llm.nix programs.mcp.servers registry. For an in-repo /plan:advance or /implement:advance to call the cq-config get_reviewers tool during dogfooding, the orchestrator must be able to reach that server in this repo's session. Add a .mcp.json entry for cq-config (e.g. `nix run .#cq-config-mcp`) as part of T172 (or a small dedicated task), OR explicitly state and verify that the global home-manager registration is merged into in-repo Claude sessions so get_reviewers is reachable here; as written the plan leaves the in-repo reviewer feature unreachable.","OUT-OF-SCOPE / pre-existing (file-and-defer, does NOT block this plan; recorded here because the reviews schema has no defects field): scripts/link-prompts.ts and nix/pkg/cq-assets/README.md both still reference a 'llm/' single-source tree (link-prompts.ts LINKS `source: llm/...`; README Convention + Three-consumers tables say 'llm/commands/...', 'llm/agents/...'). The asset tree was relocated to nix/pkg/cq-assets/{commands,agents}/ and assets.nix was updated to read ./commands and ./agents, but link-prompts.ts and the README were not. The 'llm/' paths do not resolve under nix/pkg/cq-ledgers/, so `bun run link-prompts` likely creates dangling symlinks today. severity: medium. suggestedFix: repoint link-prompts.ts LINKS source paths and the README tables to nix/pkg/cq-assets/..., or restore a symlink nix/pkg/cq-ledgers/llm -> ../cq-assets, then confirm bun run link-prompts produces valid (non-dangling) symlinks. The /plan:advance orchestrator should file this as an open defects item linked goals:G15 and auto-launch investigate per K12, separately from this plan."]
- new_questions: ["Q91 (reviewer-disagreement reconciliation) was left empty by the user; the planner adopted recommendation (i) — strictest-wins verdict (any reviewer's revise/disapprove blocks; go-ahead/approve requires unanimity) + UNION of all reviewers' criticism/questions/defects, each finding source-tagged. This is the conservative, safety-maximizing default and composes with the existing 'revise/disapprove requires non-empty findings' invariant, so it is a reasonable default — but please confirm strictest-wins + union-with-source-tags is the intended semantics (vs majority-vote or a designated-primary reviewer) before T175/T176 implement it, since the empty answer leaves the core behavioural decision unconfirmed."]
- ledgerRefs: ["goals:G15"]
- sessionLogs: ["docs/logs/20260605-185213-a4b0e9587bbebb6a6.md"]

### R178 — go-ahead

- createdAt: 2026-06-05T20:24:58.713Z
- updatedAt: 2026-06-05T20:25:28.373Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Re-review: all 3 R169 criticisms resolved (T173/T175 single-aggregated-write gated on mode; T168/T178 pin link sources to the verified ../cq-assets root with test -e resolve assertions, coherent with post-D30 link-prompts.ts; T172 adds .mcp.json cq-config entry). Q95 confirms strictest-wins+union-with-source-tags, matching T175/T176. Spike-first (T169) precedes pi-shellout consumers; same-file edits serialized (link-prompts.ts+README via T178->T168, package.json+cq-config via T171->T170, single writers for each advance.md and dev-llm.nix); DAG acyclic; each task carries a concrete verifiable acceptance; both features fully scoped. Coherent with current main; will not regress the D30 fix or the throw-on-missing hardening. go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G15"]
- sessionLogs: ["docs/logs/20260605-202254-ad4f65b5c798e0da1.md"]

## M57

### R170 — revise

- createdAt: 2026-06-05T19:05:43.046Z
- updatedAt: 2026-06-05T19:06:13.849Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Plan is grounded, fine-grained, correctly sequenced (reproduce-first T179→T180→T181) and complete; one planner-fixable gap: T179 must make link-prompts.ts import-safe (guard the top-level creation loop) so the test can import the real LINKS array without firing symlink side effects."
- criticism: ["T179 underspecifies the import-safety refactor. scripts/link-prompts.ts runs its symlink-CREATION loop at module top level (L56-74, a bare `for` with no `import.meta.main`/function guard). T179 requires the new test to operate on 'the SAME LINKS array the creation loop uses' — but importing the module from scripts/link-prompts.test.ts will EXECUTE that top-level loop and mutate `.claude/` at test time (and, against current `llm/` sources, may throw for the wrong reason rather than the D30 missing-target reason). Make it explicit in T179: extract LINKS + the per-link existence/check logic into importable exports and GUARD the creation loop behind `import.meta.main` (or move it into a `main()` invoked only when run as a script), so `bun test` imports the real LINKS array with zero filesystem side effects and the red failure is unambiguously the missing `llm/...` targets. Without this the implementer either duplicates the LINKS array in the test (defeating the 'same array' requirement and letting a stale source slip through undetected) or the test fails for an import-side-effect reason instead of the D30 reason."]
- ledgerRefs: ["goals:G17"]
- sessionLogs: ["docs/logs/20260605-190601-aa1442ade4288d14e.md"]

### R171 — go-ahead

- createdAt: 2026-06-05T19:08:37.036Z
- updatedAt: 2026-06-05T19:09:03.312Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "R170's sole criticism resolved: revised T179 now explicitly mandates exporting LINKS as single source of truth, extracting a side-effect-free checkLinks helper, guarding the creation loop behind import.meta.main/main(), and a reproduce-first test importing the real LINKS with ZERO .claude/ mutation that fails for the D30 missing-target reason; T180 repoints the in-place exported LINKS onto verified ../cq-assets/{commands,agents}/ and reuses checkLinks; ordering T179→T180→T181 and same-file serialization (T180 dependsOn T179, T181 dependsOn T180) hold."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G17"]
- sessionLogs: ["docs/logs/20260605-190853-aaf37e9557710bdc2.md"]

## M59

### R193 — revise

- createdAt: 2026-06-05T22:27:35.671Z
- updatedAt: 2026-06-05T22:28:21.450Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: Plan is well-grounded, fine-grained, and correctly sequenced, but T1/T2/T3/T13 only touch the Claude-SDK tool() factory (ledgerTools.ts) and miss the SECOND registration surface (stdioLedgerTools.ts) that the standalone ledger-mcp binary — the one .mcp.json/plan/implement/reviewers actually reach as mcp__ledger__* — uses; without it the new tools never surface on the real server.
- new_questions: []
- criticism: ["BLOCKER (T1, T2, T13): the ledger MCP has TWO parallel tool-registration surfaces, both keyed off LEDGER_TOOL_NAMES: (a) createLedgerMcpTools in packages/ledger/src/mcp/ledgerTools.ts (the @anthropic-ai/claude-agent-sdk tool() factory, used only by the in-process Claude-SDK host), and (b) registerLedgerStdioTools in packages/ledger/src/mcp/stdioLedgerTools.ts (raw @modelcontextprotocol/sdk server.registerTool). The STANDALONE @cq/ledger-mcp binary — which .mcp.json's `ledger` server runs (`nix run .#ledger-mcp`), and which plan/advance.md, implement/advance.md, and reviewers.md all reach as mcp__ledger__get_reviewers/get_config — goes through buildServer() -> registerLedgerStdioTools (ledger-mcp/src/main.ts:247), NOT createLedgerMcpTools. The embedded TUI (in-memory transport) and web (co-hosted HTTP via attachMcpHttp) servers ALSO route through buildServer -> registerLedgerStdioTools. T1 adds get_reviewers/get_config ONLY to ledgerTools.ts (its description and acceptance name only that file and createLedgerMcpTools); T13 adds get_planners ONLY to ledgerTools.ts. As written, the new tools surface on the in-process Claude-SDK path but NOT on the standalone/embedded stdio+HTTP binary that every consumer actually calls — PART 1's whole premise (consumers calling mcp__ledger__*) is unmet. FIX: T1 must ALSO register get_reviewers+get_config in registerLedgerStdioTools (stdioLedgerTools.ts), T13 must add get_planners there too, and the config capability must be threaded as a new param of registerLedgerStdioTools(server, store, readLog, configCapability?) — T2 already names registerLedgerStdioTools for the buildServer wiring, but no task actually adds the tool registrations to that file.","T3 (and T13) count/name bump is under-scoped to one file: stdioLedgerTools.ts ALSO documents '18 tools' (header L4-5 and the registerLedgerStdioTools doc-comment L149) and shares LEDGER_TOOL_NAMES, and per its own comment (L18) 'the schema-drift guard between the stdio path and the Claude path is the test suite' — i.e. a test asserts the two surfaces register the SAME tool set. Updating only ledgerTools.ts will leave that drift-guard / count test failing (or mask the bug by leaving BOTH files at 18). T3's and T13's acceptance must require the 18->20->21 bump AND the new tool names in BOTH ledgerTools.ts and stdioLedgerTools.ts, and the cross-surface drift-guard test green.","Minor (T8): reviewers.md carries bare 'cq-config' prose references beyond the two patterns T8's acceptance greps for ('mcp__cq-config__' and 'cq-config MCP server'): e.g. L15 '(from cq-config), falling back', L30 'Call get_config (from the cq-config MCP server)', the frontmatter `description` line ('from cq-config get_reviewers/get_config'), and L44/L147 'the cq-config server'/'(cq-config MCP)'. T8's acceptance grep should also catch the bare 'cq-config' token (or enumerate the description-line + prose hits) so no stale reference survives the repoint."]
- ledgerRefs: ["goals:G18"]
- sessionLogs: ["docs/logs/20260605-222806-a85471b82ade9e93e.md"]

### R194 — go-ahead

- createdAt: 2026-06-05T22:31:42.631Z
- updatedAt: 2026-06-05T22:32:16.345Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Round-2: all three R193 criticisms durably resolved — T1/T2/T13 now register get_reviewers/get_config/get_planners on BOTH ledgerTools.ts (createLedgerMcpTools) AND stdioLedgerTools.ts (registerLedgerStdioTools, config capability threaded as new 4th param) with T2's end-to-end STDIO-roundtrip acceptance; T3/T13 bump the 18→20→21 count + LEDGER_TOOL_NAMES in BOTH files with the cross-surface drift-guard test green (reproduce-first); T8 greps the BARE 'cq-config' token to zero. Anchors verified real (main.ts:247 buildServer→registerLedgerStdioTools, stdioLedgerTools.ts L18 drift-guard note + L155 readLog?-param signature, reviewers.md bare cq-config prose). PART 2 (Q100 generate-N-then-judge+synthesis, Q101 pi candidate-emitters, Q102 config/command/tool, same-file DAG serialization) sound. Go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G18"]
- sessionLogs: ["docs/logs/20260605-223202-a0aae2a8104718584.md"]

## M63

### R212 — go-ahead

- createdAt: 2026-06-06T00:38:47.177Z
- updatedAt: 2026-06-06T00:39:10.146Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Plan is minimal, grounded, and testable: single doc-only task T182 repoints README L77/L82-85 to the ledger MCP with operationally-pinned acceptance and correct closure links; all grounding claims verified against source."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G19","defects:D32","tasks:T182"]
- sessionLogs: ["docs/logs/20260606-003711-a5fbe5076e58e816e.md"]

## M66

### R214 — go-ahead

- createdAt: 2026-06-06T11:01:32.969Z
- updatedAt: 2026-06-06T11:02:00.907Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: Plan for G21/D31 is fine-grained, correctly sequenced (RED T183 → GREEN T184 via dependsOn), operationally testable, fully grounded against App.tsx/HoldButton.tsx, and minimal for the confirmed root cause — go-ahead.
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G21","defects:D31","tasks:T183","tasks:T184"]
- sessionLogs: ["docs/logs/20260606-105830-a50916ce5d3363686.md"]

## M65

### R215 — revise

- createdAt: 2026-06-06T11:10:50.106Z
- updatedAt: 2026-06-06T11:11:32.916Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Plan conforms to Q105-Q111 and is well-grounded against current main, but has 3 fixable defects: a same-file DAG-parallel collision (T189/T190/T191 all edit cq-cli/main.ts under only dependsOn:[T188]), a missing FOD-refresh prerequisite edge (T192 must dependsOn T185), and an unwired @cq/config dependency for ledger-web (T187/T192 never add it to ledger-web's package.json + the ledgerWeb Nix derivation symlinks)."
- new_questions: []
- criticism: ["SAME-FILE DAG-PARALLEL COLLISION (R137/R138 precedent): T189, T190, T191 each declare only dependsOn:[T188] yet ALL three edit packages/cq-cli/src/main.ts (the dispatcher routing + their respective subcommand handlers). They are concurrently DAG-ready and WILL collide when the implement loop dispatches them into separate worktrees and merges back. T190's own body even admits 'should be serialized by the implement loop if they collide' but does not encode it in dependsOn. Serialize them into a chain via dependsOn, e.g. T190 dependsOn [T189], T191 dependsOn [T190] (any total order works), so only one writer touches cq-cli/main.ts at a time.","MISSING FOD-REFRESH PREREQUISITE EDGE: T192 (flake.nix cq derivation + node-modules FOD hash refresh) declares dependsOn:[T188,T189,T190,T191] but NOT T185. T185 adds the smol-toml dependency to packages/cq-config/package.json (already in the FOD manifest fileset, flake.nix L56) and to bun.lock, which changes the node-modules FOD output hash. T192's own description states the smol-toml dep 'ALSO requires the same FOD refresh' and that T192 is 'the natural place to do the final FOD refresh' — but without a dependsOn:[T185] edge the DAG permits T192 to compute and paste the hash BEFORE T185 lands, yielding a hash that omits smol-toml and breaking nix build .#ledger-mcp / .#ledger-web (and a re-mismatch once T185 merges). Add T185 to T192.dependsOn so the single FOD refresh happens after BOTH bun.lock changes (smol-toml in T185 + cq-cli workspace pkg in T188) are present.","UNWIRED @cq/config DEPENDENCY FOR ledger-web: T187 wires loadConfig (from @cq/config) into packages/ledger-web/src/serve.ts, but ledger-web does not currently depend on @cq/config — it is absent from packages/ledger-web/package.json, and the ledgerWeb Nix derivation (flake.nix L341-358) only symlinks @cq/ledger-mcp, @cq/ledger and @cq/ledger-live into packages/ledger-web/node_modules; the shared embedServerClosure stages cq-config SOURCE but symlinks @cq/config ONLY under ledger-mcp's node_modules (L157-158), not ledger-web's. So workspace resolution under `bun run check` and especially `nix build .#ledger-web` (which T187 acceptance asserts 'succeeds') will fail to resolve @cq/config from serve.ts at runtime. Neither T187 nor T192 adds @cq/config to ledger-web's package.json nor adds an @cq/config symlink to the ledgerWeb installPhase. Add explicit steps: declare @cq/config in packages/ledger-web/package.json (T187) AND symlink packages/ledger-web/node_modules/@cq/config in the ledgerWeb derivation (T192, or a dedicated flake.nix edit), mirroring the ledger-mcp wiring at L221-225."]
- ledgerRefs: ["goals:G20","tasks:T185","tasks:T186","tasks:T187","tasks:T188","tasks:T189","tasks:T190","tasks:T191","tasks:T192"]
- sessionLogs: ["docs/logs/20260606-110728-ae88cb866d32b4470.md"]

### R216 — go-ahead

- createdAt: 2026-06-06T11:14:11.730Z
- updatedAt: 2026-06-06T11:14:40.116Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Round-1 re-review: all 3 R215 criticisms resolved (cq-cli/main.ts now a total chain T189->T190->T191; T192.dependsOn includes T185 so the single FOD hash refresh follows the smol-toml bun.lock edit; T187 now declares @cq/config in ledger-web/package.json + symlinks it in the ledgerWeb derivation with acceptance (5)(6)(7) asserting it). The fix introduced no new same-file collision: T187's flake.nix edit is scoped to the ledgerWeb derivation and T192's to the cqCli derivation + bunNodeModules FOD + apps.cq, serialized via T192 dependsOn T187. DAG acyclic; every shared-file task pair totally ordered; Q105-Q111 fidelity intact. go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G20","tasks:T185","tasks:T186","tasks:T187","tasks:T188","tasks:T189","tasks:T190","tasks:T191","tasks:T192"]
- sessionLogs: ["docs/logs/20260606-111249-a898bda7c81b5c1ac.md"]

## M70

### R227 — revise

- createdAt: 2026-06-06T12:34:22.338Z
- updatedAt: 2026-06-06T12:35:03.580Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Parts 1-3 sound and well-grounded; Part-4 has one coverage gap — /investigate:start cross-refs inside the relocated cq/plan.md fall between T196 (own-name only) and T198 (excludes the relocated files), leaving stale refs that fail T198's own grep acceptance."
- new_questions: []
- criticism: ["T196/T198 coverage gap on cross-file renamed-FROM refs: commands/plan/start.md (→ cq/plan.md) references /investigate:start at lines 2 (frontmatter description), 29, 35, 37. T196 scopes its in-file edits to each file's OWN old slash name only ('the command's OWN old slash name'); T198 explicitly EXCLUDES 'the three files T196 already fixed.' So the /investigate:start mentions inside cq/plan.md are owned by neither task and would survive as dangling references to a command that no longer exists. Worse, T198's own acceptance ('grep -rn /investigate:start nix/pkg/ returns no hits') cannot pass while the file it is told to exclude still contains those hits. Fix: extend T196 to also rewrite cross-references in a relocated file to the OTHER renamed-FROM commands (/advance, /plan:start, /investigate:start), not just its own name — OR drop T198's exclusion of the three relocated files so the global grep sweep covers them. Either makes the rename set internally consistent. (Only cq/plan.md is actually affected: investigate/start.md references only /investigate:advance [staying] + its own /investigate:start; advance.md references only its own /advance + staying *:advance names.)"]
- ledgerRefs: ["goals:G22","tasks:T193","tasks:T194","tasks:T195","tasks:T196","tasks:T197","tasks:T198"]
- sessionLogs: ["docs/logs/20260606-123129-ac4deea3a121b21d0.md"]

### R228 — go-ahead

- createdAt: 2026-06-06T12:38:05.785Z
- updatedAt: 2026-06-06T12:38:37.122Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "R227 cross-file coverage gap resolved: T196 now owns ALL renamed-FROM refs inside the 3 relocated files (incl. /investigate:start in cq/plan.md), word-boundary-sparing the staying names; T198 sweep + both acceptance greps exclude those 3 files so its grep is satisfiable. T196→T197→T198 ordering intact; M71 unchanged + sound; T196∪T198 partition covers all of nix/pkg with no gap/overlap."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G22","tasks:T196","tasks:T197","tasks:T198","tasks:T193","tasks:T194","tasks:T195"]
- sessionLogs: ["docs/logs/20260606-123129-a8e1f13516398ff6e.md"]

## M75

### R235 — revise

- createdAt: 2026-06-06T20:51:16.852Z
- updatedAt: 2026-06-06T20:52:01.348Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Fix + single-task granularity are correct and well-grounded (root cause = D33/H25, both consumers traced); two acceptance-completeness gaps keep it at revise: pin the test to the real @cq/ledger schema exports, and explicitly assert the DEFAULT_LAYOUT_OPTS (pad=24) DagView path."
- new_questions: []
- criticism: ["T199's unit-test instruction leaves a hand-fabricated-transition-map fallback ('if the schemas are not importable as plain data, drive computeDagLayout directly with the same statusValues/transitions') as an acceptable path. But @cq/ledger EXPORTS the canonical MILESTONES_SCHEMA / TASKS_SCHEMA / GOALS_SCHEMA (and CANONICAL_LEDGERS) as RUNTIME values (packages/ledger/src/constants.ts, re-exported from index.ts), and ledger-web already depends on @cq/ledger (src/types.ts imports from it). A copied transition map can silently drift from the canonical schema and pass while the real diagram regresses. Tighten the acceptance: the milestones/tasks/goals min-x===16 assertions MUST import and feed the actual @cq/ledger *_SCHEMA objects through computeStateMachine; remove/demote the hand-fabricate fallback.","T199's acceptance asserts min node x only for the STATE_LAYOUT_OPTS path (pad=16, the help State-machines view); it never asserts the DEFAULT_LAYOUT_OPTS / DagView path (pad=24), which the goal explicitly requires the single re-base to correct. DagView.tsx calls computeDagLayout(ids, data.edges) with DEFAULT_LAYOUT_OPTS and binds layout.width/height to the SVG, so the fix flows through it transitively, but the test only exercises the pad=24 opts via a width-shrink fixture, not a min-x assertion. Add to acceptance: (a) a minLayer>0 fixture driven through computeDagLayout(..., DEFAULT_LAYOUT_OPTS) asserting Math.min(node.x)===24; and (b) a no-op assertion that a graph WITH a real layer-0 source (as the milestone dependency DAG always has) is byte-identical pre/post re-base — proving the milestone DagView is never shifted and the re-base only moves content left when minLayer>0 (this is the risk that the re-base could disturb the dependency-graph view)."]
- ledgerRefs: ["goals:G24"]
- sessionLogs: ["docs/logs/20260606-205136-a7d92658324296b3e.md"]

### R236 — go-ahead

- createdAt: 2026-06-06T20:54:08.234Z
- updatedAt: 2026-06-06T20:54:37.614Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Round-2 re-review: both R235 criticisms fully addressed in T199's revised acceptance — (A) pins min-x===16 to the real exported @cq/ledger *_SCHEMA objects and bans the hand-fabricated fallback; (C) adds the DEFAULT_LAYOUT_OPTS/pad=24 DagView coverage with a minLayer>0 min-x===24 fixture (c-i) and a byte-identical pre/post re-base invariance assertion on a real layer-0 source (c-ii). Acceptance is operationally complete and grounded; go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G24"]
- sessionLogs: ["docs/logs/20260606-205422-a38374312bac9b4bd.md"]

## M74

### R237 — revise

- createdAt: 2026-06-06T21:05:20.029Z
- updatedAt: 2026-06-06T21:05:58.594Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: Architecturally sound elkjs pivot (library/async/Nix/DAG all verified); two planner-fixable tightenings before go-ahead.
- new_questions: []
- criticism: ["T203 under-tests the State-machines-tab migration. The grounding claims the tab has structural happy-dom tests asserting help-sm-rect/node/edge ids, but the actual repo has NO DOM test of that tab: app.test.tsx only opens the help overlay on the Shortcuts tab (L1296-1305) and never clicks help-tab-statemachines or asserts any help-sm-* / help-statemachine-svg id; the sole computeStateMachine coverage is the pure unit test in test/stateMachine.test.ts. Consequently T203's regression de-risking rests entirely on T206's manual/headless smoke. Tighten T203 acceptance to ADD a happy-dom render test that opens the State-machines tab and asserts the migrated DiagramSvg renders one diagram per ledger with the documented data-testid scheme AND now renders a self-loop edge for a schema that has one (the behavior the elk migration newly enables), rather than asserting parity only via T206 smoke. Also correct T203's wording that frames this as 'updating existing tab tests' since no such DOM tab test exists.","T203/T206 do not reconcile defect D33 (filed this session, commit 224f69f: sm-diagram right-alignment, blocked-on-env). T203 rewrites the exact StateMachineDiagram SVG sizing/alignment code (width/height/viewBox/style maxWidth=model.width, preserveAspectRatio) that D33 concerns. The plan must state whether migrating to elk's computed width/height RESOLVES, PRESERVES, or INVALIDATES D33's alignment behavior, and add a step (in T203 or T206) to update/close D33 accordingly so the elk pivot does not silently leave a stale or contradicted defect."]
- ledgerRefs: ["goals:G23"]
- sessionLogs: ["docs/logs/20260606-210544-a1873e95df9ec2c70.md"]

### R238 — go-ahead

- createdAt: 2026-06-06T21:09:02.581Z
- updatedAt: 2026-06-06T21:09:30.613Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "Round-2 revision resolves both R237 criticisms: T203 adds a new happy-dom render test (testid scheme + self-loop) with corrected new-coverage framing, and T203/T206 reconcile D33 with an operational left-alignment assertion and recorded disposition (resolved for homegrown via G24/T199, not re-filed). Plan is go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G23"]
- sessionLogs: ["docs/logs/20260606-210916-a07e3591c62e34c2d.md"]

## M77

### R240 — go-ahead

- createdAt: 2026-06-06T21:36:46.637Z
- updatedAt: 2026-06-06T21:36:46.637Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "approve — T200 flow-state-machines.md is accurate and complete: all four flows + cross-flow handoff topology, every state/transition/trigger/handoff verified against constants.ts and commands/cq/* + agents/plan-advance; no invented states. Docs-only (bun run check N/A)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T200","goals:G23"]
- sessionLogs: ["docs/logs/20260606-213541-ac51a9a79be8601ed.md"]

## M78

### R241 — go-ahead

- createdAt: 2026-06-06T21:37:00.421Z
- updatedAt: 2026-06-06T21:37:00.421Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- summary: "approve — T201 elkjs dependency + bundled-entry smoke land cleanly; verified by execution: nix build .#node-modules + .#ledger-web both EXIT=0 (FOD hash concretely refreshed), elkjs in package.json+bun.lock and the ledgerWeb symlink loop, src/elk.ts imports elkjs/lib/elk.bundled.js and typechecks, bun run check green."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T201","goals:G23"]
- sessionLogs: ["docs/logs/20260606-213541-ac8524b4dcf023468.md"]
