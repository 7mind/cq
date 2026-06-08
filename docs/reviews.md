---
ledger: reviews
counters:
  milestone: 0
  item: 328
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
  - id: M78
    path: ./archive/reviews/M78.md
    summary: "G23 phase 2 complete: adopted elkjs, built the diagramLayout adapter + DiagramSvg renderer (T202), migrated the State-machines help tab off computeDagLayout onto elk (T203), authored the flow render-data module (T204), added the third Flows help tab (T205), and passed the end-to-end verification gate (T206: bun run check 1014/0, nix build .#node-modules + .#ledger-web both green, D33 left-alignment confirmed resolved, DagView unchanged). All 6 tasks merged, all reviews go-ahead."
    title: G23 phase 2 — adopt diagram library, migrate State-machines tab, add Flows tab
    status: done
  - id: M77
    path: ./archive/reviews/M77.md
    summary: "G23 phase 1 complete: authored nix/pkg/cq-assets/docs/flow-state-machines.md (T200) documenting the plan/investigate/implement/advance state machines + cross-flow handoff topology; reviewed go-ahead (R240). Task done, milestone fully terminal."
    title: G23 phase 1 — flow state-machine doc
    status: done
  - id: M83
    path: ./archive/reviews/M83.md
    summary: "G27/D34 fix landed: server-computed progressTotal on LedgerSummary (questions = open+answered, excludes withdrawn) in both MCP transports (T207), LedgerProgressBar uses it as denominator (T208), regression pinned (T209). All reviewed go-ahead; D34 resolved. Top-bar questions bar now reads 38/38 = 100%."
    title: D34 fix — questions progress denominator excludes withdrawn (G27)
    status: done
  - id: M84
    path: ./archive/reviews/M84.md
    summary: "G25 skill-retirement landed: five skills (research-loop, vsm-loop, vsm-node, question-batch, review-loop) archived to docs/legacy-skills/ (T211), source dirs removed/de-registered (T212), references repointed to cq successors (T213), surviving skills verified clean (T214), and the final gate passed — nix build .#llm-skills green with 7 survivors, zero dangling refs in nix/ (T215). All reviewed go-ahead."
    title: "G25: Retire legacy skill family (research-loop, vsm-loop, vsm-node, question-batch, review-loop) + scrub cq references"
    status: done
  - id: M85
    path: ./archive/reviews/M85.md
    summary: "G26 session-log popup landed: added .lw-modal-backdrop/.lw-modal overlay CSS so LogModal is a fixed popup (T216), LogModal renders content via the sanitized Markdown component instead of <pre> (T217), read_log cap relaxed to 4 MiB per K42 (T218), happy-dom regression test for overlay+markdown (T219), and bun run check green gate (T220). All reviewed go-ahead."
    title: "W: session-log markdown popup (ledger-web, G26)"
    status: done
  - id: M37
    path: ./archive/reviews/M37.md
    summary: G10 (fix D13 TUI nav perf + D23 test flake) closed done; coordination milestone archived — all items terminal.
    title: "Plan: fix D13 (TUI nav perf — memo boundaries) + D23 (multi-step-form test flake)"
    status: done
  - id: M39
    path: ./archive/reviews/M39.md
    summary: G12 (fix D24 's'-key-inert archived-item test) closed done; coordination milestone archived — all items terminal.
    title: "Fix: vacuous 's'-key-inert archived-item test (restores D22)"
    status: done
  - id: M40
    path: ./archive/reviews/M40.md
    summary: "G11 (agent-ergonomic ledger MCP: snapshot + handoffs + sessionLogs + click-protection) closed done; coordination milestone archived."
    title: "Plan: agent-ergonomic ledger MCP (state-overview endpoint + better descriptions)"
    status: done
  - id: M47
    path: ./archive/reviews/M47.md
    summary: G13 (fix D25/D26/D27 G11 follow-up cleanup) closed done; coordination milestone archived.
    title: "Plan: fix D25/D26/D27 (G11 follow-up cleanup)"
    status: done
  - id: M49
    path: ./archive/reviews/M49.md
    summary: G14 (fix D28 readLog TOCTOU) closed done; coordination milestone archived.
    title: "Plan: fix D28 (readLog TOCTOU)"
    status: done
  - id: M51
    path: ./archive/reviews/M51.md
    summary: G15 (explorer RW prober + pluggable parallel reviewers via cq.toml) closed done; coordination milestone archived.
    title: "Plan: explorer RW access + pluggable parallel reviewers (cq.toml)"
    status: done
  - id: M53
    path: ./archive/reviews/M53.md
    summary: G16 (fix D29 reject empty answer on `answered`) closed done; coordination milestone archived.
    title: "Plan: fix D29 (reject empty answer on question `answered`)"
    status: done
  - id: M57
    path: ./archive/reviews/M57.md
    summary: G17 (fix D30 link-prompts stale llm/ root) closed done; coordination milestone archived.
    title: "Plan: fix D30 (link-prompts stale `llm/` root → dangling symlinks)"
    status: done
  - id: M59
    path: ./archive/reviews/M59.md
    summary: G18 (merge cq-config into ledger MCP + parallel planners) closed done; coordination milestone archived.
    title: "Plan: merge cq-config into ledger MCP + parallel planners"
    status: done
  - id: M63
    path: ./archive/reviews/M63.md
    summary: G19 (fix D32 README cq-config repoint) closed done; coordination milestone archived.
    title: "Plan: fix D32 (README cq-config repoint)"
    status: done
  - id: M65
    path: ./archive/reviews/M65.md
    summary: G20 (cq.toml [webui] + cq CLI init/reset/erase) closed done; coordination milestone archived.
    title: "Plan: cq.toml [webui] + cq CLI (init/reset/erase)"
    status: done
  - id: M66
    path: ./archive/reviews/M66.md
    summary: G21 (fix D31 modal backdrop press-started dismiss) closed done; coordination milestone archived.
    title: "Plan: fix D31 (modal backdrop press-started-inside dismiss)"
    status: done
  - id: M70
    path: ./archive/reviews/M70.md
    summary: "G22 (sidebar reorder + help-size + SVG align + cq: renames) closed done; coordination milestone archived."
    title: "Plan: sidebar reorder + help-size + SVG align + cq: command renames"
    status: done
  - id: M74
    path: ./archive/reviews/M74.md
    summary: G23 (flow state-machine docs + Flows help tab) closed done; coordination milestone archived.
    title: "Plan: flow state-machine docs + Flows help tab"
    status: done
  - id: M75
    path: ./archive/reviews/M75.md
    summary: G24 (fix D33 left-align cyclic state-machine diagrams) closed done; coordination milestone archived.
    title: "Plan: fix D33 (sm-diagram layer-0 left gap)"
    status: done
  - id: M80
    path: ./archive/reviews/M80.md
    summary: G25 (retire legacy skills + clean cq references) closed done; coordination milestone archived.
    title: "Plan: retire legacy skills + clean cq references"
    status: done
  - id: M81
    path: ./archive/reviews/M81.md
    summary: G26 (render session-log markdown in a popup) closed done; coordination milestone archived.
    title: "Plan: render session logs as markdown in a popup"
    status: done
  - id: M82
    path: ./archive/reviews/M82.md
    summary: G27 (fix D34 top-bar progress counts withdrawn; + D35 client wiring) closed done; coordination milestone archived.
    title: "Plan: fix D34 (top-bar progress counts withdrawn)"
    status: done
  - id: M87
    path: ./archive/reviews/M87.md
    summary: "G28 W1 spike+de-risk — COMPLETE. T221 read-only go/no-go on Pi 0.78.0 ExtensionAPI child-session primitive: verdict GO — all 5 primitives (registerTool types.d.ts:816; child-session spawn via subprocess Route A `pi -p --mode json` + in-process Route B createAgentSession; tool-filtering --tools/excludeTools; model pin --model; output capture message_end/getFinalOutput) confirmed at exact file:line. Review R270 go-ahead (opus verified citations; 2 minor citation fixes applied at merge). Merged bd6aa87. M88–M91 unblocked."
    title: Pi subagent dispatch — spike + de-risk
    status: done
  - id: M89
    path: ./archive/reviews/M89.md
    summary: "G28 W3 tier→model routing + runtime config-access — COMPLETE. T223: additive cq.toml [tiers] (fast/standard/frontier→harness:model) + [agent_tiers] (agent→tier) parsed in @cq/config with resolveAgentTier/resolveTierToken/resolveAgentModel + 17 tests, bun run check green 1038/0, merged 92aae54 (review R269 unanimous go-ahead). T228: locked decision K46 + backing note — standalone store-path extension reads cq.toml at runtime via $CQ_CONFIG (default $CQ_PROJECT_ROOT/cq.toml) with an INLINED flat-table TOML reader + INLINED resolver (Route A; rejected cross-workspace-import B / build-time-inline C). T224/T225 implement against K46."
    title: Pi subagent dispatch — tier→model routing
    status: done
  - id: M88
    path: ./archive/reviews/M88.md
    summary: "G28 W2 agents-projection + extension — COMPLETE. T222: home.file projects the 7 cq agent markdowns to ~/.pi/agent/cq-agents/<name>.md (byte-identical to mergedAgents) + CQ_AGENTS_DIR pinned on piWrapped (7611867, R271 unanimous). T224: bespoke nix/pkg/pi-extensions/cq-subagent-dispatch.ts registering dispatch_agent {agent,task,isolation?} (K44) — reads $CQ_AGENTS_DIR agent md, spawns a Route-A filtered child `pi -p --mode json` (re-dispatch blocked via --exclude-tools + not loading the extension in the child; injection-safe shell:false argv; agent body via temp file), returns child output; registered in dev-llm.nix; LIVE dispatch probe returned non-empty + child lacked the dispatch tool. 1 criticism round fixed a path-traversal + 4 robustness items (235f854, R272 unanimous round-2). tsc --strict clean."
    title: Pi subagent dispatch — agents projection + extension
    status: done
  - id: M96
    path: ./archive/reviews/M96.md
    summary: "G31 D38-verdict-enum fix COMPLETE: T240-T244 all merged (c24b02d/a74d9eb/3ee5bf1/567c415), D38 resolved. Two-layer fix (pi-context.md enum reinforcement + plan/implement advance.md fail-loud off-enum→abstention) + verify (bun run check 1037/0 + nix builds) + documented argument. All implement reviews go-ahead (R285-R289)."
    title: "G31 W: D38 verdict-enum fix (reinforce + fail-loud validate)"
    status: done
  - id: M94
    path: ./archive/reviews/M94.md
    summary: "G29 provider-qualified pi token grammar COMPLETE: T231-T239 all merged + reviewed; D36 RESOLVED. pi:<provider>/<model> slash grammar (bare rejected) threaded through @cq/config (parseReviewerToken + resolvers), the @cq/ledger(-mcp) config-capability surface, and the cq-subagent-dispatch extension mirror (K50 cross-layer guard); cq.toml.example migrated + documented; fixtures adapted; final gate green (bun run check 1089/0 + nix builds + bare-pi audit clean). ACTIVATION TAIL: live cq.toml migration + get_config spot-check deferred to the rebuilt-MCP restart."
    title: "G29 W: provider-qualified pi token grammar"
    status: done
  - id: M103
    path: ./archive/reviews/M103.md
    summary: "G32 W1 COMPLETE: write-time handoff invariant enforcement. assertHandoffInvariants pure helper (core.ts) wired into applyCreateItem+applyUpdateItem (both adapters); mixed/answers-required⇒non-empty blockingQuestions, user-action-required⇒non-empty handoffReasons, else SchemaValidationError. Dual-adapter tests reproduce HO26 as an asserted throw. K52 deferred the stretch hardenings. T257-T260 done, R314-R317 go-ahead."
    title: "G32 W1: write-time handoff invariant enforcement (@cq/ledger, load-bearing)"
    status: done
  - id: M104
    path: ./archive/reviews/M104.md
    summary: "G32 W2 COMPLETE: advance.md §Stop-condition turn-vs-run clause (marker 'NOT a run-stop') — turn/context exhaustion is NOT a run-stop, needs no handoff, the ledger is the resume point. T261 done, R318 go-ahead."
    title: "G32 W2: advance.md turn-vs-run stop clause"
    status: done
  - id: M105
    path: ./archive/reviews/M105.md
    summary: "G32 W3 COMPLETE: euphemism blocklist + self-check + enforced-invariant prose threaded across all 4 *:advance prompts (advance.md via T262; the 3 per-flow via T263). T262/T263 done, R319/R320 go-ahead."
    title: "G32 W3: euphemism blocklist + self-check across the four *:advance prompts"
    status: done
  - id: M106
    path: ./archive/reviews/M106.md
    summary: "G32 W4 COMPLETE: 8-cell grep-invariant (4 prompts × 2 markers) + final verify (bun run check 1135/0 + nix build .#ledger-mcp); D39 reproduction closed. T264/T265 done, R321/R322 go-ahead."
    title: "G32 W4: verify + grep-invariant"
    status: done
  - id: M90
    path: ./archive/reviews/M90.md
    summary: "G28 work (integration + tier wiring) COMPLETE: T225 (tier resolution wired) + T229 (Pi dispatch-trigger) done + reviewed; D36 (provider-ambiguous token, filed here) RESOLVED via G29. All items terminal."
    title: Pi subagent dispatch — integration + tier wiring
    status: done
  - id: M97
    path: ./archive/reviews/M97.md
    summary: "G30 W1 COMPLETE: T245 added user-action-required to HANDOFFS_SCHEMA (now live post-redeploy). R290 go-ahead."
    title: "G30 W1: schema — add user-action-required to HANDOFFS_SCHEMA"
    status: done
  - id: M99
    path: ./archive/reviews/M99.md
    summary: "G30 W3 COMPLETE: T248/T249 WARNING-bucket render (both status.ts) + T250 render tests. All reviews go-ahead."
    title: "G30 W3: rendering — warning bucket (TUI + web)"
    status: done
  - id: M100
    path: ./archive/reviews/M100.md
    summary: "G30 W4 COMPLETE: user-action-required threaded through all 4 *:advance prompt tables (T251-T254). All reviews go-ahead."
    title: "G30 W4: prompt threading (advance.md + 3 per-flow tables)"
    status: done
  - id: M101
    path: ./archive/reviews/M101.md
    summary: "G30 W5 COMPLETE: schema unit + four-table grep tests (T255) + verify (T256, bun run check + scoped nix build). All reviews go-ahead."
    title: "G30 W5: verify — schema/grep tests + bun run check + scoped nix build"
    status: done
  - id: M98
    path: ./archive/reviews/M98.md
    summary: "G30 W2 live-ledger migration complete: T246 (operational in-place migration of the gitignored docs/ledgers.yaml handoffs schema — user-action-required added to statusValues/terminalStatuses/transitions; verified no backup-reinit, HO records intact) + T247 (committed CI records-survive regression test) both done; R299 go-ahead. Closes the last open G30 work item."
    title: "G30 W2: in-place live-ledger migration (Q141)"
    status: done
