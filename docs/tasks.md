---
ledger: tasks
counters:
  milestone: 0
  item: 281
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
---

# tasks

## M91

### T226 — done

- createdAt: 2026-06-07T19:40:07.318Z
- updatedAt: 2026-06-07T23:40:32.607Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: "Acceptance demo: one read-only explorer dispatch under Pi returning parseable evidence-json"
- description: "Per Q128 (acceptance, 'as recommended') AND R265's END-TO-END Q126 verification gap: demonstrate ONE read-only explorer dispatch (investigate-style) completing UNDER PI on THIS repo in the NORMAL non-sandboxed env, DRIVEN BY THE ACTUAL UNCHANGED cq command prompt — NOT by a hand-written dispatch_agent({...}) call. Launch the wrapped pi harness (piWrapped, cwd = repo root) and run an UNCHANGED cq command that fires an investigate-explorer dispatch (e.g. the investigate/advance promptTemplate against a real hypothesis + branch context about this repo). Per decision K44 the prompt text itself stays byte-identical (any Pi-side trigger lives in a Pi-side context asset, never in nix/pkg/cq-assets). Observe the Pi model fire the dispatch tool from that unchanged prompt, the child run read-only (filtered toolset: no Write/Bash/dispatch per investigate-explorer's disallowedTools), and the child return the explorer's structured evidence block (numbered file:line + excerpt + relevance) that the orchestrator can parse. Capture the prompt invocation, the dispatch the model emitted, the child's filtered toolset, and the returned structured result as evidence."
- acceptance: "Captured pi transcript shows, end-to-end from an UNCHANGED cq prompt: (1) the unchanged cq command/promptTemplate was run under piWrapped (cwd = repo root) — record the exact command/template invoked and its capture (pi transcript/log); (2) the Pi model fired the dispatch tool for investigate-explorer FROM the unchanged prompt text (not a manual dispatch_agent call); (3) the child ran read-only (its toolset shows NO Write/Bash/dispatch, matching investigate-explorer.md's disallowedTools); (4) the child returned a parseable structured evidence block matching investigate-explorer.md's contract and the orchestrator-side parse of it succeeds; (5) `git diff` asserts nix/pkg/cq-assets is UNTOUCHED after the run (the prompts truly ran unchanged). Demonstrated on THIS repo, non-sandboxed."
- suggestedModel: frontier
- dependsOn: ["T225","T229"]
- ledgerRefs: ["goals:G28"]
- blockedBy: ["Q131"]
- resultCommit: fa5bc9e
- completion: "ACCEPTANCE DEMO (Q128): an UNCHANGED cq investigate-explorer dispatch prompt drove grok-build to fire dispatch_agent(agent=investigate-explorer); child ran read-only (excludedTools=[dispatch_agent,write,edit,bash]) and returned a parseable fenced-json evidence block (8 file:line citations); orchestrator parse succeeded; cq-assets untouched. Evidence in docs/drafts/20260608-0029-T226-explorer-dispatch-demo.md. Merged."
- sessionLogs: ["docs/logs/20260607-233329-aa0c624118a6e9655.md","docs/logs/20260607-233329-T226-T227-reviews.md"]

### T227 — done

