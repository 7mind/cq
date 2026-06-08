---
ledger: tasks
counters:
  milestone: 0
  item: 257
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
---

# tasks

## M90

### T225 — done

- createdAt: 2026-06-07T19:39:58.938Z
- updatedAt: 2026-06-07T23:18:19.654Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: Wire tier resolution into the dispatch extension and integrate it into the pi harness
- description: "Connect the two halves and confirm they load together. Teach the dispatch extension (T224) to resolve the child session's model from the DISPATCHED AGENT'S NAME via the cq.toml maps (T223): agent NAME -> tier (via [agent_tiers]) -> concrete provider+model (via [tiers]). The per-agent tier SOURCE is the cq.toml [agent_tiers] table keyed by agent name, NOT agent markdown frontmatter (which stays byte-identical per Q126/K44). Resolution precedence: an explicit model the orchestrator passes at dispatch wins; else the agent's tier via [agent_tiers]->[tiers]; else (agent unlisted, or no [tiers]/[agent_tiers] table) fall back to the parent Pi session's active model (documented default). The extension reads cq.toml using the runtime config-access strategy PINNED in T228 (e.g. parse cq.toml at the project root via the agreed env var). Confirm the new extension + the projected agents dir (T222) + the [tiers]/[agent_tiers] tables all load together under the wrapped pi harness."
- acceptance: "Concrete, observable: (1) tiered resolution — dispatch two agents whose NAMES map to DIFFERENT tiers via [agent_tiers] (e.g. investigate-explorer -> frontier vs a fast-tier agent), launching pi from the repo root, and confirm from the captured pi session/provider log that each child session opened against the provider+model that [tiers] maps that agent's tier to (assert the two child models differ and match the table); (2) explicit-override — a dispatch passing an explicit model uses it regardless of tier (observable in the provider log); (3) fallback — with [tiers]/[agent_tiers] ABSENT (or the agent unlisted), the child falls back to the parent's active model WITHOUT error; (4) integrated load — `nix build`/eval of dev-llm succeeds and launching piWrapped (cwd = repo root) starts cleanly with extension + agents dir + tiers all wired (no load errors in the startup transcript). Capture mechanism: pi session/provider transcript + the dispatch invocations used."
- suggestedModel: standard
- dependsOn: ["T224","T223"]
- ledgerRefs: ["goals:G28"]
- blockedBy: ["Q131"]
- resultCommit: 846a0a8
- completion: "Tier resolution wired into cq-subagent-dispatch.ts: inlined flat-table TOML reader + resolver (mirrors @cq/config; copied per K46, no import) reads cq.toml via $CQ_CONFIG; child model = explicit-arg > agent-name tier ([agent_tiers]→[tiers]) > parent active model; pi:<provider>/<model> & pi:<model> token mapping; claude:/absent→parent fallback. LIVE: investigate-explorer→frontier→grok-build vs investigate-prober→fast→ollama-cloud/minimax-m3 (different child models per [tiers]); override + 3 fallbacks verified; tsc strict clean. Merged. Out-of-scope provider-ambiguity → D36."
- sessionLogs: ["docs/logs/20260607-230442-a54aba4d897e853d3.md","docs/logs/20260607-231649-T225-reviews.md"]

### T229 — done