---

# reviews

## M86

### R265 — revise

- createdAt: 2026-06-07T19:53:17.679Z
- updatedAt: 2026-06-07T19:54:02.700Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: REVISE (3/4 reviewers usable; minimax abstained — no API key). opus + grok + codex all voted revise. Plan is well-grounded and largely fine-grained/testable, but has a critical feasibility hole (no per-agent tier SOURCE), a false dependency edge, a runtime-config-access gap, T222 mis-grounding, a Q126 end-to-end-verification gap, and acceptance imprecision. One user-only new_question on the Q126 dispatch-trigger mechanism.
- new_questions: ["[opus] Q126/Q130 require the shared cq command prompts to work byte-for-byte UNCHANGED under Pi, yet those prompts currently encode only a Claude ('Agent tool + subagent_type') and Codex ('native multi_agent') dispatch branch with NO Pi branch. How is the new Pi dispatch tool expected to be invoked from the unchanged prompt text — must it be named/shaped so the existing 'Agent'/'subagent_type' wording already triggers it, or is a harness-agnostic dispatch instruction to be added to a Pi-side asset (e.g. pi-context.md / APPEND_SYSTEM.md — itself an asset addition, though NOT a cq command-prompt edit)? This determines whether 'prompts unchanged' is achievable Pi-side at all, and whether a (permitted) Pi-side context addition is in scope."]
- criticism: ["[opus+grok+codex] CRITICAL feasibility hole: the plan assumes each agent carries a tier so T225 can 'resolve child model from the agent tier via [tiers]', but the cq agent markdown frontmatter is name/description/disallowedTools ONLY (no suggestedModel/tier field), and cq-assets must stay byte-identical (Q126). As written T225 is unimplementable. The revised plan MUST define the per-agent tier SOURCE — e.g. (a) an additive agent-name->tier map alongside [tiers] in cq.toml, (b) the orchestrator passes the tier explicitly at dispatch (Q127: 'orchestrator names which agent to run'), or (c) add a tier field to agent frontmatter (assess Q126 impact + whether Claude tolerates it) — then thread it through T222/T224/T225.","[opus+grok] T223 (add [tiers] + parse in @cq/ledger config layer) declares dependsOn T221 but is pure TypeScript/TOML config work independent of the child-session-spawn spike (its own description says 'independent of the extension implementation'). Remove the false T221 edge so M89/T223 runs concurrently with the spike.","[grok+codex] No task addresses how the standalone store-path .ts extension (loaded by the vendored pi-coding-agent runtime via settings.extensions) obtains the [tiers]/agent-tier config AT RUNTIME — cross-workspace import from @cq/ledger vs locating+parsing cq.toml directly vs inlining. T225 requires this resolution INSIDE the extension; add a task/step pinning the runtime config-access strategy.","[grok+codex] T222 mis-grounds + mis-scopes: it says 'materialize mergedAgents' but the extension (T224) reads individual nix/pkg/cq-assets/agents/<name>.md files — name the exact discoverable dir/files; and its git-diff acceptance wrongly includes '+ new pi-extensions files' (extension authoring/registration happen in T224/T225, not T222).","[opus] No task verifies the central Q126 constraint END-TO-END: T226/T227 invoke the tool DIRECTLY (dispatch_agent({agent,task})) rather than driving the actual unchanged cq command prompt under the wrapped Pi harness and observing it fire the dispatch. Add an acceptance step that runs an unchanged cq prompt under Pi AND a `git diff` assertion that nix/pkg/cq-assets is untouched.","[opus] T221 acceptance is internally inconsistent: it enumerates FIVE primitives {registerTool, child-session spawn, tool-filtering, model/provider pin, output capture} but states 'GO = all four primitives'. Fix the count (the two existing extensions prove registerProvider/on but NOT registerTool, so registerTool genuinely needs confirming).","[opus+codex] T222 acceptance only asserts the agent files EXIST on disk and leaves the exposure mechanism undecided (env var vs pi settings field); it does not assert the path is reachable/readable by the extension at runtime. Pin the exposure mechanism and add a runtime-resolve check to the T222->T224 hand-off.","[grok+codex] Acceptance for T224/T225/T226/T227 lacks an exact command/invocation/capture mechanism (pi flags, cwd, transcript capture) unlike the concrete 'bun test' / 'nix build' criteria — tighten each to a verifiable command + observable.","[codex] No task isolates/sequences the dev-llm.nix settings.extensions REGISTRATION of the new extension separately from its authoring; T224 acceptance leans on `nix build` succeeding (implying the wiring) but the registration step is not called out.","[codex contingency] Make T221's NO-GO branch a first-class contingency in the plan: if Pi 0.78.0's ExtensionAPI lacks the child-session-spawn / tool-filtering / per-child model-pin primitives, the locked mechanism (Q125/Q130) and possibly G28 scope must be revisited rather than every later milestone proceeding on an assumed GO. (Largely subsumed by T221 — add it as an explicit contingency note, not a separately-filed defect.)"]
- ledgerRefs: ["goals:G28"]
- sessionLogs: ["docs/logs/20260607-195324-a977c6128b17f3af5.md","docs/logs/20260607-195324-pi-codex.md","docs/logs/20260607-195324-pi-grok.md","docs/logs/20260607-195324-pi-minimax.md"]