- createdAt: 2026-06-07T19:40:15.244Z
- updatedAt: 2026-06-07T23:40:36.336Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: "Acceptance demo: one reviewer dispatch under Pi returning a parseable verdict-json"
- description: "Per Q128 AND R265's END-TO-END Q126 verification gap: demonstrate ONE reviewer dispatch (plan-review-style) completing UNDER PI on THIS repo non-sandboxed, DRIVEN BY THE ACTUAL UNCHANGED cq command prompt — NOT a hand-written dispatch_agent({...}) call. Launch piWrapped (cwd = repo root) and run an UNCHANGED cq command that fires a plan-reviewer dispatch (e.g. the plan/advance flow's review step, or the cq:plan-review rubric prompt, against a real or sample emitted plan). Per decision K44 the cq command prompt stays byte-identical (any Pi-side trigger lives in a Pi-side context asset). Observe the Pi model fire the dispatch from the unchanged prompt and the child return the single fenced-json verdict ({ summary, verdict, new_questions, criticism, defects }) that the orchestrator parses. Together with the explorer demo (T226) this proves the dispatch primitive works for BOTH the read-only-explorer and reviewer subagent shapes. Record explicitly that full unattended-sandbox + implement-worker (worktree-isolation) validation is the deferred FOLLOW-UP, out of scope for G28. INDEPENDENT of T226 — both depend only on T225."
- acceptance: "Captured pi transcript shows, end-to-end from an UNCHANGED cq prompt: (1) the unchanged cq command/promptTemplate (plan-review step / cq:plan-review rubric) was run under piWrapped (cwd = repo root) — record the exact command invoked and its capture; (2) the Pi model fired the dispatch for plan-reviewer FROM the unchanged prompt text; (3) the child returned a SINGLE fenced-json verdict conforming to the plan-review contract (parseable new_questions[]/criticism[]/defects[]/verdict) and the orchestrator-side parse succeeds; (4) `git diff` asserts nix/pkg/cq-assets is UNTOUCHED after the run. Demonstrated on THIS repo, non-sandboxed. A short note records that sandbox + implement-worker validation is deferred to a follow-up goal."
- suggestedModel: frontier
- dependsOn: ["T225","T229"]
- ledgerRefs: ["goals:G28"]
- blockedBy: ["Q131"]
- resultCommit: 8727d15
- completion: "ACCEPTANCE DEMO (Q128): an UNCHANGED cq plan-review prompt drove grok-build to fire dispatch_agent(agent=plan-reviewer); child returned a single fenced-json verdict with all 5 plan-review contract keys; orchestrator fence-strip+jq parse succeeded; cq-assets untouched; sandbox+implement-worker deferred-follow-up recorded. Off-enum verdict value filed as D38. Evidence in docs/drafts/20260608-0022-T227-reviewer-dispatch-demo.md. Merged."
- sessionLogs: ["docs/logs/20260607-233329-afa0391d57f11518e.md","docs/logs/20260607-233329-T226-T227-reviews.md"]

## M109

### T267 — done

- createdAt: 2026-06-08T16:56:59.978Z
- updatedAt: 2026-06-08T18:18:13.497Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Rename the State Machines tab to Item States (label + ALL internal identifiers)
- description: |
    In nix/pkg/cq-ledgers/packages/ledger-web/src/App.tsx (HelpOverlay) and styles.css, rename the 'State Machines' help tab to 'Item States' per Q146 — BOTH the visible label AND every internal identifier:
    - tab-state union member 'statemachines' -> 'item-states' (the useState<...> type + every setTab/comparison);
    - visible label text 'State machines'/'State Machines' -> 'Item States';
    - data-testid help-tab-statemachines -> help-tab-item-states, help-statemachines -> help-item-states;
    - per-ledger diagram ids/section testids help-statemachine-<ledger> -> help-item-state-<ledger> (the StateMachineDiagram component + its DiagramSvg idPrefix);
    - CSS classes lw-statemachine* (e.g. lw-help-statemachines, lw-statemachine, lw-statemachine-svg) -> lw-item-state* in App.tsx AND styles.css.
    Per Q145 the TUI has no help popup and is LEFT UNCHANGED. Surgical: do not touch the Shortcuts or Flows tabs. The internal React function name (StateMachineDiagram) may stay if convenient, but every DOM-visible id/class/testid/label moves to the item-states scheme.
- acceptance: "From nix/pkg/cq-ledgers/: (negative) `rg -n 'statemachine|State machines|State Machines' packages/ledger-web/src` returns no DOM id/class/testid/label matches; (positive) `rg -n 'item-state' packages/ledger-web/src` shows the new testids/ids/classes AND the tab-state union now contains 'item-states' AND HelpOverlay renders the renamed 'Item States' tab button (data-testid help-tab-item-states) with one diagram per ledger under help-item-state-<ledger>; `bun run typecheck` green. (Render assertions are exercised by the W1 happy-dom test T269.)"
- suggestedModel: standard
- ledgerRefs: ["goals:G34"]
- resultCommit: 2b1a2e0
- completion: Renamed the web help 'State Machines' tab to 'Item States' — every DOM-visible identifier migrated to the item-states scheme (tab-state union member, label, data-testids help-tab-item-states/help-item-states, per-ledger help-item-state-<ledger>, DiagramSvg idPrefix, CSS lw-item-state*) in App.tsx + styles.css; two happy-dom tests updated. Cherry-picked onto main (clean; worker worktree was stale-based). Reviewed APPROVE; integrated bun run check green 1135/1skip/0.
- sessionLogs: ["docs/logs/20260608-180917-a27f1b85731cda97f.md","docs/logs/20260608-181727-a0ebdfdbc5ec7ed80.md","docs/logs/20260608-181727-pi-minimax-T267.md"]

