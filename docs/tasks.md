---
ledger: tasks
counters:
  milestone: 0
  item: 360
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
    title: "Dogfood: implement-flow smoke test"
    status: done
  - id: M2
    path: ./archive/tasks/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M3
    path: ./archive/tasks/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: Build /implement:* command family
    status: done
  - id: M4
    path: ./archive/tasks/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: Plan-flow maintenance and improvements
    status: done
  - id: M6
    path: ./archive/tasks/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
    title: "UI/schema follow-up: archives, milestone grouping, TUI table, reviews summary"
    status: done
  - id: M7
    path: ./archive/tasks/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
    title: investigate:* flow — research-loop-style defect investigation assets
    status: done
  - id: M8
    path: ./archive/tasks/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
    title: defect-awareness in plan:* and implement:* prompts
    status: done
  - id: M9
    path: ./archive/tasks/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
    title: defect/hypothesis relationship views in TUI + web (Full scope, Q28)
    status: done
  - id: M12
    path: ./archive/tasks/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
    title: "G2-W1: Shared status→color foundation (revise bucket + graph colorization)"
    status: done
  - id: M13
    path: ./archive/tasks/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
    title: "G2-W2: Questions UX (field order + suggestions-as-list)"
    status: done
  - id: M16
    path: ./archive/tasks/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
    title: "G3-B: never auto-close goals (prompt edits)"
    status: done
  - id: M17
    path: ./archive/tasks/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
    title: "G3-A: auto-investigate from plan:* (prompt edits + K8 supersession)"
    status: done
  - id: M19
    path: ./archive/tasks/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
    title: "G2 follow-up: per-suggestion pick-as-answer + disable answer-fill when typing (#14-#15)"
    status: done
  - id: M14
    path: ./archive/tasks/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/tasks/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M22
    path: ./archive/tasks/M22.md
    summary: G4-W D2 backup-and-reinit — COMPLETE. T94 backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant, fresh canonical + WARNING); T95 init() !schemasEqual branch → backup-and-reinit by default + onSchemaDivergence:'abort' opt-out; T96 tests (divergence/abort/no-divergence/empty-dir) + abort-suite migration; T97 repo gate. Defect D2 RESOLVED. Reviews R80/R85/R89/R91. Shipped on main; check 661.
    title: "G4-W: D2 backup-and-reinit on ledger schema divergence"
    status: done
  - id: M24
    path: ./archive/tasks/M24.md
    summary: G5 Fix Unit A @cq/ledger packaging — COMPLETE. T98 realigned package.json main+exports → ./dist/src/* (consistent w/ ./columns); T99 browser-safe ./constants subpath export + web tsconfig paths; T100 App.tsx consumes @cq/ledger/constants, deletes MILESTONE_STATUS_SCHEMA dup; T101 package-exports.test.ts (asserts all export targets exist post-build). Defects D3 + D6 RESOLVED. Reviews R81/R86/R87/R88. Shipped on main.
    title: G5 Fix Unit A — @cq/ledger packaging (D3 + D6)
    status: done
  - id: M25
    path: ./archive/tasks/M25.md
    summary: G5 Fix Unit B column eligibility — COMPLETE. T102 added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence) + first columns.test.ts; suggestedModel still eligible. Defect D4 RESOLVED. Review R82. Shipped on main.
    title: G5 Fix Unit B — column eligibility (D4)
    status: done
  - id: M26
    path: ./archive/tasks/M26.md
    summary: "G5 Fix Unit C archived-head status badge — COMPLETE. T104 passes archived pointer status as milestoneStatus to the archived MilestoneSubsection (empty-status guarded) → T80 badge renders for archived heads; happy-dom test. T103 withdrawn (R77: no @cq/shared wire mirror — T91's ArchivePointer.status flows over the wire as-is). Defect D5 RESOLVED. Review R92. Shipped on main; check 661."
    title: G5 Fix Unit C — archived-head status badge (D5)
    status: done
  - id: M21
    path: ./archive/tasks/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
  - id: M30
    path: ./archive/tasks/M30.md
    summary: "G7 fixes COMPLETE — six confirmed dogfood defects fixed + merged. T110 (D16: backfill non-milestones archive-pointer titles from docs/archive/milestones/<id>.md by id; 48f4e93). T111 (D14: spawnWithFreePort retry-on-EADDRINUSE closes the bind-then-close TOCTOU; 6e223bb). T112 (D15: bounded wait-for de-flakes the live-badge test; 40385f6). T113 (D17: removed archived badge from row id cell; 1dec462). T114 (D18: per-suggestion pick buttons in the batch answer modal; ae0e5f8). T115 (D19: batch modal closes on open-set drain; 051fb27). Reviews R105-R110 (all go-ahead). Decision K19. Defects D14-D19 resolved. Final integration check 696 pass / 0 fail. Seeded + driven by the simulated /advance pipeline."
    title: "G7 fixes: confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M28
    path: ./archive/tasks/M28.md
    summary: G6 work milestone M28 — COMPLETE (auto-archived by the milestone-completion rule). Tasks T105 (D9), T106 (D10), T107 (D11), T108+T109 (D12) done; defects D9/D10/D11/D12 + the out-of-scope D14/D15/D16/D17 all resolved (via G7/M30); reviews R98-R102. Decisions K17/K18. Integration green.
    title: "G6 fixes: D9 test flake, D10 store parity, D11 sticky toolbar"
    status: done
  - id: M31
    path: ./archive/tasks/M31.md
    summary: "G6 #2/#4B — COMPLETE. T125 (authored llm/commands/advance.md universal sequencer), T126 (wired into link-prompts.ts + committed .codex/prompts/advance.md symlink), T127 (implement worker cap N=4→8), T128 (factored milestone auto-close+archive sweep predicate in advance.md + implement/advance.md), T129 (one-shot backlog sweep: archived M15/M20/M23/M28; guard-skipped M10/M11/M29/M27/M32/M33). Reviews R119/R122/R123/R124. Integration green."
    title: "G6 #2/#4B — universal /advance command, parallelism bump (N=4→8), milestone auto-close+archive sweep"
    status: done
  - id: M36
    path: ./archive/tasks/M36.md
    summary: "G8 fix — COMPLETE. T130 (bfa70ed): de-flaked the ledger-tui ink-testing-library suite (fixed-tick→poll-until-condition across all flaky sites; navMemo T85 explicit timeout + reduced N; settle-then-assert for negative inert-key tests) → deterministic full-suite `bun run check` (725/0). T131 (8c33435): reset()/backupAndReinit now back up + unlink non-canonical ledger .md files and remove their FTS docs (no orphans/stale index). Reviews R127/R128. Decision K21. Defects D20+D21 resolved; residuals D22 (s-test vacuity, low) + D23 (advance()-helper flake, medium) filed."
    title: "G8 fix: D20 ledger-tui test flakiness + D21 reset non-canonical ledgers"
    status: done
  - id: M38
    path: ./archive/tasks/M38.md
    summary: "G10 work milestone — COMPLETE. T132 (6bd6623): enabled ink incrementalRendering via exported TUI_RENDER_OPTIONS in ledger-tui/src/main.tsx → ~53% per-move stdout-write reduction (D13). T134 (effbd60): advance() test-helper deadline 1500→4000ms + 20_000ms per-test timeout (D23). T133 (bbbfb44): deterministic per-move byte-count regression guard navRenderBytes.test.tsx (negative-control verified). T135: no-op (UX defer not needed). Reviews R132/R133/R134 go-ahead. Defects D13+D23 resolved. bun run check green 728/0."
    title: G10 fix work — D13 TUI nav-perf memo boundaries + D23 multi-step-form test flake (file-disjoint, parallel-safe)
    status: done
  - id: M32
    path: ./archive/tasks/M32.md
    summary: "G6 #3 work milestone — COMPLETE. ledger-mcp --reset (backup-first whole-tree reset) shipped; tasks T123/T131 done; defect D21 (reset ignored non-canonical ledgers) resolved; reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #3 — ledger-mcp --reset command (backup-first whole-tree reset)"
    status: done
  - id: M33
    path: ./archive/tasks/M33.md
    summary: "G6 #4A work milestone — COMPLETE. Formal defect-lifecycle states (open/wip/root-caused/inconclusive/resolved/wontfix) landed in @cq/ledger CANONICAL_LEDGERS + investigate/plan/implement flow prompts; live open-defect migration done; tasks + reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #4A — formal defect-lifecycle states (root-caused/inconclusive) across schema + flow prompts"
    status: done
  - id: M41
    path: ./archive/tasks/M41.md
    summary: "G12 work milestone — COMPLETE. T136 (b8df1c6): made the 's'-key-inert archived-item test regression-sensitive (content-pane '[archived · read-only]' badge-present + content-pane-scoped picker-absence), resolving D24 (ex-D22). Review R141 go-ahead. Integration check green 783/0. G12 goal is `planned` and ready for the user to close."
    title: "G12 fix: regression-sensitive 's'-key-inert archived-item test (D24)"
    status: done
  - id: M42
    path: ./archive/tasks/M42.md
    summary: G11 W1 (@cq/ledger schema + store foundations) — COMPLETE. T137 handoffs CANONICAL_LEDGERS entry (idPrefix HO, all-terminal); T138 sessionLogs:string[] on 6 work-producing schemas; T139/T140 fts (status:open OR status:wip) adjudicated GREEN (usage artifact, docs-only); T141 reopenItem + group-keyed unarchiveItem (both stores); T142 projectCompact + paginate (strips grounding/recommendation/suggestions); T143 cross-ledger snapshot(). Reviews R142-R147 go-ahead. Shipped on main.
    title: G11 W1 — @cq/ledger schema + store foundations
    status: done
  - id: M43
    path: ./archive/tasks/M43.md
    summary: G11 W2 (@cq/ledger-mcp tool surface) — COMPLETE. T144 fetch_ledger compact/offset/limit params (fixes 51.8KB/142.7KB overflow); T145 snapshot tool; T146 reopen_item + unarchive_item; T147 read_log (bounded, root-confined); T148 tool-count reconciliation (14→18 across all refs); T149 query-language doc clarifications. Reviews R148-R153 go-ahead. Out-of-scope defects D25/D26 filed here, both later resolved (G13). Shipped on main.
    title: G11 W2 — @cq/ledger-mcp tool surface
    status: done
  - id: M44
    path: ./archive/tasks/M44.md
    summary: G11 W3 (@cq/ledger-web HoldButton + sessionLogs viewer) — COMPLETE. T150 reusable HoldButton (HOLD_MS=1000, pointer+keyboard hold-to-confirm, progress bar, injectable HoldClock); T151 all 10 state-mutating web buttons hold-gated; T152 sessionLogs rendered as clickable links → popup via read_log MCP tool. Reviews R154/R157/R160 go-ahead (T151 r0 missed the 2 quick-transition buttons, fixed r1). Recovered a partial-cherry-pick of T151 during merge-back. Shipped on main.
    title: G11 W3 — @cq/ledger-web HoldButton + sessionLogs viewer
    status: done
  - id: M45
    path: ./archive/tasks/M45.md
    summary: G11 W4 (flow-prompt wiring) — COMPLETE. T153 advance.md §Provenance permits the single run-level handoffs write; T154 per-flow handoff writes with contextual /advance suppression; T155 sessionLogs population in each outcome write; T156 snapshot-first /advance bootstrap recipe. Reviews R155/R156/R158/R159 go-ahead (T154 r0 used an env var, fixed r1 → contextual). Out-of-scope defect D27 filed here, later resolved (G13). Docs/prompt-only. Shipped on main.
    title: G11 W4 — flow-prompt wiring (handoff writes + bootstrap recipe + docs)
    status: done
  - id: M46
    path: ./archive/tasks/M46.md
    summary: "G11 W5 (integration verification) — COMPLETE. T157 verification-only gate: bun run check green 847/0 on main (697aec8); bun.lock unchanged → no flake FOD refresh; all 5 ergonomics wins demonstrated via passing tests (snapshot one-call, fetch_ledger compact no-overflow, reopen/unarchive recovery, handoffs bootstrap, web hold-gate+sessionLogs popup). Review R161 go-ahead. G11 fully built (21 tasks); goal planned, ready for the user to close."
    title: G11 W5 — integration verification (bun run check)
    status: done
  - id: M48
    path: ./archive/tasks/M48.md
    summary: "G13 fix work (D25/D26/D27 G11 follow-up cleanup) — COMPLETE. T158 (D26): readLog symlink-escape hardening (realpath both target+root); T159 (D25): removed stale eslint-disable; T160 (D27): reworded CHAINED handoff trigger + made start/follow-up wrappers the single handoff writer (7 files). Reviews R163/R164/R165 go-ahead (T158/T160 each r0 disapprove→r1 approve). H15/H16/H18 confirmed. Defects D25/D26 resolved (also D28 filed here from T158 review, resolved via G14). Merged 311b8a1."
    title: "G13 fix tasks: D25/D26/D27 code-quality cleanup"
    status: done
  - id: M50
    path: ./archive/tasks/M50.md
    summary: "G14 fix work (D28 readLog TOCTOU) — COMPLETE. T161: readLog now reads the validated canonical path (fs.readFile(real ?? resolved)) instead of the symlink-bearing resolved, closing the check-then-read TOCTOU; ENOENT unmasked. Deterministic TOCTOU regression test (spies fs.realpath to swap the target at the check→use boundary; verified to fail against the pre-fix read). Review R167 go-ahead (r0 disapprove: non-discriminating test → r1 made it fail against pre-fix code). Defect D28 resolved. Merged 537017f."
    title: Close D28 readLog check-then-read TOCTOU (read validated canonical path)
    status: done
  - id: M54
    path: ./archive/tasks/M54.md
    summary: "G16/D29 fix built+merged: backend questions-answer StatusChangePrecondition (dual-store) + web/TUI empty-answer UX guards. Tasks T162/T163/T164 done, reviews R172/R174/R175 go-ahead. Integrated bun run check green 908/0. D29 resolved."
    title: D29 fix — reject empty/whitespace answer on a question's `answered` transition
    status: done
  - id: M58
    path: ./archive/tasks/M58.md
    summary: "G17/D30 fix built+merged: link-prompts.ts made import-safe + repointed 14 LINKS off the vanished llm/ root onto ../cq-assets/, hardened to throw on missing targets; cq-assets README de-staled. Tasks T179/T180/T181 done, reviews R173/R176/R177 go-ahead. D30 resolved; bun run link-prompts now produces non-dangling symlinks."
    title: "G17 fix: repoint link-prompts.ts + cq-assets README off vanished `llm/` root (D30)"
    status: done
  - id: M55
    path: ./archive/tasks/M55.md
    summary: "G15 Feature 1 (explorer two-tier RW) built+merged: investigate-explorer JSON contract extended with optional probeRequest (T165); new execution-capable investigate-prober.md agent (Bash + throwaway worktree, read+execute, local-only/no-network) (T166); prober dispatch wired into investigate/advance.md gated on probeRequest with harvest-then-discard (T167); prober registered in link-prompts.ts + README (T168). Tasks T165-T168 done, reviews go-ahead. Integrated bun run check green."
    title: G15 W1 — Explorer two-tier RW (investigate-prober)
    status: done
  - id: M56
    path: ./archive/tasks/M56.md
    summary: "G15 Feature 2 (pluggable parallel reviewers) built+merged: pi non-interactive spike confirmed (K30 invocation contract) (T169); @cq/config cq.toml parser package (T170) + cq-config MCP server exposing get_reviewers + Nix package (T171); registered in dev-llm.nix + .mcp.json (T172); shared /cq:plan-review (T173) + /cq:implement-review (T174) rubrics; reconciliation (strictest-wins+union-with-source-tags, get_reviewers MCP tool, pi shellout) wired into plan/advance.md (T175) + implement/advance.md (T176); /cq:reviewers session-only override (T177); cq.toml.example + cq/* link entries + README (T178). Tasks T169-T178 done, reviews go-ahead, K30 locked. Integrated bun run check green 930/0; all new asset symlinks resolve."
    title: G15 W2 — Pluggable parallel reviewers (cq.toml + cq-config MCP + pi shellout)
    status: done
  - id: M62
    path: ./archive/tasks/M62.md
    summary: "G18 PART 2 — pluggable parallel planners — COMPLETE. All 6 tasks done + merged to main (T12 84f1bfe @cq/config planners=[] parser/resolvePlanners; T13 7a3806d get_planners + get_config.planners on BOTH ledger-MCP surfaces, count 20→21 + drift-guard + e2e stdio; T14 6f2397e plan-advance CANDIDATE mode emitting task-DAG JSON; T15 d949db6 multi-planner generate-N-then-JUDGE+SYNTHESIS step in plan/advance.md; T16 b3278b3 commands/cq/planners.md session-only override; T17 7e403fe convergence gate — assets glob picks up planners.md, cq.toml.example planners= example, mcp__cq-config__ grep clean). Reviews R206-R211 all go-ahead (T12 + T13 each after 1 criticism round: T12 empty-test→real reproduction, T13 5 stale '20-tool' strings→21). bun run check green 931/0. Tip 7e403fe."
    title: G18 PART 2 — Pluggable parallel planners (generate-N-then-judge w/ synthesis)
    status: done
  - id: M64
    path: ./archive/tasks/M64.md
    summary: D32 fix COMPLETE. Single doc-only task T182 (commit 418b641, merged to main) repointed nix/pkg/cq-assets/README.md 'Configuration' section off the removed standalone cq-config MCP server to the ledger MCP (heading 'cq.toml and the ledger MCP'; prose attributes parsing to the @cq/config parser package + surfacing to the ledger MCP exposing get_reviewers/get_config/get_planners as mcp__ledger__*). Review R213 go-ahead. D32 resolved (orchestrator-owned closure). bun run check 931/0.
    title: Repoint cq-assets/README.md Configuration section off cq-config MCP server (D32 fix)
    status: done
  - id: M61
    path: ./archive/tasks/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M67
    path: ./archive/tasks/M67.md
    summary: G21/D31 fix — COMPLETE. T183 (reproduce-first RED happy-dom test for the press-started-inside backdrop dismiss, d073a27) + T184 (shared useBackdropDismiss hook — closes only when target===currentTarget on BOTH pointerdown/mousedown and click — wired into all three overlays batch/help/log, 99576bc). Reviews R219/R220 go-ahead. D31 RESOLVED; bun run check green 977/0 at merge. main bdd2720.
    title: G21/D31 fix — safe modal backdrop (press must start on backdrop to dismiss)
    status: done
  - id: M68
    path: ./archive/tasks/M68.md
    summary: G20 FEATURE 1 (cq.toml [webui] + ledger-web port auto-increment) — COMPLETE. T185 (swap @cq/config parser to smol-toml 1.6.1 + typed [webui] host/integer-port, whitelist preserved, G18 planners intact — 96b7031) + T186 (resolveWebOpts per-field CLI>cq.toml>default + bounded scanForPort MAX=64 EADDRINUSE-only host-immutable — f71f9b9) + T187 (main() wires loadConfig+resolveWebOpts+scanForPort, reports actual bound URL to STDOUT keeping the stderr line, + ledgerWeb @cq/config flake symlink — 0c21f43). Reviews R217/R221/R223 go-ahead (one plan revise round R215→R216). bun run check green; nix build .#ledger-web verified in T192.
    title: G20 FEATURE 1 — cq.toml [webui] + ledger-web port auto-increment (depends on G18 landing)
    status: done
  - id: M69
    path: ./archive/tasks/M69.md
    summary: "G20 FEATURE 2 (new `cq` CLI init/reset/erase) — COMPLETE. T188 (scaffold @cq/cli package + dispatcher + injectable ConfirmIo — 8f60e59) + T189 (cq init: idempotent FsLedgerStore.init-if-none, no cq.toml — da1aa82) + T190 (cq reset: relocate the wrapper off ledger-mcp via FsLedgerStore.reset+ConfirmIo, REMOVE --reset from ledger-mcp — 3d96f3c) + T191 (cq erase: bounded irreversible delete of <root>/docs + cq.toml, no path-escape, confirm-gated — e597b68) + T192 (closing gate: cqCli flake.nix derivation + apps.cq + node-modules FOD entry + consolidated hash refresh; nix build .#cq/.#node-modules/.#ledger-mcp/.#ledger-tui/.#ledger-web all green + cq bin init/reset/erase e2e — bdd2720). Reviews R218/R222/R224/R225/R226 go-ahead. bun run check green 986/0. main bdd2720."
    title: G20 FEATURE 2 — new `cq` CLI (init / reset / erase)
    status: done
  - id: M71
    path: ./archive/tasks/M71.md
    summary: "G22 parts 1-3 (web UI): T193 sidebar group-ordered nav with splitters, T194 help dialog fixed large size with internal scroll, T195 state-machine SVGs uniformly left-aligned (xMinYMid meet + width:100%). All 3 tasks done, all reviews go-ahead, bun run check green (985/0)."
    title: "G22 web UI: sidebar reorder + help fixed-size + SVG left-align (parts 1-3)"
    status: done
  - id: M72
    path: ./archive/tasks/M72.md
    summary: "G22 part 4 (cq: command renames): T196 git-mv'd advance/plan:start/investigate:start command files into commands/cq/{advance,plan,investigate}.md + rewrote in-file refs, T197 updated link-prompts.ts LINKS to cq/ paths, T198 swept all remaining cross-refs across nix/pkg (7 markdown files + 2 MCP tool-description strings) to cq:* names. All 3 tasks done, all reviews go-ahead, bun run check green (985/0)."
    title: "G22 cq: command renames (part 4) — advance/plan:start/investigate:start → cq:*"
    status: done
  - id: M76
    path: ./archive/tasks/M76.md
    summary: "G24 fix landed: computeDagLayout re-based to min-layer 0 (T199, commit e9bf762), reviewed (R239 go-ahead), bun run check green. Resolves D33's left-gap on cyclic state-machine diagrams."
    title: Fix D33 — re-base DAG layer numbering so cyclic state-machine diagrams left-align
    status: done
  - id: M78
    path: ./archive/tasks/M78.md
    summary: "G23 phase 2 complete: adopted elkjs, built the diagramLayout adapter + DiagramSvg renderer (T202), migrated the State-machines help tab off computeDagLayout onto elk (T203), authored the flow render-data module (T204), added the third Flows help tab (T205), and passed the end-to-end verification gate (T206: bun run check 1014/0, nix build .#node-modules + .#ledger-web both green, D33 left-alignment confirmed resolved, DagView unchanged). All 6 tasks merged, all reviews go-ahead."
    title: G23 phase 2 — adopt diagram library, migrate State-machines tab, add Flows tab
    status: done
  - id: M77
    path: ./archive/tasks/M77.md
    summary: "G23 phase 1 complete: authored nix/pkg/cq-assets/docs/flow-state-machines.md (T200) documenting the plan/investigate/implement/advance state machines + cross-flow handoff topology; reviewed go-ahead (R240). Task done, milestone fully terminal."
    title: G23 phase 1 — flow state-machine doc
    status: done
  - id: M83
    path: ./archive/tasks/M83.md
    summary: "G27/D34 fix landed: server-computed progressTotal on LedgerSummary (questions = open+answered, excludes withdrawn) in both MCP transports (T207), LedgerProgressBar uses it as denominator (T208), regression pinned (T209). All reviewed go-ahead; D34 resolved. Top-bar questions bar now reads 38/38 = 100%."
    title: D34 fix — questions progress denominator excludes withdrawn (G27)
    status: done
  - id: M84
    path: ./archive/tasks/M84.md
    summary: "G25 skill-retirement landed: five skills (research-loop, vsm-loop, vsm-node, question-batch, review-loop) archived to docs/legacy-skills/ (T211), source dirs removed/de-registered (T212), references repointed to cq successors (T213), surviving skills verified clean (T214), and the final gate passed — nix build .#llm-skills green with 7 survivors, zero dangling refs in nix/ (T215). All reviewed go-ahead."
    title: "G25: Retire legacy skill family (research-loop, vsm-loop, vsm-node, question-batch, review-loop) + scrub cq references"
    status: done
  - id: M85
    path: ./archive/tasks/M85.md
    summary: "G26 session-log popup landed: added .lw-modal-backdrop/.lw-modal overlay CSS so LogModal is a fixed popup (T216), LogModal renders content via the sanitized Markdown component instead of <pre> (T217), read_log cap relaxed to 4 MiB per K42 (T218), happy-dom regression test for overlay+markdown (T219), and bun run check green gate (T220). All reviewed go-ahead."
    title: "W: session-log markdown popup (ledger-web, G26)"
    status: done
  - id: M87
    path: ./archive/tasks/M87.md
    summary: "G28 W1 spike+de-risk — COMPLETE. T221 read-only go/no-go on Pi 0.78.0 ExtensionAPI child-session primitive: verdict GO — all 5 primitives (registerTool types.d.ts:816; child-session spawn via subprocess Route A `pi -p --mode json` + in-process Route B createAgentSession; tool-filtering --tools/excludeTools; model pin --model; output capture message_end/getFinalOutput) confirmed at exact file:line. Review R270 go-ahead (opus verified citations; 2 minor citation fixes applied at merge). Merged bd6aa87. M88–M91 unblocked."
    title: Pi subagent dispatch — spike + de-risk
    status: done
  - id: M89
    path: ./archive/tasks/M89.md
    summary: "G28 W3 tier→model routing + runtime config-access — COMPLETE. T223: additive cq.toml [tiers] (fast/standard/frontier→harness:model) + [agent_tiers] (agent→tier) parsed in @cq/config with resolveAgentTier/resolveTierToken/resolveAgentModel + 17 tests, bun run check green 1038/0, merged 92aae54 (review R269 unanimous go-ahead). T228: locked decision K46 + backing note — standalone store-path extension reads cq.toml at runtime via $CQ_CONFIG (default $CQ_PROJECT_ROOT/cq.toml) with an INLINED flat-table TOML reader + INLINED resolver (Route A; rejected cross-workspace-import B / build-time-inline C). T224/T225 implement against K46."
    title: Pi subagent dispatch — tier→model routing
    status: done
  - id: M88
    path: ./archive/tasks/M88.md
    summary: "G28 W2 agents-projection + extension — COMPLETE. T222: home.file projects the 7 cq agent markdowns to ~/.pi/agent/cq-agents/<name>.md (byte-identical to mergedAgents) + CQ_AGENTS_DIR pinned on piWrapped (7611867, R271 unanimous). T224: bespoke nix/pkg/pi-extensions/cq-subagent-dispatch.ts registering dispatch_agent {agent,task,isolation?} (K44) — reads $CQ_AGENTS_DIR agent md, spawns a Route-A filtered child `pi -p --mode json` (re-dispatch blocked via --exclude-tools + not loading the extension in the child; injection-safe shell:false argv; agent body via temp file), returns child output; registered in dev-llm.nix; LIVE dispatch probe returned non-empty + child lacked the dispatch tool. 1 criticism round fixed a path-traversal + 4 robustness items (235f854, R272 unanimous round-2). tsc --strict clean."
    title: Pi subagent dispatch — agents projection + extension
    status: done
  - id: M96
    path: ./archive/tasks/M96.md
    summary: "G31 D38-verdict-enum fix COMPLETE: T240-T244 all merged (c24b02d/a74d9eb/3ee5bf1/567c415), D38 resolved. Two-layer fix (pi-context.md enum reinforcement + plan/implement advance.md fail-loud off-enum→abstention) + verify (bun run check 1037/0 + nix builds) + documented argument. All implement reviews go-ahead (R285-R289)."
    title: "G31 W: D38 verdict-enum fix (reinforce + fail-loud validate)"
    status: done
  - id: M94
    path: ./archive/tasks/M94.md
    summary: "G29 provider-qualified pi token grammar COMPLETE: T231-T239 all merged + reviewed; D36 RESOLVED. pi:<provider>/<model> slash grammar (bare rejected) threaded through @cq/config (parseReviewerToken + resolvers), the @cq/ledger(-mcp) config-capability surface, and the cq-subagent-dispatch extension mirror (K50 cross-layer guard); cq.toml.example migrated + documented; fixtures adapted; final gate green (bun run check 1089/0 + nix builds + bare-pi audit clean). ACTIVATION TAIL: live cq.toml migration + get_config spot-check deferred to the rebuilt-MCP restart."
    title: "G29 W: provider-qualified pi token grammar"
    status: done
  - id: M103
    path: ./archive/tasks/M103.md
    summary: "G32 W1 COMPLETE: write-time handoff invariant enforcement. assertHandoffInvariants pure helper (core.ts) wired into applyCreateItem+applyUpdateItem (both adapters); mixed/answers-required⇒non-empty blockingQuestions, user-action-required⇒non-empty handoffReasons, else SchemaValidationError. Dual-adapter tests reproduce HO26 as an asserted throw. K52 deferred the stretch hardenings. T257-T260 done, R314-R317 go-ahead."
    title: "G32 W1: write-time handoff invariant enforcement (@cq/ledger, load-bearing)"
    status: done
  - id: M104
    path: ./archive/tasks/M104.md
    summary: "G32 W2 COMPLETE: advance.md §Stop-condition turn-vs-run clause (marker 'NOT a run-stop') — turn/context exhaustion is NOT a run-stop, needs no handoff, the ledger is the resume point. T261 done, R318 go-ahead."
    title: "G32 W2: advance.md turn-vs-run stop clause"
    status: done
  - id: M105
    path: ./archive/tasks/M105.md
    summary: "G32 W3 COMPLETE: euphemism blocklist + self-check + enforced-invariant prose threaded across all 4 *:advance prompts (advance.md via T262; the 3 per-flow via T263). T262/T263 done, R319/R320 go-ahead."
    title: "G32 W3: euphemism blocklist + self-check across the four *:advance prompts"
    status: done
  - id: M106
    path: ./archive/tasks/M106.md
    summary: "G32 W4 COMPLETE: 8-cell grep-invariant (4 prompts × 2 markers) + final verify (bun run check 1135/0 + nix build .#ledger-mcp); D39 reproduction closed. T264/T265 done, R321/R322 go-ahead."
    title: "G32 W4: verify + grep-invariant"
    status: done
  - id: M90
    path: ./archive/tasks/M90.md
    summary: "G28 work (integration + tier wiring) COMPLETE: T225 (tier resolution wired) + T229 (Pi dispatch-trigger) done + reviewed; D36 (provider-ambiguous token, filed here) RESOLVED via G29. All items terminal."
    title: Pi subagent dispatch — integration + tier wiring
    status: done
  - id: M97
    path: ./archive/tasks/M97.md
    summary: "G30 W1 COMPLETE: T245 added user-action-required to HANDOFFS_SCHEMA (now live post-redeploy). R290 go-ahead."
    title: "G30 W1: schema — add user-action-required to HANDOFFS_SCHEMA"
    status: done
  - id: M99
    path: ./archive/tasks/M99.md
    summary: "G30 W3 COMPLETE: T248/T249 WARNING-bucket render (both status.ts) + T250 render tests. All reviews go-ahead."
    title: "G30 W3: rendering — warning bucket (TUI + web)"
    status: done
  - id: M100
    path: ./archive/tasks/M100.md
    summary: "G30 W4 COMPLETE: user-action-required threaded through all 4 *:advance prompt tables (T251-T254). All reviews go-ahead."
    title: "G30 W4: prompt threading (advance.md + 3 per-flow tables)"
    status: done
  - id: M101
    path: ./archive/tasks/M101.md
    summary: "G30 W5 COMPLETE: schema unit + four-table grep tests (T255) + verify (T256, bun run check + scoped nix build). All reviews go-ahead."
    title: "G30 W5: verify — schema/grep tests + bun run check + scoped nix build"
    status: done
  - id: M98
    path: ./archive/tasks/M98.md
    summary: "G30 W2 live-ledger migration complete: T246 (operational in-place migration of the gitignored docs/ledgers.yaml handoffs schema — user-action-required added to statusValues/terminalStatuses/transitions; verified no backup-reinit, HO records intact) + T247 (committed CI records-survive regression test) both done; R299 go-ahead. Closes the last open G30 work item."
    title: "G30 W2: in-place live-ledger migration (Q141)"
    status: done
  - id: M111
    path: ./archive/tasks/M111.md
    summary: "G34 W3 complete: Agents-tab build-time catalogue codegen + new web Agents tab. T275 (AgentRole model + parseAgentMarkdown + formatExposedTools), T281 (## Catalogue blocks in all 19 role assets), T276 (gen-agents codegen → committed agentsCatalogue.gen.ts, 19 roles), T277 (freshness/drift test), T278 (Agents tab in HelpOverlay — privilege badge + exposed tools + folded prompt), T279 (happy-dom tests) all done; reviews R333-R338 go-ahead. bun run check green; nix build .#ledger-web green."
    title: "G34-W3: Agents tab — build-time catalogue codegen from cq-assets + new web Agents tab"
    status: done
  - id: M112
    path: ./archive/tasks/M112.md
    summary: "G34 W4 complete: integration verification (T280). gen-agents no-drift + bun run check green (1218/1skip/0) + nix build .#ledger-web/.#ledger-mcp/.#ledger-tui all green. Final cross-product gate for the G34 plan passed."
    title: "G34-W4: integration verification — full check + nix build across touched products + codegen drift gate"
    status: done
  - id: M114
    path: ./archive/tasks/M114.md
    summary: "G35 W1 complete (fixes D42): T282 added a class-agnostic duplicate-token guard to parseTiers (throws CqConfigError naming both conflicting [tiers] keys before entries.push) + tests; reworked the pre-existing contradictory VALID_TOML_WITH_TIERS fixture. R340 go-ahead. D42 resolved. bun run check green 1224/0."
    title: "G35-W1: fail-loud dup-token [tiers] classification in parseTiers + tests"
    status: done
  - id: M110
    path: ./archive/tasks/M110.md
    summary: "G34 W2 complete: cq-config [tiers] inverted to (harness+provider+model)->class classifier. T268 (TiersConfig type → entries classifier), T270 (parseTiers token-keyed), T271 (classifyToken/selectTokensForTier; resolveTierToken removed; resolveAgentModel re-pointed), T272 (consumer audit — no external consumers), T273 (classifier test suite), T274 (cq.toml.example + docs + example-load test) all done; reviews R327-R332 go-ahead. Defect D42 (filed during T271, dup-token fail-loud) resolved by T282/G35. nix build .#ledger-mcp green."
    title: "G34-W2: cq-config — invert [tiers] to (harness+provider+model)→class classifier"
    status: done
  - id: M116
    path: ./archive/tasks/M116.md
    summary: G34 ff#2 W1 — get_agent_models server capability. T283 (AgentModelsResult 4-state wire shape on ConfigCapability), T285 (computeAgentModels over the shared 19-role AGENT_ROLE_TIERS roster, deriveModelMappings parity), T287 (get_agent_models MCP tool, stdio+HTTP) all done + reviewed (R345/R347/R349 go-ahead). Merged to main.
    title: "G34-ff2 W1: get_agent_models server capability (live model overlay)"
    status: done
  - id: M117
    path: ./archive/tasks/M117.md
    summary: G36 W1 — @cq/config effort core. T284 (per-harness PI_EFFORTS/CLAUDE_EFFORTS + isEffort + optional ReviewerToken.effort), T286 (parseReviewerToken last-colon effort split, reserved ':' both halves, fail-fast), T288 (formatReviewerToken round-trip), T290 (effort in reviewerTokensEqual identity) all done + reviewed (R346/R348/R352/R354 go-ahead). Merged to main.
    title: "G36 W1: effort grammar — @cq/config core (parse/format/identity/enums)"
    status: done
  - id: M118
    path: ./archive/tasks/M118.md
    summary: G34 ff#2 W2 — ledger-web client + live overlay. T289 (getAgentModels on LedgerClient/McpLedgerClient, catch-any-error), T291 (FakeClient 4-state + throw modes), T293 (mount fetch + overlay state + AgentModelCell), T295 (resolved token chips), T297 (Q159 agentsTab overlay tests) all done + reviewed (R351/R353/R356/R359/R360 go-ahead). Merged to main.
    title: "G34-ff2 W2: ledger-web LedgerClient + live overlay render"
    status: done
  - id: M119
    path: ./archive/tasks/M119.md
    summary: G36 W2 — effort wire-through + pi-extension. T292 (optional effort on get_planners/get_reviewers/get_config wire shapes), T294 (inlined cq-subagent-dispatch resolver mirror; pi effort via --model …:<effort> shorthand, claude inert) all done + reviewed (R355 + R354/T292 go-ahead). Merged to main.
    title: "G36 W2: effort wire-through — MCP capability + cq-subagent-dispatch"
    status: done
  - id: M120
    path: ./archive/tasks/M120.md
    summary: "G34 ff#2 W3 — drop build-time model fields + verify. T299 (removed model/modelMappings from AgentRole + gen-agents + App.tsx static rows; overlay AgentModelCell is sole model display; freshness test narrowed), T300 (final verify: bun run check 1290/0 + nix build .#ledger-mcp/.#ledger-web exit 0) done + reviewed (R361/R362 go-ahead). Agents tab shows ONLY live-configured models."
    title: "G34-ff2 W3: narrow build-time catalogue to static fallback + verify"
    status: done
  - id: M121
    path: ./archive/tasks/M121.md
    summary: "G36 W3 — docs + verify. T296 (cq.toml.example + token-format docs for the :<effort> suffix; reserved ':' both halves, per-harness enums, pi --model shorthand), T298 (G36 verify: bun run check 1286/0 + nix build .#ledger-mcp exit 0) done + reviewed (R357/R358 go-ahead). Merged to main."
    title: "G36 W3: docs, cq.toml.example, full check + nix build"
    status: done
  - id: M123
    path: ./archive/tasks/M123.md
    summary: "G37 W1 (D43 part-a) COMPLETE: T301 added the worktree-confinement hard Boundary to implement-worker.md — a GENERAL prohibition on any git op switching/mutating/writing-refs of a tree other than the worker's own (checkout/reset --hard/cherry-pick + git -C/--git-dir as non-exhaustive exemplars), sanctioned reset --hard <base> only within own worktree, status=fail escalation on a stale base. Merged 5d0f12a; reviewed R365 go-ahead. Marker 'MUST NOT run git against the main checkout'."
    title: "D43 W1: implement-worker worktree-confinement Boundary"
    status: done
  - id: M124
    path: ./archive/tasks/M124.md
    summary: "G37 W2 (D43 part-b, commit discipline) COMPLETE: T302 after-planning-lock always-fire checkpoint in plan/advance.md (147d589, R366); T303 §7.5 after-every-task-merge-back always-fire checkpoint + three-checkpoint distinction in implement/advance.md (1252c98, R367); T304 advance.md acknowledges the chained per-merge commit as always-fire (2acd3f7, all go-ahead). Existing after-archive + at-stop commits intact."
    title: "D43 W2: durable-ledger-commit checkpoints (after planning-lock + every merge-back)"
    status: done
  - id: M125
    path: ./archive/tasks/M125.md
    summary: "G37 W3 (D43 part-3 repro/guard + verify) COMPLETE: T305 documented reflog repro (25e2fe6, R368); T306 4-cell file-scoped grep-invariant guard in canonical-ledgers.test.ts (169b032, R369, teeth-verified); T307 final verify PASS (R370: bun run check 1293/0 incl. the grep-invariant + nix build .#llm-skills exit 0). D43 RESOLVED. Live-activation via home-manager switch is a user follow-up."
    title: "D43 W3: documented repro + grep-invariant guard + verify"
    status: done
  - id: M91
    path: ./archive/tasks/M91.md
    summary: G28 W5 (pi subagent dispatch acceptance demo) COMPLETE — all tasks terminal. Archived in the post-G37 cleanup sweep.
    title: Pi subagent dispatch — acceptance demo
    status: done
  - id: M109
    path: ./archive/tasks/M109.md
    summary: G34 W1 (Item-States rename) COMPLETE — all tasks terminal. Archived in the post-G37 cleanup sweep.
    title: "G34-W1: ledger-web help popup — rename State Machines → Item States (label + ids/testids/CSS)"
    status: done
  - id: M129
    path: ./archive/tasks/M129.md
    summary: G38 item 2 (flows-tab per-role action diagrams, web-only) COMPLETE. T315 (roleActions.ts ROLE_FLOWS catalogue) + T316 (render Flows tab from ROLE_FLOWS via existing DiagramSvg, replacing flowData state diagrams; + latent DiagramSvg multigraph React-key fix). Reviews R377/R381 go-ahead. Merged ba7b026 + c875921. bun run check green.
    title: G38 item 2 — flows-tab per-role action diagrams (ledger-web, web-only)
    status: done
  - id: M130
    path: ./archive/tasks/M130.md
    summary: G38 item 3 (TUI focus-respecting paging/jump keybindings, defect-aware) COMPLETE. T318 (LIST-focus PgUp/PgDn page cursor by listInnerH + Home/End jump rows; no-Enter detail-scroll removed; module-scope matchHomeEnd helper) + T319 (CONTENT-focus Home/End reusing matchHomeEnd). Defect D44 RESOLVED. T320 abandoned (tests folded into T318/T319). Reviews R378/R382 go-ahead. Merged 46a0f95 + 0992cd3. bun run check green.
    title: G38 item 3 — TUI focus-respecting paging/jump keybindings (defect-aware)
    status: done
  - id: M127
    path: ./archive/tasks/M127.md
    summary: "G38 item 1a (implement-worker worktree auto-cleanup, prompt-only) COMPLETE. T308 (advance.md §7.3 explicit per-merge teardown), T309 (advance.md §1 start-of-pass orphan/locked sweep gated to terminal-task worktrees), T310 (implement-worker.md worktree-lifetime note), T311 (canonical-ledgers.test.ts grep-invariant cells over sources + gen.ts). T322 abandoned (freshness-guard discovery: each catalogued-asset edit regens gen.ts, so the last 1a edit produces the final cumulative gen.ts — a separate regen is a no-op; T311's gen.ts assertions are the committed guard). Markers G38-1a-post-done-cleanup/start-sweep/worker-ephemeral all present in sources + agentsCatalogue.gen.ts. Reviews R375/R379/R383/R384 go-ahead. Merged 4eca303/c6c723e/b61ae54/5dbae6b. bun run check green."
    title: G38 item 1a — implement-worker worktree auto-cleanup (prompt-only)
    status: done
  - id: M131
    path: ./archive/tasks/M131.md
    summary: "G38 cross-cutting verification COMPLETE. T321 final-verify PASS (orchestrator-run, R385 go-ahead): bun run check 1332/0; grep-invariant markers G38-1a-post-done-cleanup/start-sweep (advance.md) + worker-ephemeral (implement-worker.md) each =1; §5 'worktree INTACT' intact; nix build .#ledger-mcp/.#ledger-tui/.#ledger-web all exit 0. All G38 items 1a/1b/2/3 landed + verified."
    title: G38 — cross-cutting verification (full check + grep-invariant audit + nix builds)
    status: done
  - id: M133
    path: ./archive/tasks/M133.md
    summary: "D45 fix COMPLETE. T323 (cacheMirror.mirrorMutation now mirrors layout.registryPath on op==='create'||'archive' — before the archive-only early return; 'update' excluded; archive-dir enumeration unchanged; docstring updated; reproduce-first createLedger mirror test: ENOENT before, byte-equal after). Reviewed go-ahead R388. Merged 367654c. D45 RESOLVED. bun run check green 1333/0."
    title: Fix D45 — mirror docs/ledgers.yaml on the 'create' op in cacheMirror
    status: done
  - id: M128
    path: ./archive/tasks/M128.md
    summary: G38 item 1b (ledger ~/.cache mirror backup + restore CLI) COMPLETE. T312 (@cq/ledger onMutation-driven ~/.cache mirror + shared exported cacheMirrorDir + fsAtomic extraction; fire-and-forget drained by dispose()) + T313 (ledger-mcp `restore --from-cache [--cwd]` positional subcommand reusing cacheMirrorDir + atomic copy-back; main.ts header updated; nix build .#ledger-mcp green). Out-of-scope defect D45 (filed by T312 review) RESOLVED via G39/T323 (registry-on-create mirror). Reviews R376/R380 go-ahead. Merged b681160/e9ad2df. bun run check green.
    title: G38 item 1b — ledger ~/.cache mirror backup + restore CLI
    status: done
  - id: M134
    path: ./archive/tasks/M134.md
    summary: "G38 follow-up #1 (ledger-web help-popup UX + deepened Flows tab) COMPLETE. 6 tasks: T324 FU-2 (.lw-help hard 90vw×90vh + pinned head), T325 FU-1 (AgentModelCell stale-server message), T326 FU-4 renderer+data foundation (agentId on DiagramNode/RoleNode + exported RoleKind/ROLE_KIND_FILL/fillForRoleKind + clickable/keyboard DiagramSvg nodes; renderer fill unchanged per Q181), T327 FU-4a/c/d catalogue (agentId map ∈ AGENT_ROLES + all formalized ops as edges/worktree-main-ledger infra nodes grounded in cq-assets prompts + roleKind fills), T328 FU-3 (HelpDocsLayout sidebar + IntersectionObserver scrollspy + exported scrollToHelpSection), T329 FU-4b/d (agentId-node cross-nav to Agents tab + roleKind legend). Reviews R392-R397 go-ahead (T325 took 1 criticism round). Merged 04cc14d/82c0b66/fe7205f/b2a9b9f/891a39f/768a10d. bun run check green 1368/0; nix build .#ledger-web exit 0. FU-1's underlying Agents-tab display issue is a deploy action (rebuild+restart), out of scope."
    title: "G38 follow-up #1 — ledger-web help-popup UX + deepened Flows tab"
    status: done
  - id: M136
    path: ./archive/tasks/M136.md
    summary: "G41 item 1 COMPLETE (cq init writes cq.toml): T331 CQ_TOML_TEMPLATE constant in cq-cli (opus/sonnet/haiku active, pi commented) + synced cq.toml.example + parity/string-equality tests; T338 runInit writes cq.toml with skip-if-exists + --force overwrite per Q184. Reviews R401/R404 go-ahead. bun run check green. Merged 03a3ac7 (+ T331 e2179a3)."
    title: G41-1 cq init writes cq.toml
    status: done
  - id: M137
    path: ./archive/tasks/M137.md
    summary: "G41 item 4 COMPLETE (Flows-tab polish, web): T332 underline on activatable DiagramSvg node labels; T333 withTerminalNodes derives terminal:true on zero-outgoing-edge nodes (rx=4 vs rx=14) across all 4 ROLE_FLOWS; T334 parallel-edge labels get distinct per-index testids (ELK already routes them 30-34px apart — no visual overlap; the defect was a testid collision) + docs/drafts label audit. Reviews R403/R405/R408 go-ahead. bun run check green. Merged 3f14794/18d73dc/565500b."
    title: G41-4 Flows-tab polish (web)
    status: done
  - id: M139
    path: ./archive/tasks/M139.md
    summary: "G41 item 2 COMPLETE (formal typed MCP prompt catalog): T336 typed PromptCatalogEntry model + RoleKind split + plan-advance JSON Schemas in @cq/config (Ajv2020 + FOD refresh; K65 locked); T341 catalog store + 7 dispatched-role schema sidecars + gen-agents emits typed schemas (deterministic, drift-guarded, ledger-mcp-importable); T343 fetch_prompt/validate_input/validate_output MCP tools (both stdio+SDK factories); T344 plan-advance dispatch wired through the catalog (proof) + Agents tab renders typed schemas; T345 all 7 dispatched subagents wired at plan/implement/investigate advance.md + duplicated prose ioSchema removed. Reviews R410-R414 go-ahead. bun run check green (1486). Merged bcafd66/b502a61/dc87ba7/c2fa526/a873912."
    title: G41-2 Formal typed MCP prompt catalog
    status: done
  - id: M140
    path: ./archive/tasks/M140.md
    summary: "G41 item 3 COMPLETE (orphan-branch feasibility SPIKE): T337 — verdict FEASIBLE-WITH-CAVEATS (GO) in locked decision K66, with an executed throwaway PoC proving the pure git-plumbing path (hash-object→scratch-index write-tree→commit-tree→CAS update-ref) advances an orphan ledger ref while the main checkout HEAD/worktree/index stay byte-identical; findings doc docs/drafts/20260609-221530-orphan-ledger-feasibility.md + PoC under debug/; no production code. A separate follow-up goal would implement a GitObjectLedgerBackend + drop the per-merge chore(ledger) commits + explicit push/fetch of the orphan ref. Review R415 go-ahead. Merged e108827."
    title: G41-3 Ledger-on-orphan-branch feasibility spike
    status: done
  - id: M142
    path: ./archive/tasks/M142.md
    summary: "G42 (fix D47) COMPLETE: T346 (test-only, canonical-ledgers.test.ts) — the committed-vs-canon guard now boots with onSchemaDivergence:'abort' (structural drift THROWS instead of silently self-healing via the default backup-reinit) + a byte-equality assertion (committed docs/ledgers.yaml === serializeRegistry(CANONICAL_LEDGERS)) under bun run check + a reproduce-first proving the old default self-heals while abort rejects. D47 RESOLVED. Review R417 go-ahead. bun run check green (1488). Merged ffce89c."
    title: "G42-fix: ledgers.yaml drift guard fails check"
    status: done
  - id: M138
    path: ./archive/tasks/M138.md
    summary: "G41 item 5 COMPLETE (Ideas ledger + idea-id command args): T335 ideas ledger schema in CANONICAL_LEDGERS (idPrefix I; title+description; open|planned|discarded|postponed, postponed→open); T339 'Ideas' sidebar group above Goals (flat list, generic updateItem); T340 /cq:plan accepts idea-ids (one goal per idea + named consume-an-idea sub-procedure); T342 /cq:plan:follow-up appends idea scope (DRY-references the sub-procedure). Defect D47 (filed by the T335 review) investigated→root-caused (H34)→fixed via G42/T346 and RESOLVED. Reviews R402/R406/R407/R409 go-ahead. bun run check green. Merged 9feb683/a39fd94/6aedb28/02ceded."
    title: G41-5 Ideas ledger + idea-id command args
    status: done
  - id: M144
    path: ./archive/tasks/M144.md
    summary: "G43-W1 complete: extracted the LedgerPersistence byte-I/O seam (T347), the AbstractLedgerStore base holding all persistence-agnostic logic over that seam (T350), and FsLedgerStore reimplemented as base + FsPersistence (T351, co-delivered in b7c64ce). Behaviour-preserving — full ledger suite green unchanged (1488/0/1skip); both merges adversarially reviewed (R420, R421). Seam is ready for the GitPersistence impl in M145."
    title: "G43-W1: extract LedgerStore persistence seam + AbstractLedgerStore base (Q190)"
    status: done
---

# tasks

## M145

### T348 — done

- createdAt: 2026-06-10T09:02:30.973Z
- updatedAt: 2026-06-10T10:14:32.094Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Add a GitPlumbing helper wrapping hash-object/scratch-index/commit-tree/CAS update-ref
- description: "Create packages/ledger/src/store/git/GitPlumbing.ts: a thin, INJECTABLE wrapper over the `git` invocations proven in the K66 PoC (nix/pkg/cq-ledgers/debug/20260609-221530-orphan-ledger-poc.sh). Methods: hashObject(content)→blobSha (git hash-object -w --stdin); writeTree(entries:{mode,sha,path}[])→treeSha building an ISOLATED scratch index via GIT_INDEX_FILE→throwaway path + `git update-index --add --cacheinfo` per entry then `git write-tree` (NEVER the real index); commitTree(tree,parent|null,message)→commitSha (orphan when parent null); updateRef(ref,newSha,expectedOldSha|null) using CAS form `git update-ref <ref> <new> <old>` that FAILS on stale old (surface a typed StaleRefError); readRef(ref)→sha|null; catFile(ref,path)→string (git cat-file -p <ref>:<path>); lsTree(ref)→path[] (git ls-tree -r --name-only); tagRef(tag,sha). All commands run with explicit cwd=repo root + a controlled env (scratch GIT_INDEX_FILE in a tmp dir, never the repo index). Inject the git runner (exec seam) so tests drive it against a throwaway repo."
- acceptance: "A focused test against a throwaway /tmp git repo: writing two files advances an orphan ref two commits while `git status`/HEAD/working-tree/index stay byte-identical (mirrors the PoC proof); a CAS updateRef with a stale expectedOld throws StaleRefError; catFile/lsTree read back content with no checkout. tsc -b + lint clean."
- suggestedModel: frontier
- ledgerRefs: ["goals:G43"]
- resultCommit: a105cf765ffd37382be3ea871cb6509fe78a9c70
- completion: "GitPlumbing.ts: injectable GitRunner-seam wrapper (default nodeGitRunner via child_process.execFile) over hashObject/writeTree(isolated GIT_INDEX_FILE)/commitTree(orphan when parent null)/CAS updateRef(StaleRefError)/readRef/catFile/lsTree/tagRef — the exact K66-PoC invocations. 7-test suite proves orphan-ref byte-identical isolation (HEAD/status/index unchanged), stale-CAS StaleRefError, no-checkout reads. check green 1496/0 on main (gitPlumbing suite 7/0). Reviewer filed 1 low future-hardening defect D49 (over-broad updateRef error mapping)."
- sessionLogs: ["docs/logs/20260610-101400-aaabcbef451ca7e95.md","docs/logs/20260610-101400-a347b100deadd738d.md"]

### T352 — done

- createdAt: 2026-06-10T09:03:42.377Z
- updatedAt: 2026-06-10T10:35:34.815Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Implement GitObjectLedgerBackend via a GitPersistence seam impl over the orphan ref
- description: "Add GitObjectLedgerBackend extending AbstractLedgerStore with a GitPersistence seam backed by GitPlumbing against refs/heads/cq-ledger (branch configurable, default cq-ledger). Per Q191/K66: init() reads every docs/<ledger>.md + docs/ledgers.yaml via catFile(ref,path)/lsTree(ref) into the SAME in-memory map (reads stay SYNC — no interface change); if the ref is absent, create the orphan ref from an empty tree (parentless first commit). A WRITE serialises the touched ledger to text, then INSIDE the existing per-ledger AsyncMutex+lockfile critical section: read the CURRENT ref sha (expected-old), hash-object the new blob, write a tree from a scratch index containing ALL current ledger files with the one path replaced, commit-tree (orphan on first, child thereafter), then CAS updateRef(ref,new,expectedOld) — a StaleRefError surfaces the lost-update race loudly (caveat 1). Every mutation advances the ref (continuous commit history). Archive files (docs/archive/...) live as paths in the SAME orphan tree. Advisory docs/.locks/*.lock STAY on the real FS (gitignored), NEVER in the tree (caveat 2). Schema-divergence reinit: tag refs/tags/cq-ledger-backup-<ts> at the current orphan head BEFORE reinitialising the ref (Q195(1)); detection (schemasEqual) is the shared base's, unchanged. NO ~/.cache mirror (Q195(2)). currentSourceToken()=ref sha. `git cat-file` is used ONLY at init + coherence-reload, never per read-call."
- acceptance: A throwaway-repo test constructs GitObjectLedgerBackend, performs create/update/archive ops + reads them back; `git status` stays clean and HEAD/working-tree/index stay byte-identical after every write; the orphan ref advances one commit per mutation; lockfiles never appear in `git ls-tree -r cq-ledger`; a divergence triggers a refs/tags/cq-ledger-backup-<ts> tag before reinit. tsc -b + lint clean.
- suggestedModel: frontier
- dependsOn: ["T348","T351"]
- ledgerRefs: ["goals:G43"]
- resultCommit: 316764988e31f040f946232db9e8f464d947d69e
- completion: GitObjectLedgerBackend extends AbstractLedgerStore<GitPersistence>; GitPersistence implements LedgerPersistence over an orphan ref (refs/heads/cq-ledger) via GitPlumbing. Docs-relative tree paths; each mutation = one atomic read-old→rebuild-tree→commit-tree→CAS-updateRef advance (StaleRefError propagates); init seeds ref from empty tree; reads SYNC from in-memory map; locksRoot on real FS (no lockfiles in tree); backupCanonicalState tags cq-ledger-backup-<ts> before reinit; no ~/.cache mirror. Added GitPlumbing.lsTreeEntries. check green 1537/0 on main (git-backend+plumbing 48/0); shared abstract suite runs against the git backend (FS-parity); host-checkout byte-invariance + one-commit-per-mutation + no-lockfiles-in-tree + divergence-backup-tag all proven.
- sessionLogs: ["docs/logs/20260610-103508-aa171958d829a3bfe.md","docs/logs/20260610-103508-a411862b5a47dd1c0.md"]

### T353 — done

- createdAt: 2026-06-10T09:03:53.111Z
- updatedAt: 2026-06-10T11:17:11.609Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Add a ref-sha coherence watcher that drives invalidate() for the git backend
- description: "Add a ref-sha coherence trigger for the GIT backend (Q191). Add startLedgerRefWatcher(store, root, onChange?) that watches/polls the orphan ref refs/heads/cq-ledger for sha changes on a bounded interval (reuse the existing watcher's DEBOUNCE_MS cadence) and, on a change, calls store.invalidate(<ledgerId>) per ledger then fires onChange so the HTTP host still publishes the WS `ledger.changed` frame; invalidate() in the git backend re-reads the changed ledger(s) from the new ref via the seam. IMPORTANT (R418/opus): do NOT assume the ref lives at a literal `.git/refs/heads/cq-ledger` — that breaks under git-dir indirection (a linked worktree where `.git` is a FILE, a submodule, or a $GIT_DIR/core.worktree override; K66 keeps the linked-worktree approach as the documented fallback). RESOLVE the ref's real location via `git rev-parse --git-path refs/heads/<branch>` (+ `--git-path packed-refs`) at startup, or simply poll `git rev-parse --verify refs/heads/<branch>` (git resolves loose/packed/indirection itself) — never a hard-coded `.git/...` path. Per-backend selection is owned by the construction site (T357): the FS backend keeps the existing docs/*.md startLedgerWatcher; the git backend uses THIS ref-sha watcher INSTEAD (this is the Q191 'replace the file-watch trigger' applied per-backend, not in addition). The WS onMutation/`ledger.changed` broadcast itself is backend-agnostic and UNCHANGED."
- acceptance: "A test: two GitObjectLedgerBackend instances on the same repo; a write through instance A advances the ref, and after the ref-watcher fires, instance B's reads reflect A's write (cross-process coherence) and onChange was invoked with the ledger id. The watcher resolves the ref via `git rev-parse --git-path`/`rev-parse --verify` (NOT a literal `.git/refs/...` path) — covered by a test that points the repo's git dir somewhere non-default (e.g. a linked worktree or GIT_DIR override) and confirms the watcher still detects the advance. tsc -b + lint clean."
- suggestedModel: standard
- dependsOn: ["T352"]
- ledgerRefs: ["goals:G43"]
- resultCommit: ed1837ece4d400a139b27407b400d54ce811bb7f
- completion: "startLedgerRefWatcher (packages/ledger-mcp/src/refWatcher.ts): polls refs/heads/<branch> via `git rev-parse --verify` (no `.git/refs` literal — robust under git-dir indirection/linked worktrees); on ref advance calls store.invalidate(id) per enumerated ledger then onChange(id). Injected GitRunner; close() handle; re-exported from main.ts (export only — per-backend wiring is T357). Round 1 (0910d96) DISAPPROVED — delivered test flaky 2/4 under load. Orchestrator round-2 fix (e4233c0): found a deeper PRODUCTION defect — the watcher captured its baseline lastSha only at the first poll TICK, so a ref advance in the start→first-tick window was silently missed (under load onChange never fired → timeout). Fixed by establishing the baseline immediately via poll() at startup (caller already awaited init). Round-2 re-review (opus) APPROVED: flake resolved (8/8 isolated + 3/3 full-suite, 1541/0), immediate-poll change correct (undefined-sentinel guards spurious fire, single timer schedule, safe close race). check green 1541/0 on main; verified 3x on main post-merge."
- sessionLogs: ["docs/logs/20260610-111626-a73fe9f4e95d631a4.md","docs/logs/20260610-111626-a15622a16712fca3d.md","docs/logs/20260610-111626-orchestrator-fix.md","docs/logs/20260610-111626-a22ee1e06785c711c.md"]

## M146

### T349 — planned

- createdAt: 2026-06-10T09:02:36.432Z
- updatedAt: 2026-06-10T09:02:36.432Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Add the [ledger] backend config key to @cq/config (git-object | fs, default fs)"
- description: "Extend @cq/config: parse an optional top-level [ledger] table with `backend` ('fs' default | 'git-object'), optional `branch` (default 'cq-ledger') and `remote` (default 'origin', consumed by W5). Add the resolved ledger-backend settings to the parsed config; absence of [ledger] or of cq.toml → backend 'fs' (FsLedgerStore stays default, opt-in-experimental per Q189). Reject an unknown backend value with a CqConfig error. Add a documented, COMMENTED-OUT [ledger] block to CQ_TOML_TEMPLATE in cq-cli/src/cqTomlTemplate.ts (cq-config has no serializer; hand-authored literal) and keep cq.toml.example in sync. Scope is server/cwd-global."
- acceptance: "parseConfig tests: cq.toml with [ledger] backend='git-object' resolves to git-object; omitting [ledger] resolves to fs; unknown backend throws; re-parsing CQ_TOML_TEMPLATE still resolves cleanly + yields backend fs (commented block inert); cq.toml.example consistent. tsc -b + lint clean."
- suggestedModel: standard
- ledgerRefs: ["goals:G43"]

### T357 — planned

- createdAt: 2026-06-10T09:04:31.102Z
- updatedAt: 2026-06-10T09:20:55.438Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Select the backend at every store construction site by [ledger] backend (+ git-env validation)"
- description: "Add a single createLedgerStore(root) factory (e.g. in ledger-mcp or a shared module) that loads cq.toml's [ledger] backend and returns FsLedgerStore (default) or GitObjectLedgerBackend, then init()s it. Route ALL construction sites through it: ledger-mcp/src/main.ts createEmbeddedStore() + main() (the `new FsLedgerStore({root})` site), and cq-cli/src/main.ts runInit()/runReset(). When backend='git-object', VALIDATE the git environment at startup (git available + the cwd is inside a git work tree) and FAIL-FAST with a clear error if not. FRESH-INIT GITIGNORE (R418/codex+grok): when `cq init` (or first backend startup) runs with backend='git-object' on a repo with NO pre-existing ledger to migrate, ensure docs/*.md + docs/ledgers.yaml are gitignored from the start (add the same clearly-marked git-backend .gitignore block that `cq move-ledger --to git` uses, idempotently — do not duplicate it if move-ledger already added it) so a fresh git-object ledger is never accidentally tracked on the working branch. Preserve buildServer's capability wiring: read_log/config/promptCatalog are gated on `store instanceof FsLedgerStore` today — generalise to a capability check so an FS-only capability (readLog, ~/.cache restore) is absent for the git backend while config/promptCatalog (root-bound, backend-independent) remain available. Select the coherence watcher (file-watch for fs vs ref-sha-watch for git-object, T353) by backend here too."
- acceptance: "With cq.toml [ledger] backend='git-object', `ledger-mcp` (stdio) starts against a git repo, serves tools, and reads/writes land on the orphan ref (verified by `git log cq-ledger`); a non-git cwd fails fast with a clear error; `cq init` with backend='git-object' on a fresh repo leaves docs/*.md + docs/ledgers.yaml gitignored (not tracked); with backend fs (or no cq.toml) it behaves exactly as today; the per-backend coherence watcher is selected here. tsc -b + lint + `bun run check` clean."
- suggestedModel: frontier
- dependsOn: ["T349","T353"]
- ledgerRefs: ["goals:G43"]

### T360 — planned

- createdAt: 2026-06-10T09:04:55.841Z
- updatedAt: 2026-06-10T09:04:55.841Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Confirm zero frontend changes: frontends refresh solely via WS ledger.changed"
- description: Per Q192, VERIFY (read-through of ledger-tui + ledger-web refresh paths) that the TUI and web frontends learn about changes ONLY via the internal WS `ledger.changed` channel (fired by onMutation, backend-agnostic) and NOT via any path that reads docs/*.md mtimes directly — which would break when docs/*.md no longer exist on the working branch under the git backend. Frontends are pure MCP clients (CLAUDE.md) even embedded; embedded-mode frontends co-host the store in-process, so they are covered by the backend's own onMutation + ref-sha coherence. If the verification holds, scope ZERO frontend code changes and record the confirmation as a `decisions` item citing the exact refresh code paths; if any path watches docs/ mtimes, file it as an out-of-scope `defects` item for the reviewer (do not fix here unless a trivial repoint).
- acceptance: A `decisions` item records the confirmation, citing the exact frontend refresh code paths showing they key on WS `ledger.changed` only (no docs/*.md-mtime dependency for change detection). If a violation is found, a `defects` item exists. No frontend source changed unless a violation required a trivial repoint. tsc -b + lint clean.
- suggestedModel: standard
- dependsOn: ["T357"]
- ledgerRefs: ["goals:G43"]

## M147

### T354 — planned

- createdAt: 2026-06-10T09:04:02.581Z
- updatedAt: 2026-06-10T09:20:24.790Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Implement `cq move-ledger` CLI for bidirectional git<->local migration
- description: "Add a `move-ledger` subcommand to cq-cli/src/main.ts (extend SUBCOMMANDS, parser, HANDLERS, USAGE) — a NATIVE TypeScript subcommand analogous to runInit/runReset (NOT a prompt-driven command). Per Q193 (user request) it performs LOSSLESS BIDIRECTIONAL transplant of the live ledger between the docs/ working tree and the orphan ref refs/heads/cq-ledger, via an EXPLICIT `--to git | local` direction (refuse without it). **--to git:** snapshot the current docs/*.md + docs/archive + docs/ledgers.yaml tree into the orphan ref's commit via GitPlumbing; then `git rm --cached docs/*.md`(+archive+ledgers.yaml) on the working branch and add a clearly-marked, reversible git-backend block to .gitignore (docs/*.md + docs/ledgers.yaml) so the docs ledger files stop being TRACKED, leaving pre-migration tracked history FROZEN in place for audit; set [ledger] backend='git-object' in cq.toml. WORKING-TREE FILE DISPOSITION (R418/opus): the now-untracked docs/*.md files are LEFT IN PLACE on disk (do NOT delete them) — they become untracked-but-present and are simply ignored by git; print a note that they may be removed manually once the user is confident. **--to local:** the REVERSE — materialize the orphan ref's tree back to docs/*.md on disk, re-track them (remove the git-backend .gitignore block + re-add), set backend='fs'. Refuse if the target already holds a non-empty ledger unless `--force`; print a per-ledger moved-file summary; honour the [ledger] branch name. Document the linked-worktree fallback (`git worktree add <dir> cq-ledger`) in the command help. The .gitignore edit must be reversible by the opposite direction."
- acceptance: "Round-trip test in a throwaway repo: seed docs/ ledgers, `cq move-ledger --to git` → orphan ref carries identical ledger bytes, docs ledger files UNTRACKED (`git ls-files docs/` shows none) but STILL PRESENT on disk (left-in-place), cq.toml backend=git-object; `cq move-ledger --to local` restores TRACKED docs/*.md byte-identical to the orphan-ref content + backend=fs; the round trip is provably lossless INCLUDING on-disk file state (the docs/*.md bytes before --to git equal the bytes after --to local) and tracked-state (tracked→untracked→tracked); refuses a non-empty target without --force. tsc -b + lint clean."
- suggestedModel: frontier
- dependsOn: ["T352","T349"]
- ledgerRefs: ["goals:G43"]

## M148

### T355 — planned

- createdAt: 2026-06-10T09:04:09.640Z
- updatedAt: 2026-06-10T09:20:39.465Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Wire auto-fetch-at-start / non-forced auto-push-at-end of refs/heads/cq-ledger into the /cq:* commands"
- description: "Per Q194: add to EACH /cq:* command prompt that touches the ledger — nix/pkg/cq-assets/commands/cq/{advance.md, plan/advance.md, implement/advance.md, AND investigate/advance.md (it DOES carry a standalone-stop `chore(ledger): /cq:investigate:advance` commit per its §Commit the ledger section, so it is in scope)} — a START step that auto-fetches the orphan ref from the configured remote (default origin) `git fetch <remote> refs/heads/cq-ledger:refs/heads/cq-ledger` and an END step that auto-pushes it `git push <remote> cq-ledger` with a PLAIN non-forced push so divergence FAILS LOUDLY (no --force; CAS update-ref already guards local lost-updates). These steps run ONLY when [ledger] backend='git-object' (guard the step on the backend). Write a CONCRETE manual-recovery runbook at docs/drafts/<ts>-orphan-ledger-runbook.md (or a committed docs/ note) covering: a rejected non-ff push (fetch → inspect `git log cq-ledger` → reconcile → retry), that single-branch/shallow clones must fetch the ref explicitly, AND the documented linked-worktree FALLBACK (`git worktree add <dir> cq-ledger` to materialize the ref in a separate work tree without touching the main checkout). NO per-write push. Re-run gen-agents-catalogue if these command files are catalogued so the generated copies match."
- acceptance: All FOUR command prompts (advance, plan/advance, implement/advance, investigate/advance) contain backend-guarded fetch(start)/push(end) steps for refs/heads/cq-ledger against the configured remote with NO --force; a runbook note FILE exists at a named docs/ path covering rejected-push recovery + shallow-clone fetch + the linked-worktree fallback; gen-agents regen (if catalogued) leaves no drift; grep confirms the refspec + non-forced-push wording in each. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T349"]
- ledgerRefs: ["goals:G43"]

### T358 — planned

- createdAt: 2026-06-10T09:04:37.026Z
- updatedAt: 2026-06-10T09:20:46.044Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Make the per-merge/per-archive `git add docs/ … chore(ledger)` command steps backend-conditional
- description: "Per K66 caveat 4: the git backend commits the ledger continuously per write on the orphan ref, so the COMMAND-LEVEL `git add docs/ && git commit -m \"chore(ledger): …\"` steps become redundant AND wrong (docs/*.md are untracked on the working branch after `cq move-ledger --to git`). Make these steps BACKEND-CONDITIONAL: skip them when [ledger] backend='git-object' (the orphan ref already carries the writes), keep them for backend='fs'. Cover EVERY command file that has such a step — commands/cq/{advance.md, implement/advance.md (the per-merge + per-archive checkpoints), plan/advance.md (the after-planning-lock + at-stop commits), AND investigate/advance.md (its standalone-stop `chore(ledger): /cq:investigate:advance` commit)}. Be surgical — only the ledger-commit blocks change; worktree-cleanup + other steps stay. Re-run gen-agents-catalogue (these command files are catalogued per K64/T322) so the generated agentsCatalogue.gen.ts matches."
- acceptance: Each of the FOUR command prompts gates its `git add docs/ … chore(ledger)` block on the fs backend (skipped under git-object); agentsCatalogue.gen.ts regenerated (no drift); a grep-invariant or manual grep confirms no UNCONDITIONAL ledger-commit remains in any of the four; `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T355"]
- ledgerRefs: ["goals:G43"]

## M149

### T356 — planned

- createdAt: 2026-06-10T09:04:14.875Z
- updatedAt: 2026-06-10T09:04:14.875Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Run the shared LedgerStore conformance suite against GitObjectLedgerBackend (dual-tests)
- description: "Per Q196: parameterise the existing abstract LedgerStore conformance test body (already run against FsLedgerStore + InMemoryLedgerStore per the dual-tests pattern; InMemoryLedgerStore at packages/ledger/src/store/InMemoryLedgerStore.ts is the canonical dummy) to ALSO run against GitObjectLedgerBackend. Each test constructs a THROWAWAY git repo (init a tmp repo, point the backend at it, dispose+rm after) exactly as the FS tests construct throwaway docs dirs — add a throwaway-git-repo helper alongside the existing throwaway-dir helper. The suite must exercise reads/writes/archive/unarchive/createLedger/concurrency + the CAS-conflict path so reads/writes/archive/concurrency parity is proven identical across all three backends."
- acceptance: "`bun test` runs the full conformance body three times (Fs, InMemory, Git) all green; the Git run uses a fresh throwaway repo per test + leaves no residue; any parity gap surfaces as a failing conformance assertion (not a Git-only special-case). tsc -b + lint clean."
- suggestedModel: frontier
- dependsOn: ["T352"]
- ledgerRefs: ["goals:G43"]

### T359 — planned

- createdAt: 2026-06-10T09:04:43.537Z
- updatedAt: 2026-06-10T09:04:43.537Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Add git-invariant tests (byte-identical tree/HEAD/index, ref-advance, CAS reject, lock-not-committed, backup-tag)
- description: "Per Q196, add explicit tests for the git-specific invariants the K66 PoC validated — these invariants are the WHOLE POINT of the backend and must be regression-guarded: (1) after any GitObjectLedgerBackend write, the repo's working tree (sha256 of tracked files), HEAD ref, and index (`git ls-files -s` digest) are BYTE-IDENTICAL to before, and `git status --porcelain` is empty (no working-tree switch); (2) the orphan ref advances exactly one commit per mutation and the first commit is parentless (a true orphan); (3) a CAS update-ref with a STALE expected-old SHA is REJECTED (simulate a concurrent advance between read and update-ref) and surfaces StaleRefError rather than silent last-writer-wins; (4) advisory .lock files NEVER appear in `git ls-tree -r cq-ledger` (lockfiles stay on the real FS, gitignored); (5) the schema-divergence reinit tags refs/tags/cq-ledger-backup-<ts> at the prior orphan head before resetting the ref. Run against a throwaway repo per test."
- acceptance: "`bun test` green for all five invariant groups; the byte-identical assertion runs after a real create+update+archive sequence; the CAS-stale test asserts the typed StaleRefError; the lock-not-committed test enumerates the orphan tree and asserts no .lock path; the backup-tag test asserts the tag exists at the prior head. tsc -b + lint + `bun run check` clean."
- suggestedModel: frontier
- dependsOn: ["T356"]
- ledgerRefs: ["goals:G43"]