### R266 — revise

- createdAt: 2026-06-07T20:06:21.082Z
- updatedAt: 2026-06-07T20:06:56.320Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "ROUND 2 REVISE (opus go-ahead; grok + codex revise; minimax abstained — no API key). All ten R265 findings confirmed resolved and K44's Q126 reasoning judged sound. Remaining: planner-fixable sequencing/milestone-placement violation + a real completeness gap (no task authors/verifies the Pi-side dispatch-trigger instruction K44 relies on) + two minor labeling/acceptance tightenings. No new_questions, no out-of-scope defects — converging."
- new_questions: []
- criticism: ["[grok+codex] SEQUENCING/MILESTONE violation: T224 is in M88 (whose only milestone dep is M87) but dependsOn T228, which is in M89 (deps T223). So a task in M88 depends on a task in a LATER milestone (M89), and M88's milestone-level deps don't reflect it. Restructure so the real order T223->T228->T224 is consistent: e.g. move T228 (and/or T224) so no task depends on a later-milestone task, OR add the M88<-M89 milestone edge, OR fold the tier-routing prerequisites (T223/T228) into a milestone that precedes the extension. Fix the milestone graph + task placement to match the dependsOn edges.","[codex] COMPLETENESS gap (the dispatch trigger K44 relies on is never authored): per K44 the unchanged cq command prompt fires the Pi dispatch tool either because the tool's shape matches the existing named-agent+task wording AND/OR because a harness-agnostic dispatch instruction lives in a Pi-side asset (pi-context.md / APPEND_SYSTEM / programs.pi wiring). But NO task authors or verifies that Pi-side dispatch instruction — T224 only registers the tool + dispatch shape + settings.extensions entry, and T226/T227 ASSUME the unchanged promptTemplate (run under piWrapped) makes the model EMIT the dispatch call rather than prose. Add an explicit task (prerequisite of the T226/T227 end-to-end demos) that authors the Pi-side dispatch-trigger instruction (pi-context.md/APPEND_SYSTEM addition + any programs.pi wiring) and whose acceptance confirms an unchanged prompt actually fires the tool — without it the acceptance demos cannot pass.","[codex] T228 acceptance is underspecified: it requires only 'a written decision concrete enough for T224' but does not name the ARTIFACT location (a decisions ledger item / docs/drafts/*.md / a pinned source comment) nor how T224/T225 reference+consume it without re-deciding. Pin the artifact location and the consumption contract.","[codex] Labeling/ordering artifacts reduce sequenced-flow clarity: non-sequential task IDs (T223, T228, then T224-T227), T228 under M89 directly feeding T224 under M88, and T223 labeled 'deps NONE, runs concurrently' while its outputs are strict prereqs of T228/T224/T225. Clean up the milestone/label structure so the sequenced flow is unambiguous (consequence of the sequencing fix above)."]
- ledgerRefs: ["goals:G28"]
- sessionLogs: ["docs/logs/20260607-200625-a31a47f86fd863c5a.md","docs/logs/20260607-200625-pi-codex.md","docs/logs/20260607-200625-pi-grok.md","docs/logs/20260607-200625-pi-minimax.md"]