### T269 — done

- createdAt: 2026-06-08T16:57:16.294Z
- updatedAt: 2026-06-08T18:19:48.963Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Update happy-dom web tests for the renamed Item States tab
- description: "Update the ledger-web happy-dom test(s) that assert on the old help testids (help-tab-statemachines / help-statemachines / help-statemachine-<ledger>) to the new item-states testids (help-tab-item-states / help-item-states / help-item-state-<ledger>). Preserve test intent: clicking the tab still loads one per-ledger diagram. Find the test file via `rg -n 'help-tab-statemachines|help-statemachines|statemachine' nix/pkg/cq-ledgers/packages/ledger-web/test`."
- acceptance: "From nix/pkg/cq-ledgers/: `bun test packages/ledger-web` green; `rg -n 'statemachine' packages/ledger-web/test` returns nothing; the help test asserts the renamed item-states testids and still covers per-ledger diagram rendering."
- suggestedModel: standard
- dependsOn: ["T267"]
- ledgerRefs: ["goals:G34"]
- resultCommit: 2b1a2e0
- completion: "Satisfied within T267's commit (2b1a2e0): the T267 worker updated packages/ledger-web/test/{helpTabs.test.tsx,stateMachineTab.test.tsx} to the new item-states testids (help-tab-item-states / help-item-states / help-item-state-<ledger>) with per-ledger diagram coverage preserved, to keep `bun run check` green. Verified on main: `rg statemachine packages/ledger-web/test` returns nothing; the tests assert the renamed testids + per-ledger rendering; integrated bun run check green 1135/1skip/0. Those test files were part of the R327-reviewed T267 diff (reviewer noted coverage preserved). No separate worker needed."
- sessionLogs: ["docs/logs/20260608-180917-a27f1b85731cda97f.md"]

## M110

### T268 — done

- createdAt: 2026-06-08T16:57:07.395Z
- updatedAt: 2026-06-08T18:18:17.878Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "Invert TiersConfig type: token-keyed [tiers] classifier ((harness+provider+model) token -> Tier class)"
- description: "In nix/pkg/cq-ledgers/packages/cq-config/src/types.ts, REPLACE the current `TiersConfig` (class -> ReviewerToken: the {fast|standard|frontier: ReviewerToken|undefined} shape) with the inverted CLASSIFIER shape per Q149/Q150: a token->class map keyed by the parseReviewerToken token-grammar STRING (e.g. \"claude:opus-4.8[1m]\"=\"frontier\", \"pi:ollama-cloud/minimax-m3\"=\"standard\", \"claude:haiku-4.5\"=\"fast\"). Model it so each entry preserves the PARSED ReviewerToken plus its assigned Tier and the raw key, e.g. `readonly entries: ReadonlyArray<{ token: ReviewerToken; raw: string; class: Tier }>`, so a token can be classified AND tokens-of-a-class enumerated. Keep Tier/TIERS/isTier/DEFAULT_TIER unchanged; keep agentTiers (agent-name -> Tier) unchanged. Update the CqConfig.tiers doc comment to describe the classifier. BREAKING: no dual-shape, no migration field (project policy; live cq.toml tiers=null)."
- acceptance: "From nix/pkg/cq-ledgers/: `bun run typecheck` green with the new TiersConfig shape; types.ts exports the inverted classifier type; no reference to the removed per-tier ReviewerToken slots remains in types.ts."
- suggestedModel: frontier
- ledgerRefs: ["goals:G34"]
- resultCommit: 47824b6
- completion: "Inverted the TiersConfig TYPE (cq-config/src/types.ts) to a token-keyed classifier (entries: ReadonlyArray<{token,raw,class}>, new TierEntry export); old per-tier ReviewerToken slots removed. Minimal compile-bridges in config.ts/index.ts/ledger-mcp configCapability.ts + 2 test assertions keep bun run check green; full parser/resolver/consumer/test rework deferred to T270/T271/T272/T273. Cherry-picked onto main (clean). Reviewed APPROVE; integrated check green 1135/1skip/0."
- sessionLogs: ["docs/logs/20260608-180917-a8a9ef0963751a6ef.md","docs/logs/20260608-181727-a5a19d637a6699421.md","docs/logs/20260608-181727-pi-minimax-T268.md"]

### T270 — done

