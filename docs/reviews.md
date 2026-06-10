---
ledger: reviews
counters:
  milestone: 0
  item: 429
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
  - id: M111
    path: ./archive/reviews/M111.md
    summary: "G34 W3 complete: Agents-tab build-time catalogue codegen + new web Agents tab. T275 (AgentRole model + parseAgentMarkdown + formatExposedTools), T281 (## Catalogue blocks in all 19 role assets), T276 (gen-agents codegen → committed agentsCatalogue.gen.ts, 19 roles), T277 (freshness/drift test), T278 (Agents tab in HelpOverlay — privilege badge + exposed tools + folded prompt), T279 (happy-dom tests) all done; reviews R333-R338 go-ahead. bun run check green; nix build .#ledger-web green."
    title: "G34-W3: Agents tab — build-time catalogue codegen from cq-assets + new web Agents tab"
    status: done
  - id: M114
    path: ./archive/reviews/M114.md
    summary: "G35 W1 complete (fixes D42): T282 added a class-agnostic duplicate-token guard to parseTiers (throws CqConfigError naming both conflicting [tiers] keys before entries.push) + tests; reworked the pre-existing contradictory VALID_TOML_WITH_TIERS fixture. R340 go-ahead. D42 resolved. bun run check green 1224/0."
    title: "G35-W1: fail-loud dup-token [tiers] classification in parseTiers + tests"
    status: done
  - id: M110
    path: ./archive/reviews/M110.md
    summary: "G34 W2 complete: cq-config [tiers] inverted to (harness+provider+model)->class classifier. T268 (TiersConfig type → entries classifier), T270 (parseTiers token-keyed), T271 (classifyToken/selectTokensForTier; resolveTierToken removed; resolveAgentModel re-pointed), T272 (consumer audit — no external consumers), T273 (classifier test suite), T274 (cq.toml.example + docs + example-load test) all done; reviews R327-R332 go-ahead. Defect D42 (filed during T271, dup-token fail-loud) resolved by T282/G35. nix build .#ledger-mcp green."
    title: "G34-W2: cq-config — invert [tiers] to (harness+provider+model)→class classifier"
    status: done
  - id: M116
    path: ./archive/reviews/M116.md
    summary: G34 ff#2 W1 — get_agent_models server capability. T283 (AgentModelsResult 4-state wire shape on ConfigCapability), T285 (computeAgentModels over the shared 19-role AGENT_ROLE_TIERS roster, deriveModelMappings parity), T287 (get_agent_models MCP tool, stdio+HTTP) all done + reviewed (R345/R347/R349 go-ahead). Merged to main.
    title: "G34-ff2 W1: get_agent_models server capability (live model overlay)"
    status: done
  - id: M117
    path: ./archive/reviews/M117.md
    summary: G36 W1 — @cq/config effort core. T284 (per-harness PI_EFFORTS/CLAUDE_EFFORTS + isEffort + optional ReviewerToken.effort), T286 (parseReviewerToken last-colon effort split, reserved ':' both halves, fail-fast), T288 (formatReviewerToken round-trip), T290 (effort in reviewerTokensEqual identity) all done + reviewed (R346/R348/R352/R354 go-ahead). Merged to main.
    title: "G36 W1: effort grammar — @cq/config core (parse/format/identity/enums)"
    status: done
  - id: M118
    path: ./archive/reviews/M118.md
    summary: G34 ff#2 W2 — ledger-web client + live overlay. T289 (getAgentModels on LedgerClient/McpLedgerClient, catch-any-error), T291 (FakeClient 4-state + throw modes), T293 (mount fetch + overlay state + AgentModelCell), T295 (resolved token chips), T297 (Q159 agentsTab overlay tests) all done + reviewed (R351/R353/R356/R359/R360 go-ahead). Merged to main.
    title: "G34-ff2 W2: ledger-web LedgerClient + live overlay render"
    status: done
  - id: M119
    path: ./archive/reviews/M119.md
    summary: G36 W2 — effort wire-through + pi-extension. T292 (optional effort on get_planners/get_reviewers/get_config wire shapes), T294 (inlined cq-subagent-dispatch resolver mirror; pi effort via --model …:<effort> shorthand, claude inert) all done + reviewed (R355 + R354/T292 go-ahead). Merged to main.
    title: "G36 W2: effort wire-through — MCP capability + cq-subagent-dispatch"
    status: done
  - id: M120
    path: ./archive/reviews/M120.md
    summary: "G34 ff#2 W3 — drop build-time model fields + verify. T299 (removed model/modelMappings from AgentRole + gen-agents + App.tsx static rows; overlay AgentModelCell is sole model display; freshness test narrowed), T300 (final verify: bun run check 1290/0 + nix build .#ledger-mcp/.#ledger-web exit 0) done + reviewed (R361/R362 go-ahead). Agents tab shows ONLY live-configured models."
    title: "G34-ff2 W3: narrow build-time catalogue to static fallback + verify"
    status: done
  - id: M121
    path: ./archive/reviews/M121.md
    summary: "G36 W3 — docs + verify. T296 (cq.toml.example + token-format docs for the :<effort> suffix; reserved ':' both halves, per-harness enums, pi --model shorthand), T298 (G36 verify: bun run check 1286/0 + nix build .#ledger-mcp exit 0) done + reviewed (R357/R358 go-ahead). Merged to main."
    title: "G36 W3: docs, cq.toml.example, full check + nix build"
    status: done
  - id: M86
    path: ./archive/reviews/M86.md
    summary: G28 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Enabled pi-harness subagent support for the cq flow; work milestones M87-M91 delivered (K44-K46 decisions, R265-R268 reviews). Closed + archived in the post-G37 cleanup sweep.
    title: "Plan: pi-agent subagent support for cq flow"
    status: done
  - id: M91
    path: ./archive/reviews/M91.md
    summary: G28 W5 (pi subagent dispatch acceptance demo) COMPLETE — all tasks terminal. Archived in the post-G37 cleanup sweep.
    title: Pi subagent dispatch — acceptance demo
    status: done
  - id: M92
    path: ./archive/reviews/M92.md
    summary: G29 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Provider-qualified pi token grammar (pi:<provider>/<model>); D36 resolved; work milestone M94 delivered (K47, R277-R278). Archived in the post-G37 cleanup sweep.
    title: "Plan: provider-qualified token support in cq config"
    status: done
  - id: M93
    path: ./archive/reviews/M93.md
    summary: G30 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Added the user-action-required handoff status threaded through the flow prompts/schema; work milestones M97-M101 delivered (K49, R282-R284). Archived in the post-G37 cleanup sweep.
    title: "Plan: user-action-required handoff status"
    status: done
  - id: M95
    path: ./archive/reviews/M95.md
    summary: G31 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Fixed D38 (pinned the cq verdict enum on the Pi subagent path + fail-loud off-enum validation); work milestone M96 delivered (K48, R279-R281). Archived in the post-G37 cleanup sweep.
    title: "Plan: fix D38 — pin verdict enum on the Pi subagent path"
    status: done
  - id: M102
    path: ./archive/reviews/M102.md
    summary: G32 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Fixed D39 (write-time handoff stop-gate invariant enforcement + turn-vs-run clause + euphemism blocklist); work milestones M103-M106 delivered (K51, R310-R313). Archived in the post-G37 cleanup sweep.
    title: "Plan: fix D39 — enforce handoff stop-gate invariants (make effort-stops unwritable)"
    status: done
  - id: M108
    path: ./archive/reviews/M108.md
    summary: G34 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Help-popup Item-States rename + Agents tab + cq.toml [tiers] triplet mapping + the two follow-ups (privilege/exposed-tools; live-model runtime overlay via get_agent_models); work milestones M109-M112/M116/M118/M120 delivered (K54/K55/K57, R324-R343). Archived in the post-G37 cleanup sweep.
    title: "Plan: help-popup item-states rename + Agents tab + tiers triplet mapping"
    status: done
  - id: M109
    path: ./archive/reviews/M109.md
    summary: G34 W1 (Item-States rename) COMPLETE — all tasks terminal. Archived in the post-G37 cleanup sweep.
    title: "G34-W1: ledger-web help popup — rename State Machines → Item States (label + ids/testids/CSS)"
    status: done
  - id: M113
    path: ./archive/reviews/M113.md
    summary: G35 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Fixed D42 (fail-loud on duplicate-token [tiers] classification in parseTiers); work milestone M114 delivered (K56, T282). Archived in the post-G37 cleanup sweep.
    title: "Plan: fix D42 — fail-loud on duplicate-token [tiers] classification in parseTiers"
    status: done
  - id: M115
    path: ./archive/reviews/M115.md
    summary: G36 coordination COMPLETE — goal closed done (user-authorized 2026-06-09). Optional thinking-effort suffix in cq model-identifier tokens; work milestones M117/M119/M121 delivered (K58, R342-R344). Archived in the post-G37 cleanup sweep.
    title: "Plan: optional thinking-effort suffix in cq model-identifier tokens"
    status: done
  - id: M129
    path: ./archive/reviews/M129.md
    summary: G38 item 2 (flows-tab per-role action diagrams, web-only) COMPLETE. T315 (roleActions.ts ROLE_FLOWS catalogue) + T316 (render Flows tab from ROLE_FLOWS via existing DiagramSvg, replacing flowData state diagrams; + latent DiagramSvg multigraph React-key fix). Reviews R377/R381 go-ahead. Merged ba7b026 + c875921. bun run check green.
    title: G38 item 2 — flows-tab per-role action diagrams (ledger-web, web-only)
    status: done
  - id: M130
    path: ./archive/reviews/M130.md
    summary: G38 item 3 (TUI focus-respecting paging/jump keybindings, defect-aware) COMPLETE. T318 (LIST-focus PgUp/PgDn page cursor by listInnerH + Home/End jump rows; no-Enter detail-scroll removed; module-scope matchHomeEnd helper) + T319 (CONTENT-focus Home/End reusing matchHomeEnd). Defect D44 RESOLVED. T320 abandoned (tests folded into T318/T319). Reviews R378/R382 go-ahead. Merged 46a0f95 + 0992cd3. bun run check green.
    title: G38 item 3 — TUI focus-respecting paging/jump keybindings (defect-aware)
    status: done
  - id: M127
    path: ./archive/reviews/M127.md
    summary: "G38 item 1a (implement-worker worktree auto-cleanup, prompt-only) COMPLETE. T308 (advance.md §7.3 explicit per-merge teardown), T309 (advance.md §1 start-of-pass orphan/locked sweep gated to terminal-task worktrees), T310 (implement-worker.md worktree-lifetime note), T311 (canonical-ledgers.test.ts grep-invariant cells over sources + gen.ts). T322 abandoned (freshness-guard discovery: each catalogued-asset edit regens gen.ts, so the last 1a edit produces the final cumulative gen.ts — a separate regen is a no-op; T311's gen.ts assertions are the committed guard). Markers G38-1a-post-done-cleanup/start-sweep/worker-ephemeral all present in sources + agentsCatalogue.gen.ts. Reviews R375/R379/R383/R384 go-ahead. Merged 4eca303/c6c723e/b61ae54/5dbae6b. bun run check green."
    title: G38 item 1a — implement-worker worktree auto-cleanup (prompt-only)
    status: done
  - id: M131
    path: ./archive/reviews/M131.md
    summary: "G38 cross-cutting verification COMPLETE. T321 final-verify PASS (orchestrator-run, R385 go-ahead): bun run check 1332/0; grep-invariant markers G38-1a-post-done-cleanup/start-sweep (advance.md) + worker-ephemeral (implement-worker.md) each =1; §5 'worktree INTACT' intact; nix build .#ledger-mcp/.#ledger-tui/.#ledger-web all exit 0. All G38 items 1a/1b/2/3 landed + verified."
    title: G38 — cross-cutting verification (full check + grep-invariant audit + nix builds)
    status: done
  - id: M133
    path: ./archive/reviews/M133.md
    summary: "D45 fix COMPLETE. T323 (cacheMirror.mirrorMutation now mirrors layout.registryPath on op==='create'||'archive' — before the archive-only early return; 'update' excluded; archive-dir enumeration unchanged; docstring updated; reproduce-first createLedger mirror test: ENOENT before, byte-equal after). Reviewed go-ahead R388. Merged 367654c. D45 RESOLVED. bun run check green 1333/0."
    title: Fix D45 — mirror docs/ledgers.yaml on the 'create' op in cacheMirror
    status: done
  - id: M128
    path: ./archive/reviews/M128.md
    summary: G38 item 1b (ledger ~/.cache mirror backup + restore CLI) COMPLETE. T312 (@cq/ledger onMutation-driven ~/.cache mirror + shared exported cacheMirrorDir + fsAtomic extraction; fire-and-forget drained by dispose()) + T313 (ledger-mcp `restore --from-cache [--cwd]` positional subcommand reusing cacheMirrorDir + atomic copy-back; main.ts header updated; nix build .#ledger-mcp green). Out-of-scope defect D45 (filed by T312 review) RESOLVED via G39/T323 (registry-on-create mirror). Reviews R376/R380 go-ahead. Merged b681160/e9ad2df. bun run check green.
    title: G38 item 1b — ledger ~/.cache mirror backup + restore CLI
    status: done
  - id: M134
    path: ./archive/reviews/M134.md
    summary: "G38 follow-up #1 (ledger-web help-popup UX + deepened Flows tab) COMPLETE. 6 tasks: T324 FU-2 (.lw-help hard 90vw×90vh + pinned head), T325 FU-1 (AgentModelCell stale-server message), T326 FU-4 renderer+data foundation (agentId on DiagramNode/RoleNode + exported RoleKind/ROLE_KIND_FILL/fillForRoleKind + clickable/keyboard DiagramSvg nodes; renderer fill unchanged per Q181), T327 FU-4a/c/d catalogue (agentId map ∈ AGENT_ROLES + all formalized ops as edges/worktree-main-ledger infra nodes grounded in cq-assets prompts + roleKind fills), T328 FU-3 (HelpDocsLayout sidebar + IntersectionObserver scrollspy + exported scrollToHelpSection), T329 FU-4b/d (agentId-node cross-nav to Agents tab + roleKind legend). Reviews R392-R397 go-ahead (T325 took 1 criticism round). Merged 04cc14d/82c0b66/fe7205f/b2a9b9f/891a39f/768a10d. bun run check green 1368/0; nix build .#ledger-web exit 0. FU-1's underlying Agents-tab display issue is a deploy action (rebuild+restart), out of scope."
    title: "G38 follow-up #1 — ledger-web help-popup UX + deepened Flows tab"
    status: done
  - id: M122
    path: ./archive/reviews/M122.md
    summary: "G37 (Fix D43 — worktree-confine implement-worker + commit ledger after planning-lock and every merge) DONE: cq-assets prompt edits landed (T305–T307), grep-invariant guard + documented repro green under bun run check; D43 resolved. Goal closed; coordination milestone archived."
    title: "Plan: fix D43 — worktree-confine implement-worker + commit ledger after planning/every-merge"
    status: done
  - id: M132
    path: ./archive/reviews/M132.md
    summary: "G39 (Fix D45 — mirror docs/ledgers.yaml on the 'create' op in cacheMirror) DONE: cacheMirror.ts mirrors layout.registryPath on op==='create'||'archive' + XDG_CACHE_HOME-redirected byte-equality test (T323); D45 resolved. Goal closed; coordination milestone archived."
    title: "Plan: fix D45 — cache mirror omits ledgers.yaml on createLedger"
    status: done
  - id: M136
    path: ./archive/reviews/M136.md
    summary: "G41 item 1 COMPLETE (cq init writes cq.toml): T331 CQ_TOML_TEMPLATE constant in cq-cli (opus/sonnet/haiku active, pi commented) + synced cq.toml.example + parity/string-equality tests; T338 runInit writes cq.toml with skip-if-exists + --force overwrite per Q184. Reviews R401/R404 go-ahead. bun run check green. Merged 03a3ac7 (+ T331 e2179a3)."
    title: G41-1 cq init writes cq.toml
    status: done
  - id: M137
    path: ./archive/reviews/M137.md
    summary: "G41 item 4 COMPLETE (Flows-tab polish, web): T332 underline on activatable DiagramSvg node labels; T333 withTerminalNodes derives terminal:true on zero-outgoing-edge nodes (rx=4 vs rx=14) across all 4 ROLE_FLOWS; T334 parallel-edge labels get distinct per-index testids (ELK already routes them 30-34px apart — no visual overlap; the defect was a testid collision) + docs/drafts label audit. Reviews R403/R405/R408 go-ahead. bun run check green. Merged 3f14794/18d73dc/565500b."
    title: G41-4 Flows-tab polish (web)
    status: done
  - id: M139
    path: ./archive/reviews/M139.md
    summary: "G41 item 2 COMPLETE (formal typed MCP prompt catalog): T336 typed PromptCatalogEntry model + RoleKind split + plan-advance JSON Schemas in @cq/config (Ajv2020 + FOD refresh; K65 locked); T341 catalog store + 7 dispatched-role schema sidecars + gen-agents emits typed schemas (deterministic, drift-guarded, ledger-mcp-importable); T343 fetch_prompt/validate_input/validate_output MCP tools (both stdio+SDK factories); T344 plan-advance dispatch wired through the catalog (proof) + Agents tab renders typed schemas; T345 all 7 dispatched subagents wired at plan/implement/investigate advance.md + duplicated prose ioSchema removed. Reviews R410-R414 go-ahead. bun run check green (1486). Merged bcafd66/b502a61/dc87ba7/c2fa526/a873912."
    title: G41-2 Formal typed MCP prompt catalog
    status: done
  - id: M140
    path: ./archive/reviews/M140.md
    summary: "G41 item 3 COMPLETE (orphan-branch feasibility SPIKE): T337 — verdict FEASIBLE-WITH-CAVEATS (GO) in locked decision K66, with an executed throwaway PoC proving the pure git-plumbing path (hash-object→scratch-index write-tree→commit-tree→CAS update-ref) advances an orphan ledger ref while the main checkout HEAD/worktree/index stay byte-identical; findings doc docs/drafts/20260609-221530-orphan-ledger-feasibility.md + PoC under debug/; no production code. A separate follow-up goal would implement a GitObjectLedgerBackend + drop the per-merge chore(ledger) commits + explicit push/fetch of the orphan ref. Review R415 go-ahead. Merged e108827."
    title: G41-3 Ledger-on-orphan-branch feasibility spike
    status: done
  - id: M142
    path: ./archive/reviews/M142.md
    summary: "G42 (fix D47) COMPLETE: T346 (test-only, canonical-ledgers.test.ts) — the committed-vs-canon guard now boots with onSchemaDivergence:'abort' (structural drift THROWS instead of silently self-healing via the default backup-reinit) + a byte-equality assertion (committed docs/ledgers.yaml === serializeRegistry(CANONICAL_LEDGERS)) under bun run check + a reproduce-first proving the old default self-heals while abort rejects. D47 RESOLVED. Review R417 go-ahead. bun run check green (1488). Merged ffce89c."
    title: "G42-fix: ledgers.yaml drift guard fails check"
    status: done
  - id: M138
    path: ./archive/reviews/M138.md
    summary: "G41 item 5 COMPLETE (Ideas ledger + idea-id command args): T335 ideas ledger schema in CANONICAL_LEDGERS (idPrefix I; title+description; open|planned|discarded|postponed, postponed→open); T339 'Ideas' sidebar group above Goals (flat list, generic updateItem); T340 /cq:plan accepts idea-ids (one goal per idea + named consume-an-idea sub-procedure); T342 /cq:plan:follow-up appends idea scope (DRY-references the sub-procedure). Defect D47 (filed by the T335 review) investigated→root-caused (H34)→fixed via G42/T346 and RESOLVED. Reviews R402/R406/R407/R409 go-ahead. bun run check green. Merged 9feb683/a39fd94/6aedb28/02ceded."
    title: G41-5 Ideas ledger + idea-id command args
    status: done
  - id: M144
    path: ./archive/reviews/M144.md
    summary: "G43-W1 complete: extracted the LedgerPersistence byte-I/O seam (T347), the AbstractLedgerStore base holding all persistence-agnostic logic over that seam (T350), and FsLedgerStore reimplemented as base + FsPersistence (T351, co-delivered in b7c64ce). Behaviour-preserving — full ledger suite green unchanged (1488/0/1skip); both merges adversarially reviewed (R420, R421). Seam is ready for the GitPersistence impl in M145."
    title: "G43-W1: extract LedgerStore persistence seam + AbstractLedgerStore base (Q190)"
    status: done
---

# reviews

## M126

### R372 — revise

- createdAt: 2026-06-09T12:12:07.035Z
- updatedAt: 2026-06-09T12:12:50.106Z
- author: "opus-4.8[1m]"
- session: 242ca46f-d593-40f1-9dc2-480c12cf887c
- summary: "REVISE (G38 round 1; full panel opus[claude]+codex+grok+minimax[pi], 4/4 usable, all revise → reconciled revise). Plan is fine-grained/acyclic/grounded/complete, but the agentsCatalogue.gen.ts regen for the advance.md edits is mis-sequenced (LOAD-BEARING, opus-verified against gen-agents-catalogue.ts L106/L142), the standalone test tasks are vague/duplicative, and several groundings/acceptances need correction. 0 new_questions, 0 out-of-scope defects."
- new_questions: []
- criticism: ["[opus] LOAD-BEARING: T308's parenthetical ('gen-agents covers agents/, not commands/ — no regen needed for a command file') is FALSE — VERIFIED against gen-agents-catalogue.ts: ROLES (L106) catalogues commands/cq/implement/advance.md (id 'implement/advance') and buildRole (L142) captures its full body as promptTemplate. Adding the markers to advance.md's BODY therefore DOES change agentsCatalogue.gen.ts and requires `bun run gen-agents`. Correct the justification.","[opus] Mis-sequencing + scope gap: T310 was the only task running gen-agents but had no dependsOn on T308/T309 and scoped the regen only around implement-worker.md; the advance.md body edits would silently desync agentsCatalogue.gen.ts, uncaught by T311/T321 which grep only the .md sources. FIX: make the gen-agents regen its OWN task depending on T308+T309+T310, and add a committed assertion that the regenerated gen.ts 'implement/advance' promptTemplate contains both advance.md markers.","[codex][grok] T309's dependsOn T308 has no logical prerequisite — the §1 sweep and §7.3 teardown edit disjoint sections of advance.md. Reconcile: re-justify the edge explicitly as SAME-FILE serialization (avoid a concurrent-worktree merge conflict on advance.md).","[codex][grok] T310 read as unjustified scope vs Q167 + used inconsistent 'post-merge teardown' vs the locked 'after the per-task done write' terminology. Resolve against the [opus] finding (regen IS required): keep worker.md alignment as item-1a prompt scope, align terminology, move the regen to its own sequenced task.","[codex][grok] Standalone test tasks T314/T317/T320 are vague 'consolidated/dedupe' meta-tasks while the impl acceptances already enumerate the same tests — and a separate test task is incoherent for this flow (each impl worktree must pass `bun run check` WITH its own tests). FIX: fold the test cells into the owning impl tasks and DROP T314/T317/T320.","[codex] D44 severity 'minor' vs Q172 'low/medium' — align it (defect already filed; no separate filing task needed).","[codex] T318/T319 'shared helper' for raw Home/End ESC sequences is unscoped — name the module/function (a module-level helper in ledger-tui/src/app.tsx, reused by both focus branches).","[grok] T312 mandates a new FsLedgerStoreOpts flag not implied by Q168/Q169; the only test-affordance needed is honoring XDG_CACHE_HOME. Drop/soften the flag.","[grok] T308 acceptance hinges on the literal 'Claude: auto' — VERIFIED present (implement/advance.md L310-311), so grounded; keep but phrase robustly.","[opus][codex][minimax] T313 adding `restore` CONTRADICTS the main.ts header (L23-24: lifecycle ops live in the `cq` CLI; 'this server only serves the tool surface') — VERIFIED main.ts only parses --cwd/--http. T313 must ALSO update that header comment.","[grok][minimax] T317's '(dedupe with T315)' mislabels its sibling (should be T316) — mooted by dropping T317.","[minimax] T310's acceptance mixes byte-faithful + contains-marker invariants — split (handled by moving the regen to its own task with split acceptance)."]
- ledgerRefs: ["goals:G38"]
- sessionLogs: ["docs/logs/20260609-121211-aae48f37b94d78869.md","docs/logs/20260609-121211-pi-codex.md","docs/logs/20260609-121211-pi-grok.md","docs/logs/20260609-121211-pi-minimax.md"]

### R373 — revise

- createdAt: 2026-06-09T12:23:02.922Z
- updatedAt: 2026-06-09T12:23:37.195Z
- author: "opus-4.8[1m]"
- session: 242ca46f-d593-40f1-9dc2-480c12cf887c
- summary: REVISE (G38 round 2; full panel 4/4 usable; opus+grok+minimax go-ahead, codex revise → reconciled revise STRICTEST-WINS). All 12 R372 criticisms verified resolved by all four reviewers (T308 justification, T322 regen task + gen.ts freshness guard, T309 serialization rationale, T310 scope/terminology, folded test tasks, D44=low, matchHomeEnd helper, T312 XDG affordance, T313 main.ts header update). codex raised 3 NEW minor plan-text PRECISION nits (no load-bearing/sequencing/testability/completeness defect; grok+minimax explicitly judged them non-blocking). Addressing them anyway for precision; convergent.
- new_questions: []
- criticism: ["[codex] Unify the prompt source-file references across M127: use the FULL path consistently — T308/T309 edit nix/pkg/cq-assets/commands/cq/implement/advance.md (catalogue key 'implement/advance'); T310 edits nix/pkg/cq-assets/agents/implement-worker.md (catalogue key 'implement-worker'). T311/T322 acceptance use the shorthand 'advance.md'/'implement-worker.md' — make them name the full path + catalogue key so there is no ambiguity about which artifact each marker/promptTemplate assertion targets.","[codex] T322 omits the invocation cwd for `bun run gen-agents`: the 1a edits live under nix/pkg/cq-assets/ but the gen-agents script is a package script of the cq-ledgers workspace — state explicitly that it runs from nix/pkg/cq-ledgers/ (per CLAUDE.md the bun commands run from there), to avoid an exec error.","[codex] T312's cacheMirrorDir formula writes a bare 'basename'/'sha256(absRoot)' — qualify it: path.basename(absRoot) and crypto.createHash('sha256').update(absRoot).digest('hex').slice(0,12), and have the acceptance pin the FULL computed dir name (basename + '-' + 12hex), not only the suffix regex."]
- ledgerRefs: ["goals:G38"]
- sessionLogs: ["docs/logs/20260609-122307-a07760806bf08cf92.md","docs/logs/20260609-122307-pi-codex.md","docs/logs/20260609-122307-pi-grok.md","docs/logs/20260609-122307-pi-minimax.md"]

### R374 — go-ahead

- createdAt: 2026-06-09T12:35:41.555Z
- updatedAt: 2026-06-09T12:36:29.329Z
- author: "opus-4.8[1m]"
- session: 242ca46f-d593-40f1-9dc2-480c12cf887c
- summary: "GO-AHEAD (G38 round 3; full panel 4/4 usable; opus+codex+minimax go-ahead, grok revise — ADJUDICATED non-blocking). codex (R373's own author) confirms its 3 round-2 precision nits are resolved and votes go-ahead; opus (reading the LIVE ledger) and minimax also go-ahead, confirming all R372+R373 fixes landed and the plan is fine-grained/acyclic/testable/grounded/complete. grok's lone revise is a VERIFICATION ARTIFACT, not a real plan defect: pi reviewers judge the plan TEXT supplied in the review prompt, and grok judged the round-3 prompt's COMPACT RECAP (which used shorthands like 'advance.md'/'gen.ts') as if it were the plan, concluding 'R373 #1/#3 did not land'. Validated against SOURCE (the actual ledger task items), every grok point is already satisfied: T308/T309 descriptions open 'In nix/pkg/cq-assets/commands/cq/implement/advance.md …' (full path); T310 'Update nix/pkg/cq-assets/agents/implement-worker.md …'; T322/T311 name packages/ledger-web/src/agentsCatalogue.gen.ts + the catalogue keys 'implement/advance'/'implement-worker'; T312 spells out cacheMirrorDir(absRootDir)=path.join(cacheBase,'cq','ledgers',`${path.basename(absRootDir)}-${createHash('sha256').update(absRootDir).digest('hex').slice(0,12)}`) with the full-dir-name acceptance. Because the criticism is FALSE against ground truth, the surviving real-criticism set is empty → reconciled go-ahead (citation-validation per the orchestrator's duty, NOT a laundered revise). Convergent: round1 12 substantive criticisms→fixed; round2 3 precision nits→fixed; round3 clean. Plan LOCKED."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G38"]
- sessionLogs: ["docs/logs/20260609-123546-a7dc5893fcb1df067.md","docs/logs/20260609-123546-pi-codex.md","docs/logs/20260609-123546-pi-grok.md","docs/logs/20260609-123546-pi-minimax.md"]

## M135

### R399 — revise

- createdAt: 2026-06-09T19:26:15.839Z
- updatedAt: 2026-06-09T19:27:35.451Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "REVISE (G41 round 1; full panel opus[claude]+codex+grok+minimax[pi], 4/4 usable, ALL revise → reconciled revise). Plan is well-grounded on most file/symbol claims and complete across all 5 items, but carries ~12 planner-fixable criticisms (edge-label task misdiagnosis, undefined planDoc artifact, Ajv-dependency FOD-hash omission, non-operational doc-task acceptance, ungrounded scope deviations, role-set conflation). 0 user-only questions (all fixable autonomously). 0 out-of-scope defects."
- new_questions: []
- criticism: ["[opus][codex][grok] M139 dependsOn [M136,M137,M138] and M140 dependsOn M139 OVERSTATE prerequisites: per Q183 the five are INDEPENDENT work milestones with only a work-ORDER preference (quick wins first). The prompt catalog/spike share no technical coupling with cq-init/flows/ideas. Either drop the cross-workstream edges or record them as ADVISORY ordering (not blocking prerequisites) so an unrelated milestone stall doesn't block M139.","[opus][grok] T334 misdiagnoses the edge-label defect: every ROLE_FLOWS edge ALREADY carries a non-empty label and DiagramSvg/diagramLayout already render per-edge labels by index, so T334's data-only acceptance ('no empty label' + 'parallel labels distinct') PASSES against current code WITHOUT fixing the user-visible symptom ('arrows with no labels' = a RENDERING fault on parallel/feedback edges). T334 must reproduce the rendering defect (a layout/render test asserting each parallel edge's label actually places + displays distinctly in the Flows-tab SVG) and scope the fix to the layout/render path, not just label-text authoring.","[codex][grok] T334's 'planDoc' artifact is undefined (no such file/constant/draft exists). Name a CONCRETE reviewable deliverable for the proposed edge labels (e.g. a specific docs/drafts/<ts>-flows-edge-labels.md note, or ROLE_FLOWS source comments, or a test fixture) instead of a nonexistent 'planDoc'.","[opus][codex][grok] M139/T336 may add Ajv (a validator not in the cq-ledgers workspace deps) but NO task carries the mandatory post-dependency step from CLAUDE.md: refresh the flake.nix FOD `outputHash` (52 A's → `nix build .#node-modules` → paste `got:` hash) after a `bun.lock` change — otherwise `nix build .#node-modules` breaks. Prefer a validator ALREADY in-workspace to avoid the dependency; if a new dep is unavoidable, add the FOD-refresh step to T336/T341 (or a dedicated task).","[codex][grok] T340/T342 acceptance is NON-OPERATIONAL ('rubric review confirms', 'asset-link check passes') and does not name the concrete implementation sites. Make acceptance observable (a grep/test/`bun run check` invariant) and identify the exact edit loci (cq-assets command markdown ONLY, vs any tokenization/arg-parsing/MCP-dispatch/ledgerRefs logic) for the I-id grammar + the shared consume-an-idea sub-procedure.","[codex][grok][minimax] T340's 'mixed free-text handling' is ungrounded vs Q188 (which gives a pure idea-id grammar, '/cq:plan I01 I02 I03'). Either DEFINE 'mixed' precisely (idea-ids interleaved with prose?) or DROP it and stick to Q188's grammar.","[grok][minimax] T338's 'fail-loud on symlink/dir even under --force' is UNREQUESTED scope deviating from Q184 ('--force to overwrite'). Revert T338 to Q184's literal behaviour (skip-with-message if cq.toml exists; --force overwrites) and drop the symlink/dir fail-loud (or demote it to a non-blocking safety note that does not contradict --force).","[opus][codex][grok] T336/T341/T345 conflate orchestrator-command roles (agentTierKey===null / not-model-configurable, never dispatched-with-validated-input by a parent) with dispatched-subagent roles. Distinguish them: only dispatched subagents get input/output JSON Schemas + validate-in/out wiring; T345's blanket 'every catalogued role reachable via fetch_prompt with validate-in/out' is over-broad for orchestrator commands.","[opus] T335 ships terminalStatuses:['planned','discarded'] while its OWN note leaves `planned` terminality unresolved. Decide it decisively (the consume-idea flow implies an idea moved to 'planned' stays planned → terminal) and align the transition map; do not ship a schema whose terminalStatuses is provisional/load-bearing-but-flagged.","[codex][minimax] T341's 'extend cq-assets Catalogue blocks OR sibling per-role schema files' leaves the schema STORAGE FORMAT undecided (forces an in-flight choice). Commit to ONE representation in the plan (per-role JSON Schema files, or schema fields embedded in the Catalogue blocks).","[grok] T333 mixes investigation + implementation without naming the EXACT derivation site for zero-outgoing-edge→terminal:true (inside DiagramSvg from its edges prop? a ROLE_FLOWS preprocessing step in roleActions.ts? the layout?) and any required RoleNode type/layout edits. Make it a crisp deliverable naming the concrete site.","[codex] T331 cites 'basis cq.toml.example' but no task creates/commits cq.toml.example. Clarify that cq.toml.example is an EXISTING read-basis already in the repo (not new work) — or, if it does not exist, add the step; do not leave the reference dangling."]
- ledgerRefs: ["goals:G41"]
- sessionLogs: ["docs/logs/20260609-192700-ab459aecc48c00e6d.md","docs/logs/20260609-192700-pi-codex.md","docs/logs/20260609-192700-pi-grok.md","docs/logs/20260609-192700-pi-minimax.md"]

### R400 — go-ahead

- createdAt: 2026-06-09T19:41:12.603Z
- updatedAt: 2026-06-09T19:41:54.634Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "GO-AHEAD (G41 round 2; full panel opus[claude]+codex+grok+minimax[pi], 4/4 usable; opus+grok+minimax go-ahead, codex revise — ADJUDICATED to go-ahead). All 12 R399 criticisms verified resolved by 3/4 reviewers incl. the repo-grounded opus reviewer (advisory-ordering notes; T334 reproduce-first rendering fix + docs/drafts deliverable; in-workspace-validator-else-Ajv+FOD; pinned edit-loci + structural-grep acceptance; 'mixed' dropped; T338 reverted to Q184 literal; dispatched-vs-orchestrator role split + enumerated dispatch sites; terminalStatuses decided; per-role sidecar storage; roleActions.ts derivation site; cq.toml.example clarified). codex raised 3 round-2 points: (#2 cq.toml.example sync + #3 ideas-no-milestone acceptance) were VALID and APPLIED to T331/T335 this round; (#1 milestone dependsOn still serializes the quick wins) is ADJUDICATED NON-BLOCKING — the M139←{M136,M137,M138} / M140←M139 edges correctly ENCODE Q183's explicit 'do the quick wins (1/4/5) first, then 2, then 3' ordering (the implement-flow milestone-readiness gate enforces exactly that order), the descriptions document them as advisory, and opus (reading the live repo+ledger) + grok + minimax all judged C1 resolved; the surviving criticism is a defensible design choice honoring the user's stated sequencing, not a plan defect (citation-validation per the R374 precedent). Plan LOCKED."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G41"]
- sessionLogs: ["docs/logs/20260609-194117-a529026c1e49518de.md","docs/logs/20260609-194117-pi-codex.md","docs/logs/20260609-194117-pi-grok.md","docs/logs/20260609-194117-pi-minimax.md"]

## M141

### R416 — go-ahead

- createdAt: 2026-06-09T22:38:40.832Z
- updatedAt: 2026-06-09T22:38:40.832Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "GO-AHEAD (G42 fix-D47 plan; single opus plan-reviewer — proportionate for a one-task confirmed-root-cause defect fix; pi panel conserved). T346 verified fine-grained/grounded/testable/complete: onSchemaDivergence:'abort' genuinely throws on structural drift (FsLedgerStore.ts:441-445/200), the byte-equality assertion matches regen-bootstrap.ts:32-37 exactly, sample-ledger exclusion is conservative, reproduce-first concrete; no regression on the in-sync fixture. 0 criticisms / 0 questions. Plan LOCKED."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G42","defects:D47"]
- sessionLogs: ["docs/logs/20260609-223826-af9cdea865a37cb53.md"]

## M143

### R418 — revise

- createdAt: 2026-06-10T09:19:33.191Z
- updatedAt: 2026-06-10T09:19:33.191Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "REVISE (G43 round 1; full panel opus[claude]+codex+grok+minimax[pi], 4/4 usable, ALL revise → reconciled revise). Plan is fine-grained/acyclic/grounded/complete across all 8 answers + 6 K66 caveats (opus + minimax both judged the granularity + grounding sound). ~7 actionable planner-fixable criticisms below; the pi 'mega-task' splits are ADJUDICATED non-blocking (opus, the repo-grounded reviewer, judged the 14-task granularity appropriate — each task is one cohesive deliverable; splitting T352/T354/T357 would create artificial sub-tasks). 0 user-only questions (codex's move-ledger native-vs-prompt question is repo-resolvable — native cq-cli subcommand like runInit/runReset — already specified in T354). 0 out-of-scope defects (the pi defects[] are all pre-existing facts — instanceof gating, docs tracked, watcher fs-based, unconditional chore steps — that the plan ALREADY fixes)."
- new_questions: []
- criticism: ["[minimax][codex][grok] MILESTONE DEP ERRORS: (a) M147 (move-ledger) declares depsOn [M145] but its task T354 deps T349 (in M146) → set M147 depsOn [M145, M146]. (b) M149 (tests) declares depsOn [M145, M147] but T356 deps only T352 + T359 deps T356 (the tests don't need the move-ledger CLI) → drop the spurious M147 edge, M149 depsOn [M145].","[codex][grok][minimax] T351's acceptance references 'T346 guard still passes' — T346 is a real committed test (the canonical-ledgers.test.ts ledgers.yaml-vs-canon guard from G42) but the bare out-of-plan task-id reads as a nonexistent reference. FIX: rephrase to 'the committed canonical-ledgers.test.ts committed-vs-canon guard still passes' (name the test, not the foreign task id).","[opus] T353 (ref-sha coherence watcher) hard-codes watching/polling `.git/refs/heads/cq-ledger` (+ packed-refs), which BREAKS whenever the git dir is not a literal `.git/` at the root — a linked worktree (`.git` is a file), a submodule, or a $GIT_DIR override. K66 keeps the linked-worktree approach as the documented FALLBACK, so this path is reachable. FIX: resolve the ref's real location via `git rev-parse --git-path refs/heads/<branch>` (+ `--git-path packed-refs`) rather than assuming `.git/refs/...`; state it in the acceptance.","[opus] T354 (`cq move-ledger --to git`) does `git rm --cached docs/*.md` + gitignore flip but does NOT pin the disposition of the now-UNTRACKED-but-PRESENT working-tree docs/*.md files (Q193's recommendation said 'keep working-tree files until next clean'). FIX: state the working-tree-file disposition (leave-in-place vs delete) and add it to the round-trip acceptance so --to git then --to local is provably lossless INCLUDING on-disk file state.","[opus] Inconsistent command-file scope for investigate/advance.md: T355 hedges ('investigate/advance.md IF it has a ledger-commit tail') while T358 omits it entirely. FIX: resolve whether investigate/advance.md carries a `git add docs/ … chore(ledger)` tail and make T355 (fetch/push) + T358 (conditional commit) cover it consistently (+ gen-agents regen since command files are catalogued).","[codex][grok] FRESH-INIT GITIGNORE GAP: only T354 (migration) handles the docs/*.md gitignore; a FRESH `cq init` with [ledger] backend='git-object' (no prior ledger to migrate) has no task ensuring docs/*.md are gitignored from the start. FIX: have T357's cq-init path (or T349's template) gitignore docs/*.md + docs/ledgers.yaml when backend='git-object' on a fresh init.","[grok] Two precision nits: (a) T353's 'keep the FS file-watcher' reads as conflicting with Q191's 'replace docs/*.md file-watch' — reword to make clear the replacement is PER-BACKEND (the construction site T357 selects file-watch for fs, ref-sha-watch for git-object); (b) T355's runbook acceptance ('runbook exists') is vague — pin a concrete location (a docs/ note) AND document the linked-worktree fallback there (grok+minimax: the fallback currently only appears in T354 help)."]
- ledgerRefs: ["goals:G43"]
- sessionLogs: ["docs/logs/20260610-091837-af979f39285036dfd.md","docs/logs/20260610-091837-pi-codex.md","docs/logs/20260610-091837-pi-grok.md","docs/logs/20260610-091837-pi-minimax.md"]

### R419 — go-ahead

- createdAt: 2026-06-10T09:28:32.731Z
- updatedAt: 2026-06-10T09:28:32.731Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "GO-AHEAD (G43 round 2; opus[claude]+codex+minimax[pi] — 3/4 of the configured panel, grok conserved on this surgical convergence round; ALL 3 go-ahead, unanimous). All 7 R418 criticisms verified RESOLVED against the revised tasks + the actual repo by the repo-grounded opus reviewer: C1 milestone DAG corrected (M147→[M145,M146], M149→[M145]; acyclic); C2 T351 names canonical-ledgers.test.ts (not the foreign T346 id); C3 T353 resolves the ref via git rev-parse --git-path/--verify (no literal .git path) + non-default-git-dir test + per-backend 'INSTEAD' wording; C4 T354 leaves working-tree docs in place + on-disk-bytes+tracked-state round-trip acceptance + native cq-cli subcommand; C5 investigate/advance.md (its standalone-stop chore(ledger) commit confirmed at advance.md:536-547) covered by both T355+T358 (all four command files); C6 T357 fresh-init gitignore; C7 T355 concrete runbook file (rejected-push + shallow-clone + linked-worktree fallback). Construction sites (main.ts createEmbeddedStore/main, cq-cli runInit/runReset, instanceof-FsLedgerStore capability gating) verified grounded. 0 criticisms / 0 questions / 0 out-of-scope defects. Convergent: round1 7 substantive criticisms → fixed; round2 clean. Plan LOCKED."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G43"]
- sessionLogs: ["docs/logs/20260610-092800-a320db9dedf477d3f.md","docs/logs/20260610-092800-pi-codex.md","docs/logs/20260610-092800-pi-minimax.md"]

## M145

### R422 — go-ahead

- createdAt: 2026-06-10T10:14:41.397Z
- updatedAt: 2026-06-10T10:14:41.397Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T348 implement-review — approve. Opus reviewer round 1, 0 criticism / 0 questions / 1 out-of-scope defect (low, D49). Every acceptance clause verified operationally with independent /tmp-repo probes: GIT_INDEX_FILE isolation leaves the real index byte-identical + status clean, commit-tree parent=null is a true orphan, stale expectedOld throws StaleRefError with ref unmoved, catFile/lsTree read with no checkout, readRef null on missing. check green 1496/0; tsc+lint clean; exports additive. Merged as a105cf7."
- ledgerRefs: ["tasks:T348","goals:G43"]

### R423 — go-ahead

- createdAt: 2026-06-10T10:35:38.654Z
- updatedAt: 2026-06-10T10:35:38.654Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T352 implement-review — approve. Opus reviewer round 1, 0 criticism / 0 questions / 0 defects. All acceptance clauses verified with `bun run check` green 1537/0: host checkout HEAD/working-tree/index byte-identical + status clean after create/update/archive; orphan ref +1 per single-write mutation; no .locks in `git ls-tree -r cq-ledger`; cq-ledger-backup-<ts> tag before reinit; writeTree uses isolated scratch GIT_INDEX_FILE (never repo index); CAS expectedOld inside the lock with StaleRefError; full shared abstract suite passes against the git backend (FS-parity). Merged as 3167649."
- ledgerRefs: ["tasks:T352","goals:G43"]

### R424 — revise

- createdAt: 2026-06-10T11:17:15.199Z
- updatedAt: 2026-06-10T11:17:15.199Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T353 implement-review ROUND 1 — disapprove. Opus reviewer: production watcher logic correct (R418 rev-parse indirection, scope, sentinel) but `bun run check` RED — the new refWatcher.test.ts failed 2/4 deterministically under full-suite timing (reproduced 1539/2). Routed back for fix. Round 2 (R425) approves after the orchestrator fixed a deeper baseline race in the watcher itself."
- ledgerRefs: ["tasks:T353","goals:G43"]

### R425 — go-ahead

- createdAt: 2026-06-10T11:17:18.965Z
- updatedAt: 2026-06-10T11:17:18.965Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T353 implement-review ROUND 2 — approve. Opus reviewer: round-1 flake resolved by the orchestrator's round-2 fix (establish baseline sha immediately via poll() at startup instead of at the first tick — a real production defect where a ref advance in the start→first-tick window was silently swallowed). Verified determinism 8/8 isolated + 3/3 full-suite (1541/0); immediate-poll change correct (undefined-sentinel guards spurious fire, single timer schedule, safe close race, test-4 timing preserved); R418 indirection + re-export-only scope intact. Merged as ed1837e."
- ledgerRefs: ["tasks:T353","goals:G43"]

## M146

### R426 — revise

- createdAt: 2026-06-10T12:00:23.316Z
- updatedAt: 2026-06-10T12:00:23.316Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T349 implement-review ROUND 1 — disapprove. Opus reviewer: code correct + check green 1550/0, but the 'CQ_TOML_TEMPLATE inert' acceptance was only tested against a SYNTHETIC TOML copy, not the real exported constant — a regression uncommenting the template's [ledger] block would pass every test. Round 2 (R427) approves after the orchestrator added the assertion against the real CQ_TOML_TEMPLATE + cq.toml.example constants."
- ledgerRefs: ["tasks:T349","goals:G43"]

### R427 — go-ahead

- createdAt: 2026-06-10T12:00:27.152Z
- updatedAt: 2026-06-10T12:00:27.152Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T349 implement-review ROUND 2 — approve. Round-1 acceptance gap closed: orchestrator added `expect(parseConfig(CQ_TOML_TEMPLATE).ledger).toBeNull()` + the cq.toml.example equivalent to the existing T331 describe blocks (the assertions pass, confirming the .ledger-null shape). Test-only delta; full check green 1552/0 in-worktree, 1557/0 combined on main. Merged as 054a64c."
- ledgerRefs: ["tasks:T349","goals:G43"]

## M149

### R428 — revise

- createdAt: 2026-06-10T12:00:29.908Z
- updatedAt: 2026-06-10T12:00:29.908Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T356 implement-review ROUND 1 — disapprove. Opus reviewer: triple-backend coverage REAL + check green 1547/0, but the 'monotonic non-decreasing updatedAt' assertion sorted results ascending THEN asserted cur>=prev — a tautology with no teeth. Round 2 (R429) approves after the orchestrator reworked it to assert in submission order."
- ledgerRefs: ["tasks:T356","goals:G43"]

### R429 — go-ahead

- createdAt: 2026-06-10T12:00:33.191Z
- updatedAt: 2026-06-10T12:00:33.191Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- summary: "T356 implement-review ROUND 2 — approve. Round-1 tautology fixed: orchestrator asserts updatedAt monotonicity over `results` in SUBMISSION order (==lock order), dropping the sort — real teeth against a non-monotonic clock / out-of-order serialisation. Verified concurrency-parity 6 pass (2×3 backends); full check green 1547/0 in-worktree, 1557/0 combined on main. Merged as c369b20."
- ledgerRefs: ["tasks:T356","goals:G43"]