### R267 — revise

- createdAt: 2026-06-07T20:15:40.314Z
- updatedAt: 2026-06-07T20:16:11.670Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "ROUND 3 REVISE (opus go-ahead + grok go-ahead; codex revise; minimax abstained). All R266 findings confirmed resolved. Only codex's 3 MINOR planner-fixable nitpicks remain: a spurious M89->M87 milestone edge, and T224 acceptance not stating explicitly that the child uses the parent-model DEFAULT there (tier resolution is deliberately T225). Converging — no new_questions, no out-of-scope defects."
- new_questions: []
- criticism: ["[codex] Spurious milestone edge: M89.dependsOn=[M87] is not backed by any task dependency — T223 has no deps and T228 depends only on T223; neither depends on T221 (the M87 spike). Remove M87 from M89.dependsOn (M89 config/tier work is independent of the child-session spike), so milestone deps reflect real task deps. (Minor/advisory — the prior round added the M88<-M89 edge correctly; this is the symmetric cleanup on M89 itself.)","[codex] T224 acceptance clarity: T224 deliberately defaults the child model to the PARENT's active model (full tier resolution is T225's job), but neither the acceptance nor codex's reading makes that explicit — codex misread it as an inverted prerequisite (T224 'requiring' tier resolution). Reword T224's description/acceptance to state plainly that tiered/per-agent model selection is NOT exercised in T224 (child uses parent-model default) and is added+verified in T225, so the T224->T225 split is unambiguous.","[codex] T224 acceptance is less concrete than T229/T226/T227 on what the 'dispatch' step exercises: state that the manual dispatch_agent probe in T224 verifies tool registration + filtered-child-spawn + result capture ONLY (NOT tier selection), with the concrete observable (non-empty result + child lacks the dispatch tool) — tighten to match the precision of the other tasks' acceptance."]
- ledgerRefs: ["goals:G28"]
- sessionLogs: ["docs/logs/20260607-201545-a73539c14aa6b2921.md","docs/logs/20260607-201545-pi-grok.md","docs/logs/20260607-201545-pi-codex.md","docs/logs/20260607-201545-pi-minimax.md"]

### R268 — go-ahead

- createdAt: 2026-06-07T20:19:37.945Z
- updatedAt: 2026-06-07T20:20:02.631Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "ROUND 4 GO-AHEAD (unanimous: opus + grok + codex all go-ahead; minimax abstained — no API key). All three R267 minor findings confirmed fixed with no regressions: M89.dependsOn now [] (spurious M87 edge removed), T224 description carries an explicit child-model-default / T225 scope-boundary paragraph (tier selection NOT exercised in T224), and T224 acceptance scopes the dispatch probe to tool-registration + filtered-child-spawn + result-capture only. Milestone DAG (M87(—), M89(—), M88[M87,M89], M90[M88,M89], M91[M90]) is acyclic and consistent with every task's dependsOn; no task depends on a later-milestone task. Plan is fine-grained, sequenced, testable, grounded, and complete to Q128's acceptance bar. Ready to lock."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G28"]
- sessionLogs: ["docs/logs/20260607-201941-a176e1045eb180489.md","docs/logs/20260607-201941-pi-codex.md","docs/logs/20260607-201941-pi-grok.md","docs/logs/20260607-201941-pi-minimax.md"]

## M91

### R275 — go-ahead

- createdAt: 2026-06-07T23:40:02.577Z
- updatedAt: 2026-06-07T23:40:02.577Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "T226 GO-AHEAD (opus approve, sole usable verdict; codex+grok pi shellouts abstained on `argument list too long` from the capture-heavy prompt; minimax abstained). ACCEPTANCE DEMO MET: opus re-parsed the committed capture — the grok-build model GENUINELY fired dispatch_agent(agent=investigate-explorer) from UNCHANGED cq-convention prompt wording (not a hand-written call); child ran read-only (excludedTools=[dispatch_agent,write,edit,bash] matching investigate-explorer.md); child returned a fenced-json evidence block (8/8 file:line citations, contract-valid), live orchestrator parse succeeded; docs-only, cq-assets+nix/ untouched. Out-of-scope defect D37 (stale HM pi settings) filed."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T226","goals:G28"]
- sessionLogs: ["docs/logs/20260607-233329-aa0c624118a6e9655.md","docs/logs/20260607-233329-T226-T227-reviews.md"]

### R276 — go-ahead

- createdAt: 2026-06-07T23:40:07.461Z
- updatedAt: 2026-06-07T23:40:07.461Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "T227 GO-AHEAD (UNANIMOUS usable: opus + codex + grok approve; minimax abstained). ACCEPTANCE DEMO MET: from an UNCHANGED cq plan-review prompt under pi grok-build (extension + pi-context trigger), the model GENUINELY fired dispatch_agent(agent=plan-reviewer); the isolated child returned a SINGLE fenced-json verdict with all 5 plan-review contract keys + correct defects-object shape, and the orchestrator fence-strip+jq parse succeeded (exit 0); docs-only, cq-assets byte-identical, sandbox+implement-worker validation recorded as deferred follow-up. The child's off-enum verdict:\"fail\" (vs go-ahead|revise) is an out-of-scope Pi-path model-paraphrase artifact (does NOT violate the shape/parse acceptance) — filed as defect D38, not a T227 gap."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T227","goals:G28"]
- sessionLogs: ["docs/logs/20260607-233329-afa0391d57f11518e.md","docs/logs/20260607-233329-T226-T227-reviews.md"]

## M92

### R277 — revise