- createdAt: 2026-06-08T16:57:23.755Z
- updatedAt: 2026-06-08T18:35:13.275Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Rewrite parseTiers to parse the token-keyed classifier and validate class values
- description: "In nix/pkg/cq-ledgers/packages/cq-config/src/config.ts, rewrite `parseTiers(raw, aliases)` for the inverted [tiers]: each KEY is resolved EXACTLY as the old code resolved tier VALUES today — first try the [aliases] table (the `aliases` arg already passed to parseTiers; an alias name maps to a token string), else parse the KEY directly via parseReviewerToken (the G29 grammar: claude:<model> | pi:<provider>/<model>). Each VALUE is a class name validated via isTier (precise CqConfigError on an unknown class). Record {token, raw, class}. Reject a non-Tier value and a malformed/unknown token key (let alias-miss + parseReviewerToken throw with a precise message). The toml.ts RawToml.tiers becomes Record<string,string> (key=token-or-alias, value=class) — confirm parseStringTable fits or adjust; update toml.ts doc comments describing [tiers] as token->class. Keep parseConfig wiring (`raw.tiers === null ? null : parseTiers(...)`)."
- acceptance: "From nix/pkg/cq-ledgers/: a cq.toml [tiers] with `\"claude:opus-4.8[1m]\" = \"frontier\"`, `\"pi:ollama-cloud/minimax-m3\" = \"standard\"`, and an ALIAS key (e.g. `opus = \"frontier\"` resolving via [aliases]) all parse without error; a non-Tier VALUE throws CqConfigError; a malformed/unknown token-or-alias KEY throws; `bun run typecheck` green. (Behaviour asserted by the W2 test task T273.)"
- suggestedModel: frontier
- dependsOn: ["T268"]
- ledgerRefs: ["goals:G34"]
- resultCommit: 9908c5c
- completion: "Rewrote parseTiers(raw,aliases) for the inverted token-keyed [tiers]: iterates the record resolving each KEY→token (alias via [aliases], else parseReviewerToken G29 grammar) and validating each VALUE→Tier via isTier into TierEntry[] {token,raw:key,class}; non-Tier value + malformed/unknown key throw CqConfigError; dropped the now-unused TIERS import; updated toml.ts doc comments (RawToml.tiers stays Record<string,string>). Minimal [tiers] fixture inversions in 3 tests + cq.toml.example to keep check green. resolveTierToken left intact (T271). FF-merged to main (worktree based on HEAD); bun run check green 1136/0."
- sessionLogs: ["docs/logs/20260608-183431-a416a06bdb13b79c1.md","docs/logs/20260608-183431-a985728ce61704eae.md","docs/logs/20260608-183431-pi-minimax-T270.md"]

### T271 — planned

- createdAt: 2026-06-08T16:57:36.302Z
- updatedAt: 2026-06-08T16:57:36.302Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Replace resolveTierToken/resolveAgentModel with classifyToken + selectTokensForTier (documented tie-break)
- description: "In nix/pkg/cq-ledgers/packages/cq-config/src/config.ts, remove the old `resolveTierToken` (tier -> single ReviewerToken) and rework `resolveAgentModel` per Q149 (classifier model, NOT a tier->single-model lookup). Add: (1) `classifyToken(config, token): Tier | undefined` — look a token up in the inverted [tiers] classifier (compare by normalized token string / structural ReviewerToken equality), returning its class or undefined; (2) `selectTokensForTier(config, tier, candidates): ReviewerToken[]` — filter `candidates` (the active planners/reviewers token list) to those classifying to `tier`, in a DOCUMENTED deterministic tie-break (preserve candidates' configured order; document in JSDoc). Re-point `resolveAgentModel` to: agent-name -> resolveAgentTier (agent_tiers, unchanged) -> selectTokensForTier over the relevant active set -> deterministic first match (precise CqConfigError when no active token classifies to the agent's tier). Update src/index.ts exports: drop resolveTierToken, add classifyToken/selectTokensForTier, keep resolveAgentTier/resolveAgentModel. Update module/JSDoc."
- acceptance: "From nix/pkg/cq-ledgers/: `bun run typecheck` green; `rg -n 'resolveTierToken' packages/cq-config/src` returns no matches; src/index.ts no longer exports resolveTierToken and exports classifyToken/selectTokensForTier. Behaviour (classify correct/undefined; tie-break order; resolveAgentModel throws on no match) asserted by the W2 test task."
- suggestedModel: frontier
- dependsOn: ["T270"]
- ledgerRefs: ["goals:G34"]

### T272 — planned