- createdAt: 2026-06-07T20:08:40.376Z
- updatedAt: 2026-06-07T23:18:19.697Z
- author: "opus-4.8[1m]"
- session: 994b02a0-7e3f-40df-81ed-b12b9ce6b13e
- headline: Author the harness-agnostic dispatch-trigger instruction in the Pi-side context asset
- description: |
    Close R266's COMPLETENESS gap: per decision K44 the UNCHANGED cq command prompts fire the Pi dispatch tool either because the registered tool's call shape matches the prompts' existing named-agent+task wording (T224's PRIMARY trigger) AND/OR because a harness-agnostic dispatch INSTRUCTION lives in a Pi-SIDE asset (K44's PERMITTED SUPPLEMENT). No current task AUTHORS or VERIFIES that Pi-side instruction — T224 only REGISTERS the tool, and T226/T227 merely ASSUME the unchanged prompt makes the Pi model emit a dispatch CALL rather than prose. This task authors that missing trigger.
    
    WHAT TO DO: add a harness-agnostic dispatch instruction to a PI-SIDE context asset — append to nix/pkg/llm-contexts/pi-context.md (which dev-llm.nix wires as programs.pi.appendSystemPrompt; a Pi-ONLY asset, NOT a cq command prompt, so it honors Q126/K44) telling the Pi model HOW to map the shared prompts' named-agent+task convention (an agent name + a task [+ optional isolation:"worktree"]) onto the registered dispatch tool (T224) — i.e. 'when a cq command instructs you to dispatch/launch a named subagent with a task, CALL the dispatch tool with {agent, task[, isolation]} rather than answering in prose; you cannot re-dispatch from within a child.' Reuse the exact tool name + arg shape T224 registers. Do NOT edit any file under nix/pkg/cq-assets (commands/agents/skills) and do NOT edit the Claude/Codex wiring — only the Pi-side asset (+ any programs.pi appendSystemPrompt wiring in nix/hm/dev-llm.nix needed to deliver it). This is the trigger half K44 names; it depends on T224 (the tool + its exact name/arg shape must exist to instruct against) and is a PREREQUISITE of the T226/T227 end-to-end demos (which assert an unchanged prompt actually fires the tool).
- acceptance: "Observable, end-to-end: launching piWrapped (cwd = repo root) and running an UNCHANGED cq command prompt (the same kind T226/T227 drive) results in the Pi model FIRING the dispatch tool (a tool call visible in the captured pi transcript) rather than emitting prose describing the dispatch — i.e. the Pi-side instruction demonstrably converts the prompts' named-agent+task wording into an actual dispatch tool call. `git diff` asserts nix/pkg/cq-assets is UNTOUCHED (the trigger lives only in the Pi-side asset); the only changed files are nix/pkg/llm-contexts/pi-context.md (+ any programs.pi appendSystemPrompt wiring in nix/hm/dev-llm.nix). nix build/eval of dev-llm succeeds with the appended context."
- suggestedModel: frontier
- dependsOn: ["T224"]
- ledgerRefs: ["goals:G28"]
- blockedBy: ["Q131"]
- resultCommit: cc2f326
- completion: "Appended a 'Dispatching cq subagents' section to the Pi-side asset pi-context.md (already wired as programs.pi.appendSystemPrompt) mapping the shared cq named-agent+task convention onto the T224 dispatch_agent tool {agent,task,isolation?}. LIVE: an UNCHANGED cq-style instruction fired a real dispatch_agent toolCall + child execution (not prose); misfire probe ('you ARE the agent') → 0 dispatches. Only pi-context.md changed; cq-assets + dev-llm.nix untouched; bun run check green 1038/0. Merged."
- sessionLogs: ["docs/logs/20260607-230442-a995278432781c6d1.md","docs/logs/20260607-231649-T229-reviews.md"]

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

## M97

### T245 — done

- createdAt: 2026-06-08T08:34:47.098Z
- updatedAt: 2026-06-08T09:38:09.830Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add user-action-required to HANDOFFS_SCHEMA in constants.ts
- description: "In nix/pkg/cq-ledgers/packages/ledger/src/constants.ts (HANDOFFS_SCHEMA, ~L341-361) add the literal token `user-action-required` (kebab-case, Q137) in exactly three places, consistently: (a) statusValues (currently [drained, answers-required, mixed, illness-detected]); (b) terminalStatuses (it is TERMINAL per Q137); (c) the transitions map as `\"user-action-required\": []` (empty, mirroring the other four). Do NOT add any new schema field (Q140 — the required action is carried in the existing handoffReasons[]). idPrefix HO unchanged. Update the adjacent doc-comment if it enumerates the status set."
- acceptance: "constants.ts HANDOFFS_SCHEMA shows the literal `user-action-required` added in ALL THREE places — (a) statusValues, (b) terminalStatuses, (c) a `\"user-action-required\": []` transitions entry — with the other four tokens unchanged and NO new field added to HANDOFFS_SCHEMA.fields. Independently verifiable by reading the file (not deferred to T255); `bun run typecheck` (tsc -b) from nix/pkg/cq-ledgers passes."
- suggestedModel: standard
- ledgerRefs: ["goals:G30"]
- resultCommit: a2d2359d034ebda57807552c0519bb2154a723ee
- completion: "Added user-action-required as the 5th terminal status in HANDOFFS_SCHEMA (statusValues + terminalStatuses + transitions []) + JSDoc + test count 4->5. bun run check green 1038/0."
- sessionLogs: ["docs/logs/20260608-093215-a87723c693b9e8f2a.md","docs/logs/20260608-093215-ac9dd78a27033f3ce.md"]

## M98

### T246 — planned

- createdAt: 2026-06-08T08:34:57.189Z
- updatedAt: 2026-06-08T08:49:35.588Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "OPERATIONAL: in-place migrate the live (gitignored) docs/ledgers.yaml handoffs schema block on the MAIN checkout"
- description: "Per Q141 (USER OVERRIDE — edit in place, do NOT backup-and-reinit). This is an OPERATIONAL step performed on the MAIN checkout, NOT a worktree code task: docs/ledgers.yaml is GITIGNORED (the per-cwd runtime registry), so a worktree edit would produce no committed diff and could not merge back. The orchestrator (or the implement flow, on the main checkout after T245 lands) edits the docs/ledgers.yaml handoffs block IN PLACE — add `user-action-required` to statusValues AND terminalStatuses AND a `user-action-required: []` transitions entry, byte-matching the canonical T245 shape — so FsLedgerStore.init() sees NO divergence and does NOT backup-reinit this repo's live handoffs ledger. Confirmed grounding: the live schema sidecar is docs/ledgers.yaml (handoffs block ~L429-471); the TRACKED docs/handoffs.md holds only counters/archives (HO18–HO25 preserved by construction). The COMMITTED Q141 deliverables are T245 (constants.ts) + T247 (CI fixture records-survive test); THIS task produces no committed artifact (gitignored). After editing, run the store init path and confirm no docs/.backup/<ts>/ is created and the live handoffs ledger still lists HO18–HO25."
- acceptance: "On the main checkout, docs/ledgers.yaml handoffs block lists `user-action-required` in statusValues + terminalStatuses + a `user-action-required: []` transitions entry (token byte-identical to constants.ts); running init() creates NO docs/.backup/<ts>/ and does NOT empty the handoffs ledger; docs/handoffs.md counter still 25 and HO18–HO25 unchanged. No committed diff is expected (ledgers.yaml gitignored); the verification output is captured. (Records-survival is ALSO covered by the committed CI test T247.)"
- suggestedModel: standard
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]