- createdAt: 2026-06-08T00:50:32.880Z
- updatedAt: 2026-06-08T00:51:04.276Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "G29 plan REVISE (UNANIMOUS usable: opus + codex + grok + minimax-via-ollama-cloud all revise; full 4-way panel — minimax now works). Plan is well-structured + correctly grounded in the 3-layer architecture, DAG acyclic; but carries a wrong cq.toml.example path, a missing T234→T232 edge + an activation-ordering hazard that can break the running MCP, T233 wording contradicting the bare-reject, incomplete test-migration scope, and underspecified cross-layer-test/acceptance precision. All planner-fixable; no new_questions; no out-of-scope defects."
- new_questions: []
- criticism: ["[opus] WRONG PATH: cq.toml.example is at the REPO ROOT (`cq.toml.example`), NOT `nix/pkg/cq-ledgers/cq.toml.example` — it holds the [tiers] block T234 must qualify. Fix the path in T234 (migrate), T237 (docs header), and T239 (the `rg` bare-pi audit path).","[opus+codex+grok] T234 is missing `dependsOn: T232`: its acceptance uses `get_config`/computeReviewers to show provider-qualified tokens, which REQUIRES T232's provider-surfacing through @cq/ledger + @cq/ledger-mcp. Add T232 to T234's dependsOn.","[opus] ACTIVATION-ORDERING HAZARD (T231→T234): T231 makes @cq/config loadConfig THROW on any bare `pi:<model>`, and the live (gitignored) repo-root cq.toml — codex/grok=`pi:grok-build`, minimax=`pi:minimax-m3` — is the exact config the RUNNING ledger MCP re-reads on every get_config/get_reviewers/get_planners call. A build+MCP-restart in the T231→T234 window throws on every read and breaks the orchestrator mid-flow. Constrain the live-cq.toml migration (T234) to co-merge with / precede T231's activation, and have the T239 gate assert the live config loads.","[codex+grok+minimax] T233 wording is contradictory: 'no `/` → null → parent fallback' reads like the PRE-D36 behavior. Reword to the post-fix observable: the extension mirror REFUSES a bare `pi:<model>` (tokenToChildModel returns null so it never dispatches provider-less), consistent with @cq/config THROWING on bare; T238 asserts BOTH layers refuse bare. State precisely what is returned/thrown for bare vs qualified, pi vs claude.","[opus+codex+grok] T235 test-migration scope may be incomplete: it adapts ONLY `packages/cq-config/test/config.test.ts`. Adding `provider` to the structural ResolvedReviewer/GetConfigResult + ledger-mcp projection (T232) can break any @cq/ledger-mcp config-capability test that deep-asserts the old `{harness,model}` shape. Verify and FOLD any such ledger-mcp test (and any other bare-pi fixture anywhere) into T235, so the T239 repo-wide `rg` audit has no unplanned survivor (and a remediation path if it finds one).","[codex+grok] T238 (end-to-end + cross-layer tests) `dependsOn` omits T235 — it shares config.test.ts and needs the pre-existing suite stable. Add T235. Also SPECIFY the cross-layer invariant concretely: for a shared token-fixture table, parseReviewerToken(s) accepts iff the extension's tokenToChildModel(s) accepts, and both agree on (harness, model, provider) — implemented by copying the extension's parse into the test (it cannot be imported). Make T238's acceptance 'bun test PASSES verifying X' (run+observe), not merely 'add test'.","[grok] T234 acceptance is not reproducible in a clean checkout/CI because the live cq.toml is gitignored: scope the REPRODUCIBLE acceptance assertion to `cq.toml.example` (a test loads it and resolves minimax→ollama-cloud), and treat the live-cq.toml edit as a documented local step that the T239 gate spot-checks via get_config in this session.","[grok] T239 `dependsOn` omits T231 explicitly (it is transitively covered via T232 etc.) — add T231 for an unambiguous gate; and the verification gate should fail loudly with a remediation pointer if the `rg` audit finds any un-migrated bare-pi token.","[grok+codex] Acceptance-precision + minor redundancy: make T236 (decisions item) cite T225's recorded live `--provider ollama-cloud` evidence as the empirical anchor (Q136), and tighten T237 doc acceptance to a concrete observable; T231's gate should be scoped to the NEW parse-case tests + typecheck (full pre-existing suite pass is deferred to T235/T238/T239 since the breaking grammar breaks old fixtures until T235). [minimax] add a sanity check in T234 that each migrated `<model>` exists under its target provider (guard against a typo like 'minmax')."]
- ledgerRefs: ["goals:G29","defects:D36"]
- sessionLogs: ["docs/logs/20260608-004043-G29-planners.md","docs/logs/20260608-004043-G29-reviews.md"]

### R278 — go-ahead

- createdAt: 2026-06-08T01:00:58.992Z
- updatedAt: 2026-06-08T01:00:58.992Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- summary: "G29 plan ROUND 2 GO-AHEAD (opus + codex + grok all go-ahead; minimax-via-ollama-cloud was an operational stall — too slow, killed). All 9 R277 criticisms verified resolved against task source + repo: repo-root cq.toml.example path (T234/T237/T239); T234 dependsOn [T231,T232] + the T231→T234 activation-ordering hazard + T239 live-config load spot-check; T233 reworded to the bare-pi REFUSE contract matching the actual tokenToChildModel; T235 broadened to all bare-pi fixtures incl. @cq/ledger-mcp; T238 cross-layer ACCEPT-iff/REFUSE-iff invariant via an in-test replica + dependsOn T235; T234 reproducible-vs-live acceptance split + per-model provider sanity; T239 dependsOn T231 + fail-loud audit remediation; T236 cites the real done T225 live evidence, T237 concrete acceptance, T231 gate scoped to new parse-cases+typecheck. DAG acyclic + consistent; fine-grained/sequenced/testable/grounded/complete; honors locked Q132-Q136. Ready to lock."
- criticism: []
- new_questions: []
- ledgerRefs: ["goals:G29","defects:D36"]
- sessionLogs: ["docs/logs/20260608-010041-G29-review2.md"]

## M95

### R279 — revise

- createdAt: 2026-06-08T08:11:20.561Z
- updatedAt: 2026-06-08T08:11:20.561Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G31 plan ROUND 1 REVISE (3/4 revise: codex+grok+minimax revise; opus go-ahead). Plan is well-grounded in the confirmed D38 root cause and the DAG is acyclic, but carries an unjustified T242←T241 edge, a synonym-normalization layer that is scope-creep AND contradicts fail-loud, imprecise acceptance (bare paths + approx line numbers), an underspecified nix-build product list, and a T244 path-traceability wording gap. All planner-fixable; no new_questions; no out-of-scope defects."
- new_questions: []
- criticism: ["[codex,grok] T242 dependsOn [T241] is unjustified: the two orchestrator validation edits target INDEPENDENT files (plan/advance.md vs implement/advance.md) with no shared output/state/prerequisite — violates correctly-sequenced. Remove the edge (make both roots) and preserve symmetry by fully specifying the IDENTICAL block shape in both task descriptions.","[codex,minimax] T241/T242 prescribe a synonym-normalization map that (a) is NOT in G31's required fix (scope creep) and (b) CONTRADICTS fail-loud — normalizing a paraphrase into a canonical enum silently RECOVERS it instead of abstaining. Remove the synonym map entirely; the required behavior is: any verdict not EXACTLY an enum literal is dropped+logged as an ABSTENTION.","[codex] T240/T241/T242 acceptance uses bare filenames + approximate line numbers; use fully-qualified repo paths (nix/pkg/llm-contexts/pi-context.md, nix/pkg/cq-assets/commands/cq/{plan,implement}/advance.md) and content-presence observables (grep for the new rule text) rather than line-number assertions that won't match git diff output.","[minimax] T243 acceptance underspecifies the nix build: enumerate the CONCRETE product attrs that vendor nix/pkg/cq-assets + nix/pkg/llm-contexts and give the exact `nix build` command from repo root (the changed assets feed the home-manager LLM bundle, NOT the ledger-mcp/tui/web Bun apps).","[codex] T244 'both dispatch paths' must be made explicitly TRACEABLE to D38's path-independent root cause: the dispatch_agent child path is closed by the T240 pi-context.md reinforcement and the direct `pi -p` reviewer-panel path by the T241/T242 orchestrator validation."]
- ledgerRefs: ["goals:G31"]
- sessionLogs: ["docs/logs/20260608-080957-a7a8b2a4d39a4f50c.md","docs/logs/20260608-080957-pi-codex.md","docs/logs/20260608-080957-pi-grok.md","docs/logs/20260608-080957-pi-minimax.md"]

### R280 — revise