- createdAt: 2026-06-08T16:57:46.346Z
- updatedAt: 2026-06-08T17:18:31.068Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Update the ACTUAL TS consumers of the changed tier API (cq-config internals + ledger-mcp config capability)
- description: "Grep the workspace for every TS reference to resolveTierToken / resolveAgentModel / TiersConfig: `cd nix/pkg/cq-ledgers && rg -n 'resolveTierToken|resolveAgentModel|TiersConfig' packages`. The reachable consumers are: (1) cq-config itself (config.ts/index.ts — the resolvers + exports, handled by T271); (2) @cq/ledger-mcp's config capability that backs get_config/get_planners/get_reviewers — if it serialized the OLD tier->token shape over MCP, update the serialized shape to the inverted token->class classifier so MCP clients (and the Agents-tab codegen) see token->class. Do NOT assume tui/cli are consumers (frontends are pure MCP clients; cq-cli does not depend on cq-config) — only touch files the rg actually surfaces. No backward-compat shims. Surgical."
- acceptance: "From nix/pkg/cq-ledgers/: `rg -n 'resolveTierToken' packages` returns no matches; `bun run typecheck` green workspace-wide; the rg-surfaced consumer set is exactly the files edited (no consumer left on the old API); from repo root `nix build .#ledger-mcp` green."
- suggestedModel: frontier
- dependsOn: ["T271"]
- ledgerRefs: ["goals:G34"]

### T273 — planned

- createdAt: 2026-06-08T16:57:52.463Z
- updatedAt: 2026-06-08T17:18:34.295Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "Add cq-config tests for the inverted [tiers] classifier grammar + class selection"
- description: "In nix/pkg/cq-ledgers/packages/cq-config/test/, replace the old [tiers] tier->token cases (from T223) with inverted-classifier cases: (a) token-keyed [tiers] including a claude key, a pi:<provider>/<model> key, and `\"claude:haiku-4.5\"=\"fast\"` parses; (b) classifyToken returns the right Tier per token and undefined for an unclassified token; (c) selectTokensForTier returns class-matching active tokens in the documented tie-break order; (d) resolveAgentModel resolves agent-name -> tier -> a class-matching active token end-to-end, and throws CqConfigError when none matches; (e) an unknown class VALUE and a malformed token KEY each throw CqConfigError; (f) cq.toml without [tiers] still yields tiers=null with reviewers/planners intact. Assert exact error messages."
- acceptance: "From nix/pkg/cq-ledgers/: `bun test packages/cq-config` all green; cases cover: token-keyed parse (claude key + pi:<provider>/<model> key + claude:haiku-4.5=fast + an alias key); classifyToken correct/undefined; selectTokensForTier tie-break order; end-to-end resolveAgentModel + no-match throw; unknown class VALUE + malformed token KEY each throw CqConfigError; AND an explicit CONFIG-LOAD test that parseTiers/parseConfig on a config with NO [tiers] section yields tiers=null with reviewers/planners intact (not only the end-to-end path)."
- suggestedModel: standard
- dependsOn: ["T271"]
- ledgerRefs: ["goals:G34"]

### T274 — planned

- createdAt: 2026-06-08T16:57:59.114Z
- updatedAt: 2026-06-08T16:57:59.114Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "Update cq.toml.example + token-format docs to the inverted [tiers] token->class grammar"
- description: |
    Rewrite the [tiers] section in cq.toml.example to the inverted token-keyed classifier, e.g.:
    
    [tiers]
    "claude:opus-4.8[1m]" = "frontier"
    "pi:ollama-cloud/minimax-m3" = "standard"
    "claude:haiku-4.5" = "fast"
    
    Add a leading comment explaining the inversion (CLASSIFIER, not dispatch: it tells cq what tier a concrete (harness,provider,model) token is) and that a suggestedModel tier selects among the explicitly-listed planner/reviewer tokens whose class matches (documented tie-break). Update [agent_tiers] comment accordingly. Update any token-format doc (search for the existing token-grammar doc) to note [tiers] KEYS must be valid ReviewerTokens. Keep [aliases]/reviewers/planners/[agent_tiers] semantics intact. (Live cq.toml is gitignored with tiers=null; do not edit it here.) Add/extend a cq-config test that loads cq.toml.example and asserts no CqConfigError.
- acceptance: "cq.toml.example [tiers] block uses token keys with class values + the explanatory comment; from nix/pkg/cq-ledgers/ a cq-config test loading cq.toml.example passes (no CqConfigError); token-grammar doc mentions the [tiers]-key requirement."
- suggestedModel: standard
- dependsOn: ["T271"]
- ledgerRefs: ["goals:G34"]