### T247 — done

- createdAt: 2026-06-08T08:35:02.973Z
- updatedAt: 2026-06-08T10:19:34.123Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add a fixture-based test asserting HO records survive the additive schema widening
- description: "Per Q141's explicit requirement to verify records survive. Add a COMMITTED, CI-runnable test (under nix/pkg/cq-ledgers/packages/ledger/test/, alongside the existing schema-divergence/init suite) that: seeds a TEMP store (temp dirs/fixtures, NOT the repo's live docs/) whose on-disk handoffs ledger + registry already carry the widened statusValues (the additive shape), runs FsLedgerStore.init() against the NEW canonical HANDOFFS_SCHEMA (from T245), and asserts (a) NO backup-reinit fired (no backup dir created, handoffs ledger NOT reset to fresh-canonical) and (b) a pre-seeded HO record is still readable post-init. This test depends ONLY on the committed T245 constants.ts change so it runs in CI; it must NOT depend on the local gitignored docs/ledgers.yaml edit (that live runtime migration is the separate operational step T246). This is the committed regression guard that an additive statusValue does not destroy live handoff history."
- acceptance: New test runs under `bun test` and passes using temp fixtures (no dependence on the live docs/ledgers.yaml); it FAILS if init() reinitializes/empties the handoffs ledger or creates a backup dir for the additive statusValue, and asserts a pre-seeded HO record is present after init().
- suggestedModel: frontier
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 3f64515
- completion: Added committed CI regression test (handoffs-additive-widening-init.test.ts) proving an additive HANDOFFS_SCHEMA statusValue preserves HO history (no backup-reinit; HO1 survives). Teeth empirically verified.
- sessionLogs: ["docs/logs/20260608-101505-ae7059ac1de10074a.md","docs/logs/20260608-101505-abfc87a49b1c437a7.md"]