- createdAt: 2026-06-08T08:20:41.717Z
- updatedAt: 2026-06-08T08:20:41.717Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G31 plan ROUND 2 REVISE (opus revise; codex + grok go-ahead; minimax abstained — shellout timeout exit 124). All five R279 points verified resolved. One residual planner-fixable criticism from opus: T243's nix-build acceptance presumes a buildable attr vendoring cq-assets, but cq-assets is eval-time-only. Converging."
- new_questions: []
- criticism: ["[opus] T243 acceptance presumes a `nix build .#<attr>` target that VENDORS nix/pkg/cq-assets, but cq-assets is consumed EVAL-TIME-ONLY via nix/pkg/cq-assets/assets.nix (builtins.readFile/readDir) and surfaces as the flake-level `llmAssets` output — it has NO buildable packages.* derivation. Only `llm-contexts` / `llm-context-with-env` / `llm-skills` are buildable, and of those only `llm-contexts` vendors the T240-edited nix/pkg/llm-contexts; none builds the T241/T242-edited cq-assets Markdown (read via readFile, so a green build would not exercise them anyway). Tighten T243: state cq-assets is eval-time-only, drop the implied per-file cq-assets build target, scope the nix-build gate to `llm-contexts` (+ `llm-context-with-env`/`llm-skills` for asset-validation-into-the-graph), and make `bun run check` the substantive guard — so the acceptance is satisfiable as written."]
- ledgerRefs: ["goals:G31"]
- sessionLogs: ["docs/logs/20260608-082009-a321657379502d04a.md","docs/logs/20260608-082009-pi-codex.md","docs/logs/20260608-082009-pi-grok.md","docs/logs/20260608-082009-pi-minimax.md"]

### R281 — go-ahead

- createdAt: 2026-06-08T08:24:40.350Z
- updatedAt: 2026-06-08T08:24:40.350Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G31 plan ROUND 3 GO-AHEAD (UNANIMOUS: opus + codex + grok + minimax all go-ahead; minimax now returned within timeout). R280's sole criticism (T243 presuming a buildable cq-assets attr) verified resolved: T243 records cq-assets eval-time-only, scopes the nix-build gate to the real buildable attrs (.#llm-contexts vendors the T240 pi-context.md edit, +.#llm-context-with-env/.#llm-skills for asset-graph validation), bun run check the substantive guard. DAG acyclic (T240/T241/T242 roots; T243/T244←all three); off-enum→abstention edits symmetric + fail-loud (no synonym coercion); plan fully achieves D38 across both dispatch paths + both enums. Ready to lock."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G31"]
- sessionLogs: ["docs/logs/20260608-082403-a7069cb62865e8e08.md","docs/logs/20260608-082403-pi-codex.md","docs/logs/20260608-082403-pi-grok.md","docs/logs/20260608-082403-pi-minimax.md"]

## M93

### R282 — revise

- createdAt: 2026-06-08T08:42:40.311Z
- updatedAt: 2026-06-08T08:42:40.311Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: G30 plan ROUND 1 REVISE (opus + codex + minimax go-ahead; grok revise). Plan well-grounded, acyclic, honors all locked answers Q137-Q142; one substantive sequencing fix + three acceptance-precision tightenings from grok. All planner-fixable; no new_questions; no out-of-scope defects.
- new_questions: []
- criticism: ["[grok] T247 (committed fixture records-survive test) incorrectly dependsOn T246 (the LOCAL gitignored docs/ledgers.yaml edit). Per Q141 the live edit is a non-committed local runtime migration; the committed fixture test must be CI-independent and depend ONLY on T245 (constants.ts). Repoint T247 dependsOn -> [T245]; note the live ledgers.yaml edit (T246) is a separate operational step.","[grok] T245 description should explicitly enumerate the precise edits (add token to statusValues + terminalStatuses + a transitions empty entry) so it is independently testable, not deferring verifiability to T255.","[grok] T252/T253/T254 acceptance is too terse ('handoff table row'); each must require the row's surrounding text to carry the narrow-legal-stop / forbidden-look-alikes / no-effort-stop-gate-intact / distinct-from-answers-required / mixed-handoffReasons cross-references (Q138/Q139), so each of the four tables is individually verifiable.","[grok] T250 acceptance 'warning not green' is indirect/negative; positively assert the warning bucket/class/color for user-action-required in BOTH mirrored status.ts AND that the other four handoff statuses' buckets are unchanged."]
- ledgerRefs: ["goals:G30"]
- sessionLogs: ["docs/logs/20260608-084157-aa6b092e7b5729c43.md","docs/logs/20260608-084157-pi-codex.md","docs/logs/20260608-084157-pi-grok.md","docs/logs/20260608-084157-pi-minimax.md"]

### R283 — revise

- createdAt: 2026-06-08T08:49:26.703Z
- updatedAt: 2026-06-08T08:49:26.703Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G30 plan ROUND 2 REVISE (opus + grok go-ahead; codex + minimax revise). All four R282 fixes verified applied. Of the new findings: codex#2/codex#3/minimax#1 are ARTIFACTS of the abbreviated round-2 review PROMPT (the actual ledger tasks already name the three nix attrs in T256 and the four prompt tables in T251-T254 + the T255 grep-invariant) — no plan change needed for those. The one substantive fix: codex#1 — T246 (in-place edit of the GITIGNORED docs/ledgers.yaml) is an OPERATIONAL main-checkout migration, not a worktree code task (a worktree edit to a gitignored file cannot merge back). Reframed accordingly."
- new_questions: []
- criticism: ["[codex] T246 is an OPERATIONAL live-ledger migration of the gitignored docs/ledgers.yaml — it must be performed on the MAIN checkout (it produces no committed diff, and a worktree task editing a gitignored file cannot merge back). The committed Q141 deliverables are T245 (constants.ts) + T247 (CI fixture test). Reframe T246 as operational + ensure the verify path (T256 task-level deps T247/T250/T255) gates on the COMMITTED test T247, not on operational T246.","[codex,minimax — PROMPT ARTIFACT, no change] T256 already names `.#llm-contexts .#llm-context-with-env .#llm-skills` in its acceptance; the 'vague scoped nix build' read came from the abbreviated review prompt, not the task.","[codex — PROMPT ARTIFACT, no change] all four prompt tables ARE covered: T251 (advance.md), T252 (plan), T253 (investigate), T254 (implement), with T255 the four-table grep-invariant; the round-3 prompt states this explicitly."]
- ledgerRefs: ["goals:G30"]
- sessionLogs: ["docs/logs/20260608-084846-ad018a304777bde16.md","docs/logs/20260608-084846-pi-codex.md","docs/logs/20260608-084846-pi-grok.md","docs/logs/20260608-084846-pi-minimax.md"]

### R284 — go-ahead

- createdAt: 2026-06-08T08:53:59.842Z
- updatedAt: 2026-06-08T08:53:59.842Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G30 plan ROUND 3 GO-AHEAD (UNANIMOUS: opus + codex + grok + minimax). T246 operational reframe sound; T256 verify gates on committed T247 (not operational T246). All locked answers Q137-Q142 honored; DAG acyclic; all R282/R283 fixes applied; prior round-2 prompt-artifact findings confirmed non-issues. Ready to lock."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G30"]
- sessionLogs: ["docs/logs/20260608-085336-a644adda2d79b52bb.md","docs/logs/20260608-085336-pi-codex.md","docs/logs/20260608-085336-pi-grok.md","docs/logs/20260608-085336-pi-minimax.md"]

## M102

### R310 — revise