## M111

### T275 — planned

- createdAt: 2026-06-08T16:58:20.160Z
- updatedAt: 2026-06-08T17:35:38.841Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Define the typed AgentCatalogue data model + a browser-safe markdown parser
- description: "Create nix/pkg/cq-ledgers/packages/ledger-web/src/agentsCatalogue.ts defining the typed render model for the Agents tab (mirroring flowData.ts). An `AgentRole` interface with the Q148+goal fields: id, name, kind ('orchestrator'|'agent-subagent'), source path, description, expected INPUTS, OUTPUTS produced, input/output SCHEMA notes, prompt-template body (full markdown, folded by default in the UI), configured model class (frontier|fast|standard, or 'default'/'N/A' when non-configurable), per-harness model mappings ({claude?: token[], pi?: token[]}), AND the FOLLOW-UP fields (Q151-Q153): `privilege: 'RO'|'RW'` and `exposedTools` (the raw per-kind tool descriptor). Export `AGENT_ROLES: AgentRole[]` (re-export of the generated module). Define the SOURCE-OF-TRUTH CONVENTION: inputs/outputs/ioSchema come from a parseable `## Catalogue` fenced-yaml block authored per asset (T281); privilege + exposedTools are DERIVED MECHANICALLY from frontmatter (NOT authored), per Q151-Q153: — privilege: a SUBAGENT (agents/*.md) is 'RW' iff NONE of {Write,Edit,MultiEdit,NotebookEdit,Bash} appears in its `disallowedTools`, else 'RO'; a COMMAND (commands/cq/*.md) is 'RW' iff its `allowed-tools` lists a mutating tool (Write|Edit|Bash), else 'RO'. — exposedTools: RAW per-kind — subagents show `disallowedTools` (+ `isolation` when present), commands show `allowed-tools`, 'none declared' when the frontmatter key is absent. The pure `parseAgentMarkdown(raw)` extracts: real frontmatter keys for BOTH kinds — agents' name/description/disallowedTools/isolation AND commands' description/argument-hint/allowed-tools (EXTEND the parser to read command `allowed-tools` per Q152) — the `## Catalogue` block, and the prompt-template body. Keep the module node-free / browser-bundleable (no node:fs); file reading lives in the codegen script."
- acceptance: "From nix/pkg/cq-ledgers/: `bun run typecheck` green; agentsCatalogue.ts exports AgentRole (incl. privilege: 'RO'|'RW' + exposedTools) + AGENT_ROLES + a pure parseAgentMarkdown reading agent frontmatter (name/description/disallowedTools/isolation) AND command frontmatter (allowed-tools) + the `## Catalogue` block + body; no node:fs import; AND a unit test exercises parseAgentMarkdown on BOTH an agent fixture (deny-list) and a command fixture (allow-list) asserting it extracts the structured block, real frontmatter keys, and that the derived privilege is correct (e.g. an implement-worker-like deny-list => RW, a plan-reviewer-like deny-list => RO, a command with Write/Bash in allowed-tools => RW)."
- suggestedModel: frontier
- ledgerRefs: ["goals:G34"]

### T276 — planned

- createdAt: 2026-06-08T16:58:33.206Z
- updatedAt: 2026-06-08T17:35:47.732Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Write the codegen script that emits a COMMITTED generated catalogue module from cq-assets
- description: "Add a codegen script (nix/pkg/cq-ledgers/packages/ledger-web/scripts/gen-agents-catalogue.ts) wired as a `gen-agents` package.json script. It reads each Q148 role's source file (nix/pkg/cq-assets/agents/*.md + commands/cq/*.md) by repo-relative path, parses it with the T275 parseAgentMarkdown to extract the `## Catalogue` block (inputs/outputs/ioSchema) + real frontmatter (both kinds) + prompt-template body, derives the per-role model class from the COMMITTED cq.toml.example (NOT the gitignored live cq.toml) via [agent_tiers] + classifyToken ('default'/'N/A' when non-configurable), and DERIVES the follow-up fields per Q151-Q153: privilege ('RW' iff a subagent's disallowedTools omits all of Write/Edit/MultiEdit/NotebookEdit/Bash, or a command's allowed-tools contains Write/Edit/Bash; else 'RO') and exposedTools (raw per-kind: agents' disallowedTools+isolation; commands' allowed-tools; 'none declared' when absent). EMITS a committed TS module packages/ledger-web/src/agentsCatalogue.gen.ts exporting `AGENT_ROLES: AgentRole[]`. WHY-committed rationale in a HEADER CODE COMMENT (cq-assets is outside the ledger-web Nix closure; ledger-web's Nix build is a startup Bun.build over src/; the script runs at DEV time, never in the sandbox). Hard-fail on any role whose file is missing the `## Catalogue` block or is unparseable."
- acceptance: "From nix/pkg/cq-ledgers/: `bun run gen-agents` writes packages/ledger-web/src/agentsCatalogue.gen.ts; `bun run typecheck` green; AGENT_ROLES has one entry per Q148 role, each with non-empty description + inputs + outputs + ioSchema + prompt-template body + model-class field + a derived privilege ('RO'|'RW') + exposedTools; spot-check the derivation (implement-worker => RW, plan-reviewer => RO); re-running gen-agents is byte-deterministic. (committed==regenerated asserted by T277.)"
- suggestedModel: frontier
- dependsOn: ["T275","T281"]
- ledgerRefs: ["goals:G34"]