## M99

### T248 — done

- createdAt: 2026-06-08T08:35:12.398Z
- updatedAt: 2026-06-08T09:56:15.627Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add user-action-required to the WARNING set in ledger-tui status.ts
- description: "Per Q142: in nix/pkg/cq-ledgers/packages/ledger-tui/src/status.ts, add `user-action-required` to the terminal-status WARNING set (~L28) so statusBucket() returns 'warning' (magenta) for the new terminal status instead of falling through to green 'done'. Change ONLY the WARNING set; leave the other four handoff statuses (drained/answers-required/mixed/illness-detected) and all other buckets unchanged (Q142 scope)."
- acceptance: ledger-tui status.ts WARNING set contains `user-action-required`; statusBucket('user-action-required', HANDOFFS_SCHEMA) returns 'warning' (magenta); no other status's bucket changes; `bun run typecheck` passes.
- suggestedModel: fast
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: f5ba9d2
- completion: ledger-tui status.ts WARNING set gains user-action-required → 'warning' (magenta) bucket.
- sessionLogs: ["docs/logs/20260608-095457-a4bd5b603bd673065.md"]

### T249 — done

- createdAt: 2026-06-08T08:35:17.115Z
- updatedAt: 2026-06-08T09:56:18.486Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add user-action-required to the WARNING set in ledger-web status.ts (mirror)
- description: "Per Q142: in nix/pkg/cq-ledgers/packages/ledger-web/src/status.ts (mirror of the TUI helper), add `user-action-required` to the terminal-status WARNING set so statusBucket() maps it to 'warning' → `lw-status-warning` CSS class (amber), not green 'done'. Keep the two status.ts files' bucket logic mirrored/in-sync. Leave the other four handoff statuses unchanged."
- acceptance: ledger-web status.ts WARNING set contains `user-action-required`; statusBucket('user-action-required', HANDOFFS_SCHEMA) returns 'warning' (→ lw-status-warning / amber); the two status.ts WARNING sets are in sync; no other status's bucket changes; `bun run typecheck` passes.
- suggestedModel: fast
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 54bbf1a
- completion: ledger-web status.ts WARNING set gains user-action-required → 'warning' (lw-status-warning/amber) bucket; mirrored with tui.
- sessionLogs: ["docs/logs/20260608-095457-a3551001d3e2a1d51.md"]

### T250 — done