- createdAt: 2026-06-08T11:03:58.553Z
- updatedAt: 2026-06-08T11:03:58.553Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G32 plan ROUND 1 REVISE (opus go-ahead; codex + grok + minimax revise). Design verified grounded + sound (assertHandoffInvariants pure helper in core.ts, both apply* paths, schema-field correctly unchanged, T260 gated leaf, DAG acyclic). Planner-fixable: (A) T263 4-prompt-coverage clarity + thread euphemism+self-check into the 3 per-flow too; (B) T259 acceptance matrix (status×empty-field + create/update + both adapters + SchemaValidationError + HO26 pre/post); (C) T260 reframe to default-defer (not scope creep). No new_questions; no real out-of-scope defects (T260's stretch IS in D39's suggestedFix, reframed default-defer)."
- new_questions: []
- criticism: ["[codex,grok,minimax] T263 names only the 3 per-flow prompts but the goal says 'the 4 *:advance prompts'. Clarify: the 4th is advance.md (T261/T262); T263 covers plan/investigate/implement advance.md. AND thread BOTH the turn-vs-run clause AND the euphemism-blocklist+self-check into the 3 per-flow files (not just turn-vs-run) so all four are consistent; T264's four-table grep then checks all four for both token sets.","[codex,grok,minimax] T259 acceptance is too vague. Require explicitly: (a) the HO26 repro — mixed+empty blockingQuestions THROWS post-fix (and note it succeeded pre-fix); (b) all three status×empty-field combos — mixed+[], answers-required+[] (blockingQuestions), user-action-required+[] (handoffReasons) — each THROWS SchemaValidationError; (c) the valid non-empty counterparts SUCCEED + drained/illness with empty still succeed; (d) BOTH createItem and updateItem (effective-fields) paths; (e) BOTH InMemoryLedgerStore and FsLedgerStore (Fs on temp fixtures).","[codex,grok] T260 reads as scope-creep inside the enforcement milestone. Reframe to DEFAULT-DEFER: the load-bearing non-empty checks (T257-T259) fully close the reproduced HO22/25/26 launder; the cross-ledger open-question-resolution (A) is implemented ONLY if trivially cheap given F2 plumbing, else deferred-with-rationale; the `drained` predicate-gate (B) defers to the prompt layer. T260 is a cheap scope-DECISION (already a DAG leaf — nothing depends on it), not optional implementation work that blocks M103."]
- ledgerRefs: ["goals:G32"]
- sessionLogs: ["docs/logs/20260608-110324-af50ed222aaddb4a5.md","docs/logs/20260608-110324-pi-codex.md","docs/logs/20260608-110324-pi-grok.md","docs/logs/20260608-110324-pi-minimax.md"]

### R311 — revise

- createdAt: 2026-06-08T11:10:53.681Z
- updatedAt: 2026-06-08T11:10:53.681Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G32 plan ROUND 2 REVISE (opus go-ahead; codex+grok+minimax revise). All 3 R310 fixes verified. Two genuinely-valid new points + artifacts. Substantive: (A) reproduce-first — the enforcement task must write the FAILING repro first (confirm the mixed+empty write SUCCEEDS pre-fix = D39 reproduced) then fix, green-merge-compatible; (B) advance.md (T261/T262) must also carry the enforced-invariant prose, not only the 3 per-flow (T263); (C) T264 name the explicit 2-token-set × 4-prompt matrix. The 'T257/T258 too terse / re-anchor both-stores + no-schema-change' criticisms are ARTIFACTS of the abbreviated round-2 prompt — the actual ledger tasks already cite D29/F2 + SchemaValidationError + 'both stores route through applyCreateItem' + 'do NOT change any HANDOFFS_SCHEMA field'."
- new_questions: []
- criticism: ["[codex] Reproduce-first (CLAUDE.md §6a): the enforcement task must FIRST author the minimal repro assertion (createItem('handoffs', mixed, blockingQuestions:[]) should throw) and confirm it FAILS against the unmodified store (the bad write currently SUCCEEDS = D39 reproduced; capture it in the session log), THEN add the helper+wiring so it passes. The per-task green-merge constraint forbids committing a red test on a branch, so this is satisfied by demonstrating TEETH within the enforcement task (the bad write succeeds without the assertion). T259 must also demonstrate the reproduction (bad write succeeds without the enforcement).","[codex,grok] advance.md (the 4th *:advance prompt) must ALSO carry the enforced-invariant prose (a standalone mixed/answers-required handoff REQUIRES a non-empty blockingQuestions[], user-action-required a non-empty handoffReasons[], else the @cq/ledger write THROWS) — currently only T263 (the 3 per-flow) adds it. Add it to T262's scope (advance.md) so all four prompts are consistent.","[codex,grok,minimax] T264 acceptance: name the EXPLICIT matrix — 2 token sets (turn-vs-run clause; euphemism-blocklist + self-check) × 4 prompt files (advance.md + plan/investigate/implement advance.md) = 8 cells all populated; FAILS if any cell is missing."]
- ledgerRefs: ["goals:G32"]
- sessionLogs: ["docs/logs/20260608-111023-g32-round2-panel.md","docs/logs/20260608-110324-af50ed222aaddb4a5.md"]

### R312 — revise

- createdAt: 2026-06-08T11:16:44.885Z
- updatedAt: 2026-06-08T11:16:44.885Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G32 plan ROUND 3 (opus + codex go-ahead; grok revise). grok's revise: (1) M104 'self-reference [deps M104]' — MISREAD, M104 dependsOn ['M103'] (verified); (2) T261/T262 same-file split + W1-W4 fragmentation — granularity judgment (opus+codex accept; maps to the 3 fix layers + verify); (3) T260 scope-decision should PRECEDE implementation — semi-valid, ADDRESSED: T260 reframed as an up-front ZERO-CODE deferral (deps [], decides to DEFER both stretch hardenings — cross-ledger + drained-gate — so it gates/alters nothing). Only the T260 reframe was applied; the self-dep is false and the fragmentation is the intended layer mapping."
- new_questions: []
- criticism: ["[grok] T260 (stretch scope-decision) was sequenced AFTER the helper/tests; a scope decision conceptually precedes the implementation it could affect. FIXED: T260 reframed as an UP-FRONT zero-code deferral (dependsOn [] — it now precedes/parallels W1), explicitly DEFERRING both optional hardenings (the load-bearing non-empty checks fully close the reproduced launder), so it implements nothing and gates nothing."]
- ledgerRefs: ["goals:G32"]
- sessionLogs: ["docs/logs/20260608-111023-g32-round3-panel.md"]

### R313 — go-ahead

- createdAt: 2026-06-08T11:18:45.516Z
- updatedAt: 2026-06-08T11:18:45.516Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "G32 plan ROUND 4 GO-AHEAD (opus confirming reviewer; reconciled with codex go-ahead round 3). The sole remaining R312 point (T260 ordering) is fixed — T260 verified as an up-front zero-code deferral (deps [], no code, gates nothing). grok's round-3 'M104 self-reference' was a verified misread (M104 dependsOn ['M103']); its fragmentation concern is the intended 3-layer + verify mapping (opus+codex accept). Plan complete + acyclic + grounded against real code (applyCreateItem L309 / applyUpdateItem L259 / assertGoalPhasePreconditions L808 / no-DSL note ~L789 / HANDOFFS_SCHEMA L343 with fields correctly left required:false / all four *:advance prompts). Reproduce-first + dual-adapter + grep-invariant + verify present. Ready to lock."
- criticism: []
- new_questions: []
- ledgerRefs: ["goals:G32"]
- sessionLogs: ["docs/logs/20260608-111023-a18b40d5596a3b471.md"]

## M108

### R324 — revise