### T277 — planned

- createdAt: 2026-06-08T16:58:43.704Z
- updatedAt: 2026-06-08T16:58:43.704Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Add a generated-catalogue freshness/drift test (Q147 auto-sync guard)
- description: "Add nix/pkg/cq-ledgers/packages/ledger-web/test/agentsCatalogue.gen.test.ts that (a) imports AGENT_ROLES and asserts the full Q148 role set is present with the required structured fields populated; and (b) enforces FRESHNESS: re-run the codegen (in-memory, or shell out to the gen script into a temp path) and assert the COMMITTED agentsCatalogue.gen.ts matches the freshly-generated output — so a stale generated file (cq-assets or cq.toml.example changed but not regenerated) fails CI. This automates the sync Q147 chose codegen for (replacing the Flows-tab manual cross-check)."
- acceptance: "From nix/pkg/cq-ledgers/: `bun test packages/ledger-web/test/agentsCatalogue.gen.test.ts` green when the committed file is fresh; hand-editing the generated file (or a stale asset) makes the freshness assertion fail."
- suggestedModel: standard
- dependsOn: ["T276"]
- ledgerRefs: ["goals:G34"]

### T278 — planned

- createdAt: 2026-06-08T16:58:50.455Z
- updatedAt: 2026-06-08T17:36:08.224Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Add the Agents tab to HelpOverlay, rendering the generated catalogue with prompt templates folded by default
- description: "In nix/pkg/cq-ledgers/packages/ledger-web/src/App.tsx HelpOverlay: add an 'agents' member to the tab-state union; add a tab button (data-testid help-tab-agents, label \"Agents\") after the Flows tab; render an AgentsTab component that maps AGENT_ROLES (from agentsCatalogue.gen.ts) to a structured detail list (one section per role, data-testid help-agent-<id>) showing: name, kind, description, inputs, outputs, input/output schema, configured model class + per-harness mappings (or 'default'/'N/A'), the PRIVILEGE CLASS as an RO/RW badge (data-testid help-agent-<id>-privilege), the EXPOSED TOOLS descriptor (data-testid help-agent-<id>-tools; raw per-kind 'Disallowed: …'+isolation for subagents / 'Allowed: …' for commands / 'none declared'), and the PROMPT TEMPLATE inside a <details> COLLAPSED by default (no `open` attribute) with testid help-agent-<id>-prompt. Reuse the existing Markdown component for the body. Add lw-agent* CSS (incl. a privilege-badge style) in styles.css consistent with the existing help styling. Static data only (no MCP fetch), like FLOWS."
- acceptance: "From nix/pkg/cq-ledgers/: `bun run typecheck` green; the Agents tab renders one section per Q148 role, each showing the RO/RW privilege badge + the exposed-tools descriptor; the prompt-template <details> is collapsed by default. Verified by the W3 Agents-tab happy-dom test T279."
- suggestedModel: frontier
- dependsOn: ["T275","T276"]
- ledgerRefs: ["goals:G34"]

### T279 — planned