- createdAt: 2026-06-08T08:35:22.257Z
- updatedAt: 2026-06-08T10:19:37.848Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add TUI + web render tests asserting user-action-required renders warning (not green)
- description: "Add render/bucket tests (under the respective package test dirs) asserting a handoffs item with status `user-action-required` renders in the warning bucket and NOT done/green: (a) TUI — statusBucket/statusColor returns 'warning'/'magenta' for `user-action-required` against HANDOFFS_SCHEMA (plus a badge/DagView render assertion where the suite already does this for other statuses); (b) web — statusBucket returns 'warning' and the badge carries `lw-status-warning` (amber), not `lw-status-done` (use uncontrolled inputs/refs per repo happy-dom convention if a component is rendered). These tests MUST FAIL if either WARNING-set edit (T248/T249) is reverted."
- acceptance: "Under `bun test`, new TUI and web tests POSITIVELY assert that for status `user-action-required`: (TUI) statusBucket returns 'warning' and statusColor returns 'magenta'; (web) statusBucket returns 'warning' and the badge carries the `lw-status-warning` (amber) class. Each test ALSO asserts the other four handoff statuses' buckets are unchanged (still their existing buckets). Reverting either WARNING-set addition (T248/T249) makes the corresponding test fail (observed 'done'/green)."
- suggestedModel: standard
- dependsOn: ["T248","T249"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 4002bd1
- completion: Added TUI + web render tests positively asserting user-action-required → warning bucket/magenta/lw-status-warning + the other four unchanged; teeth verified (revert WARNING → failures).
- sessionLogs: ["docs/logs/20260608-101505-ab03157bbe6b9f9a1.md","docs/logs/20260608-101505-ad88475efbcad5520.md"]

## M100

### T251 — done

- createdAt: 2026-06-08T08:35:37.823Z
- updatedAt: 2026-06-08T09:56:21.715Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Full treatment of user-action-required in cq/advance.md (status table + stop-condition prose)
- description: "In nix/pkg/cq-assets/commands/cq/advance.md give the new status the full treatment per Q138/Q139: (1) the §Provenance 'one write' status table (~L60-66) gains a row mapping the user-action classification → handoff status `user-action-required`; update adjacent prose that says 'all four statuses terminal' to reflect five. (2) §End-of-run report: add the user-action classification as a legal end-of-run outcome alongside DRAINED/BLOCKED-ON-QUESTIONS/MIXED (and note co-occurrence with an open-question block + landed work → `mixed` with handoffReasons listing both, e.g. [drained, answers-required, user-action-required], Q139). (3) §Stop-condition gate (~L253-325): make `user-action-required` a LEGAL stop, NARROWLY pinned per Q138 — permitted ONLY when a SPECIFIC NAMED item's next physical step is exclusively the user's (re-activate an environment, provision a credential/secret, run a privileged/external command the agent cannot run) AND every autonomous step is already done; the agent MUST name the EXACT user command/action AND the EXACT item it unblocks (like D37's `home-manager switch`). Enumerate the forbidden look-alikes — magnitude/proportion/scope/disposition/'natural stopping point'/'remaining fix disproportionate' are NEVER user-action-required — mirroring the existing anti-laundering prose, and WITHOUT weakening the 'There is deliberately NO handoff status for an effort-based stop' gate. Distinguish it explicitly from answers-required (strictly open-question-gated; user-action-required involves NO questions item). Add it to the gate's enumeration of legal handoff statuses with its specific predicate condition."
- acceptance: advance.md status table contains a `user-action-required` row; the §End-of-run report lists the user-action outcome + the mixed/handoffReasons composition note; the §Stop-condition gate names the narrow trigger (specific item + exact user command + all autonomous steps done), enumerates magnitude/proportion/scope/disposition/natural-stopping-point as explicitly NOT user-action-required, keeps the no-effort-stop gate intact, distinguishes it from answers-required, and includes it in the legal-status list. The token `user-action-required` appears verbatim in advance.md.
- suggestedModel: frontier
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 331c49b
- completion: advance.md threads user-action-required through the §Provenance status table, §End-of-run report (BLOCKED-ON-USER-ACTION + mixed composition), and §Stop-condition gate (narrow legal stop + anti-laundering, no-effort-gate intact, distinct from answers-required).
- sessionLogs: ["docs/logs/20260608-095457-a1234ac8ea9a07864.md","docs/logs/20260608-095457-a7996c3617e26840c.md"]

### T252 — done

- createdAt: 2026-06-08T08:35:42.984Z
- updatedAt: 2026-06-08T10:19:40.331Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add user-action-required row to the plan/advance.md handoff status-table
- description: "In nix/pkg/cq-assets/commands/cq/plan/advance.md, the §Handoff-record (STANDALONE) status-table (~L563-568) maps this round's stop to a handoff status. Add a row for the user-action case → `user-action-required`, with the SAME narrow-pinning language as advance.md (Q138) and the distinction from answers-required (a user ACTION the planner cannot perform, not an open-question answer; Q139); note co-occurrence with an open question → `mixed` with both in handoffReasons. Keep the field-set prose consistent (action carried in handoffReasons[] + ledgerRefs + summary per Q140; no new field)."
- acceptance: "plan/advance.md §Handoff-record status-table contains a row mapping the user-action case -> `user-action-required` (token verbatim); the surrounding prose carries the narrow-pinning trigger (specific named item + exact user command + all autonomous steps done), the distinction from answers-required (a user ACTION not an open-question answer), and the co-occurrence -> `mixed` with handoffReasons listing both (Q138/Q139); the field-set prose references handoffReasons[] as the action carrier (no new schema field, Q140)."
- suggestedModel: standard
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 9e06a5a
- completion: plan/advance.md §Handoff-record table gains the user-action-required row + narrow-pinning/distinct/mixed prose.
- sessionLogs: ["docs/logs/20260608-101505-ab61d341a6ea0e8d3.md"]

### T253 — done

- createdAt: 2026-06-08T08:35:46.822Z
- updatedAt: 2026-06-08T10:19:42.564Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add user-action-required row to the investigate/advance.md handoff status-table
- description: In nix/pkg/cq-assets/commands/cq/investigate/advance.md, the §Handoff-record (STANDALONE) status-table (~L355-360) maps this round's stop to a handoff status. Add a row for the user-action case → `user-action-required`, with the SAME narrow-pinning language (Q138; e.g. the motivating D37 `home-manager switch`) and the distinction from answers-required (Q139; co-occurrence → `mixed` listing both in handoffReasons). Keep the field-set prose consistent with Q140 (no new field).
- acceptance: "investigate/advance.md §Handoff-record status-table contains a row mapping the user-action case -> `user-action-required` (token verbatim); the surrounding prose carries the narrow-pinning trigger (e.g. the motivating D37 `home-manager switch`), the distinction from answers-required, and the co-occurrence -> `mixed` with handoffReasons listing both (Q138/Q139); field-set prose references handoffReasons[] as the action carrier (no new schema field, Q140)."
- suggestedModel: standard
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 5f611aa
- completion: investigate/advance.md §Handoff-record table gains the user-action-required row + narrow-pinning (D37 example)/distinct/mixed prose.
- sessionLogs: ["docs/logs/20260608-101505-a382abfe0e3b578cd.md"]

### T254 — done

- createdAt: 2026-06-08T08:35:54.467Z
- updatedAt: 2026-06-08T10:19:44.834Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add user-action-required row to the implement/advance.md handoff status-table
- description: "In nix/pkg/cq-assets/commands/cq/implement/advance.md, the §Handoff-record (STANDALONE) status-table (~L422-427) maps this pass's stop to a handoff status. Add a row for the user-action case → `user-action-required`, with the SAME narrow-pinning language (Q138; a specific task whose next physical step is exclusively the user's — provision a credential, re-activate an environment, run a privileged external command — all autonomous steps done) and the distinction from answers-required (Q139; co-occurrence → `mixed` with both in handoffReasons). Keep field-set prose consistent with Q140 (action in handoffReasons[] + ledgerRefs + summary; no new field)."
- acceptance: "implement/advance.md §Handoff-record status-table contains a row mapping the user-action case -> `user-action-required` (token verbatim); the surrounding prose carries the narrow-pinning trigger (a specific task whose next physical step is exclusively the user's, all autonomous steps done), the distinction from answers-required, and the co-occurrence -> `mixed` with handoffReasons listing both (Q138/Q139); field-set prose references handoffReasons[] as the action carrier (no new schema field, Q140)."
- suggestedModel: standard
- dependsOn: ["T245"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 1c02178
- completion: implement/advance.md §Handoff-record table gains the user-action-required row + narrow-pinning/distinct/mixed prose (untouched the §3c off-enum section).
- sessionLogs: ["docs/logs/20260608-101505-ade34c4ec89fbe878.md"]

## M101

### T255 — done

- createdAt: 2026-06-08T08:36:01.045Z
- updatedAt: 2026-06-08T10:30:53.016Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: Add HANDOFFS_SCHEMA unit test + four-table grep-invariant test
- description: "Per Q142 acceptance gates (a) + (b). (1) Schema unit test (under nix/pkg/cq-ledgers/packages/ledger/test/, where the existing HANDOFFS_SCHEMA tests live): assert HANDOFFS_SCHEMA includes `user-action-required` in statusValues AND terminalStatuses AND has a `user-action-required: []` transitions entry, and that isTerminal reports it terminal; the other four tokens still pass their existing assertions. (2) Grep-invariant test: assert ALL FOUR prompt status-tables — nix/pkg/cq-assets/commands/cq/{advance.md, plan/advance.md, investigate/advance.md, implement/advance.md} — contain the literal token `user-action-required` (read each file, assert presence) so a future prompt edit dropping the token fails. cq-assets is eval-time-only (no per-file build target), so this grep test is the substantive guard for prompt threading."
- acceptance: Under `bun test`, the new schema unit test + the four-table grep-invariant test pass; the schema test would have failed before T245; the grep test fails if any of the four prompt files lacks `user-action-required`.
- suggestedModel: standard
- dependsOn: ["T245","T251","T252","T253","T254"]
- ledgerRefs: ["goals:G30"]
- resultCommit: 3c08b66
- completion: Added HANDOFFS_SCHEMA unit test (user-action-required in all 3 places + terminal) + four-table grep-invariant (reads the 4 real prompt files; teeth verified). check green.
- sessionLogs: ["docs/logs/20260608-112600-adbcf1b71a34162e5.md","docs/logs/20260608-112600-a06721d01c0ecd25d.md"]

### T256 — done

- createdAt: 2026-06-08T08:36:06.880Z
- updatedAt: 2026-06-08T10:31:41.040Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "Verify: bun run check + scoped nix build green"
- description: Final verification gate. From nix/pkg/cq-ledgers/ run `bun run check` (tsc -b + eslint . + bun test) and confirm exit 0 with all new tests (schema unit, grep-invariant, records-survive, TUI/web render) green and no regressions — the substantive guard. Then from the REPO ROOT run `nix build .#llm-contexts .#llm-context-with-env .#llm-skills` (the buildable attrs that exercise the cq-assets prompts + the edited llm-contexts; cq-assets is eval-time-only with no per-file target) and confirm each exits 0. Capture all outputs. If any check/build fails, fix the cause before this task is done.
- acceptance: "`bun run check` (from nix/pkg/cq-ledgers/) exits 0 with captured output (all new + existing tests green); `nix build .#llm-contexts .#llm-context-with-env .#llm-skills` (from repo root) each exit 0 with captured output; both quoted in the completion."
- suggestedModel: standard
- dependsOn: ["T247","T250","T255"]
- ledgerRefs: ["goals:G30"]
- completion: "G30 verify gate PASSED (orchestrator-run on integrated main): bun run check 1071/1/0 (all new tests green); nix build .#llm-contexts .#llm-context-with-env .#llm-skills exit 0. No code diff."