- createdAt: 2026-06-08T17:17:21.876Z
- updatedAt: 2026-06-08T17:17:21.876Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- summary: "G34 plan review round 1 (panel: opus[claude] + minimax[pi:ollama-cloud]; grok+codex[pi:grok-build] DROPPED — operational stall). Reconciled verdict REVISE (both survivors revise). Plan is well-sequenced and parts 1+3 are solid; the load-bearing fix is part 2's missing source-of-truth for the structured inputs/outputs/IO-schema fields."
- new_questions: []
- criticism: ["[opus] Part 2 (Agents tab) has NO defined source of truth for the STRUCTURED inputs/outputs/input-output-schema fields Q148+goal require. cq-assets agent .md files carry only frontmatter (name/description/disallowedTools) + prose body; parseAgentMarkdown (T275) extracts only {frontmatter,body}, so codegen can derive description + prompt-template body but NOT inputs/outputs/schemas. A hardcoded per-role table in the codegen script reintroduces the manual-drift Q147 chose codegen to avoid, AND is invisible to the T277 freshness test (regen reproduces the same hardcoded data). FIX: name the source of truth — preferred per Q147 'stay in sync': add a STRUCTURED inputs/outputs/ioSchema convention (frontmatter or a parseable section) to the cq-assets agent+command files and have codegen PARSE it (so freshness genuinely guards it); add the task(s) to introduce that structured data to the assets. (Alternative, weaker: explicitly scope those fields as hand-curated outside the freshness guard.)","[opus] T275 parseAgentMarkdown spec says extract frontmatter 'tools', but the real cq-assets frontmatter uses 'disallowedTools' (+ 'isolation' on implement-worker), not 'tools' — fix the field mapping to the real keys or the tools field is empty for every role.","[minimax] W3 sequencing: T278 (Agents tab) depends only on T276, but it consumes the AgentRole types / AGENT_ROLES export defined in T275 — add T275 to T278's dependsOn (or merge T275/T276).","[minimax] T276 acceptance 'documents why committed...' is a code comment, not a testable criterion — keep the rationale as a code comment and let the testable acceptance be 'script writes the .gen.ts + typecheck green + byte-deterministic re-run'; the committed-equals-regenerated equality is T277's job.","[minimax] T270 acceptance conflates grammars: 'parse token KEY (alias or parseReviewerToken grammar)' — 'alias' resolution must cite where aliases are parsed ([aliases] table) or be removed; keep it unambiguous and grounded.","[minimax] T272 names 'tui, cli' as TS consumers, but frontends are pure MCP clients and cq-cli does not depend on cq-config — restate the audit to name the ACTUAL files/symbols touched (cq-config + ledger-mcp config capability) rather than a loose 'audit+update' list.","[minimax] T273 should add an explicit absent-[tiers]-section test at the config-load level (parseTiers / parseConfig with no [tiers] => tiers=null), not only the end-to-end resolveAgentModel path.","[minimax] T267 acceptance is a negative rg check only — add a positive assertion that the tab-state union contains 'item-states' AND HelpOverlay renders the renamed tab.","[minimax] W4 T280 dependsOn skips implementation tasks (T268/T271/T275/T276/T278 etc.) — list the full set it verifies (or restate so an incomplete upstream tree makes T280 fail), so the final gate cannot 'pass' against an incomplete tree.","[minimax] T275 should add a parseAgentMarkdown unit-test acceptance (exercise the parser on a fixture), not only the 'no node:fs import' check."]
- ledgerRefs: ["goals:G34"]
- sessionLogs: ["docs/logs/20260608-171607-af1c0c727cb095306.md","docs/logs/20260608-171607-pi-minimax-review.md","docs/logs/20260608-171607-pi-grokbuild-reviewers.md"]

### R325 — go-ahead

- createdAt: 2026-06-08T17:23:35.779Z
- updatedAt: 2026-06-08T17:23:35.779Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- summary: "G34 plan review round 2 (panel: opus[claude] + minimax[pi:ollama-cloud]; grok+codex[pi:grok-build] excluded — documented operational stall this run). Reconciled verdict GO-AHEAD (both survivors go-ahead). All 10 R324 criticisms confirmed resolved on the merits; the load-bearing source-of-truth fix (`## Catalogue` convention in T275 + T281 authoring it into the assets + T276 parsing it + T277 freshness guard) is coherent, parseable, and correctly sequenced (T276 dependsOn [T275,T281]); revisions introduced no new plan defects. Minor non-blocking grounding notes for implementers: cq.toml.example is at repo root (two levels up); use parseConfig not loadConfig to read it; orchestrator command frontmatter (description/argument-hint/allowed-tools) differs from agent frontmatter but the `## Catalogue` block is the authoritative structured source regardless."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G34"]
- sessionLogs: ["docs/logs/20260608-172307-a279480bcb33c7fd1.md","docs/logs/20260608-172307-pi-minimax-review2.md"]

### R326 — go-ahead

- createdAt: 2026-06-08T17:39:41.578Z
- updatedAt: 2026-06-08T17:39:41.578Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- summary: "G34 follow-up-extension review (panel: opus[claude] + minimax[pi:ollama-cloud]; grok+codex[pi:grok-build] excluded — documented operational stall). Reconciled GO-AHEAD (both go-ahead). The privilege(RO/RW)+exposed-tools extension is grounded against the real agent/command frontmatter, DERIVES mechanically per locked Q151-Q153 (subagent deny-list 5-tool rule; command allow-list 3-tool rule), leaves T281 frontmatter/prose untouched (Catalogue holds only inputs/outputs/ioSchema), and folds into the existing W3 tasks (T275/T276/T278/T279/T281) without disturbing the R325-approved base or its sequencing. NON-BLOCKING NOTES (no action needed; recorded for implementers): (1) implement-reviewer's frontmatter omits Bash from disallowedTools, so the strict Q151 rule derives it as RW — a faithful consequence of the locked rule; the plan pins no implement-reviewer outcome in acceptances, so it is self-consistent. (2) T281's anti-authoring guard is a prose NOTE, not parser-enforced (stylistic, consistent with base style)."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G34"]
- sessionLogs: ["docs/logs/20260608-173914-afe412ded4d773ce0.md","docs/logs/20260608-173914-pi-minimax-review3.md"]

## M109

### R327 — go-ahead

- createdAt: 2026-06-08T18:18:11.896Z
- updatedAt: 2026-06-08T18:18:11.896Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- summary: "T267 implement review APPROVE (panel: opus[claude] approve; minimax[pi:ollama-cloud] abstained — inert tool-call under --no-tools, no verdict; grok+codex[pi:grok-build] excluded, documented stall). Rename State Machines→Item States complete: every DOM id/class/testid/label migrated to the item-states scheme, bun run check green 1136/0, no Shortcuts/Flows/TUI scope creep (lone leftover is an out-of-scope JSDoc comment in untouched stateMachine.ts)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T267","goals:G34"]
- sessionLogs: ["docs/logs/20260608-181727-a0ebdfdbc5ec7ed80.md","docs/logs/20260608-181727-pi-minimax-T267.md"]

## M110

### R328 — go-ahead

- createdAt: 2026-06-08T18:18:11.979Z
- updatedAt: 2026-06-08T18:18:11.979Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- summary: "T268 implement review APPROVE (panel: opus[claude] + minimax[pi:ollama-cloud] both approve; grok+codex[pi:grok-build] excluded, documented stall). TiersConfig TYPE inverted to token-keyed classifier (entries: ReadonlyArray<TierEntry>); no per-tier ReviewerToken slot remains in types.ts; four minimal compile-bridges (parseTiers/resolveTierToken/configCapability wire-slots/2 test assertions) within the sanctioned scope-guard envelope, downstream rework correctly deferred to T270/T271/T272/T273; bun run check green (1135 pass/1 skip/0 fail)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T268","goals:G34"]
- sessionLogs: ["docs/logs/20260608-181727-a5a19d637a6699421.md","docs/logs/20260608-181727-pi-minimax-T268.md"]