- createdAt: 2026-06-08T16:58:59.950Z
- updatedAt: 2026-06-08T17:36:12.481Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Add happy-dom tests for the Agents tab
- description: "Add a ledger-web happy-dom test (packages/ledger-web/test/) that opens the help overlay, clicks the Agents tab (help-tab-agents), and asserts: the full Q148 role set renders (each help-agent-<id> present — derive the expected set from imported AGENT_ROLES); each role shows description + inputs + outputs + model class; the PRIVILEGE badge (help-agent-<id>-privilege) shows the correct RO/RW for a sample RW role (implement-worker) and a sample RO role (plan-reviewer); the EXPOSED TOOLS descriptor (help-agent-<id>-tools) renders per-kind; and the prompt-template <details> (help-agent-<id>-prompt) is COLLAPSED by default, then expands on toggle. Use the existing in-memory help-test harness."
- acceptance: "From nix/pkg/cq-ledgers/: `bun test packages/ledger-web` green; the test fails if a Q148 role is missing, if a sample role's RO/RW privilege badge is wrong, or if the prompt template is not folded-by-default."
- suggestedModel: standard
- dependsOn: ["T278"]
- ledgerRefs: ["goals:G34"]

### T281 — planned

- createdAt: 2026-06-08T17:19:04.316Z
- updatedAt: 2026-06-08T17:36:01.154Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: Author the structured `## Catalogue` (inputs/outputs/ioSchema) block into every Q148 cq-assets agent + command file
- description: "Per R324/opus: the structured inputs/outputs/IO-schema fields the Agents tab shows MUST have a parseable source of truth so codegen stays in sync (Q147) and the freshness test (T277) guards them. Add the `## Catalogue` structured block (the T275 convention — fenced yaml with keys inputs, outputs, ioSchema) to EVERY role's source file: nix/pkg/cq-assets/agents/*.md (plan-advance incl candidate mode, plan-reviewer, implement-worker, implement-reviewer, implement-conflict-resolver, investigate-explorer, investigate-prober, plan-synthesizer/judge) AND the orchestrator commands/cq/*.md (cq:plan/investigate/implement :advance/:start/:follow-up + cq:advance). Fill each from the role's actual prose contract. NOTE (follow-up Q151-Q153): the `## Catalogue` block holds ONLY inputs/outputs/ioSchema — the privilege class (RO/RW) and exposedTools are DERIVED from existing frontmatter by codegen (NOT authored here), so this task does NOT add privilege/tools to the blocks; it only ensures the frontmatter the derivation reads is present/correct (agents already carry disallowedTools/isolation; commands carry allowed-tools — leave those as-is). Surgical: add ONLY the `## Catalogue` block; do not alter the existing prose/behavioural body."
- acceptance: "From repo root: every Q148 role file under nix/pkg/cq-assets/agents + nix/pkg/cq-assets/commands/cq has a `## Catalogue` block parseable by parseAgentMarkdown (T275); one per file; the existing behavioural prose bodies AND the existing tool frontmatter (disallowedTools/isolation/allowed-tools) are unchanged (git diff shows only added Catalogue blocks); the T275 parser extracts each block without error."
- suggestedModel: standard
- dependsOn: ["T275"]
- ledgerRefs: ["goals:G34"]

## M112

### T280 — planned

- createdAt: 2026-06-08T16:59:09.876Z
- updatedAt: 2026-06-08T17:19:30.664Z
- author: "opus-4.8[1m]"
- session: ae90ac43-977e-46cc-89a7-1814996d3f61
- headline: "Integration verification: regen catalogue + full check + nix build across touched products + drift gate"
- description: "Final cross-cutting gate. It runs LAST by construction: its milestone M112 dependsOn M109+M110+M111, so implement-flow makes T280 ready ONLY once every W1/W2/W3 task is terminal — it can never pass against an incomplete tree. From nix/pkg/cq-ledgers/: run `bun run gen-agents` then `bun run check` (typecheck + lint + bun test) — all green; confirm no drift (`git diff --quiet -- packages/ledger-web/src/agentsCatalogue.gen.ts` after regen). From repo root: `nix build .#ledger-web` AND `nix build .#ledger-mcp` (cq-config changed) green; spot-check `.#ledger-tui` only if T272's audit actually touched a tui consumer. Catches cross-milestone interactions (Agents tab + rename both edit HelpOverlay; the catalogue consumes the inverted [tiers] classifier + the `## Catalogue` asset blocks). Verification/fixup only — no new feature code."
- acceptance: "`bun run gen-agents && bun run check` exits 0 (from nix/pkg/cq-ledgers/); `nix build .#ledger-web` and `nix build .#ledger-mcp` exit 0 (from repo root); re-running gen-agents leaves the working tree clean (no drift on agentsCatalogue.gen.ts)."
- suggestedModel: standard
- dependsOn: ["T269","T272","T273","T274","T277","T279","T281"]
- ledgerRefs: ["goals:G34"]
