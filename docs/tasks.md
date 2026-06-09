---
ledger: tasks
counters:
  milestone: 0
  item: 345
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
---

# tasks

## M137

### T332 — done

- createdAt: 2026-06-09T19:08:24.319Z
- updatedAt: 2026-06-09T20:00:57.778Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Underline activatable node names in DiagramSvg
- description: "In nix/pkg/cq-ledgers/packages/ledger-web/src/DiagramSvg.tsx, give the <text> label of each activatable node (the branch where `activatable === true`: node has agentId AND onActivateAgent supplied) a visible clickability affordance: add `textDecoration: 'underline'` (cursor:pointer already on the <g>). Non-activatable nodes' labels stay un-decorated. Apply via a style/prop on the existing <text> element keyed off the same `activatable` boolean computed for interactiveProps; do not change layout or testids. Applies across all flows."
- acceptance: A happy-dom test renders a flow model with at least one agentId-bearing node and one plain node, passes onActivateAgent, and asserts the activatable node's label <text> has text-decoration underline while the plain node's does not. `bun test` passes.
- suggestedModel: standard
- ledgerRefs: ["goals:G41"]
- resultCommit: 3f14794453b8434e77174edd3b553b55f5c935d3
- completion: Underline on activatable DiagramSvg node labels (gated on the existing activatable boolean) + happy-dom test; bun run check green.
- sessionLogs: ["docs/logs/20260609-195301-a980130128544a7a0.md","docs/logs/20260609-195301-a419a03c786bd7181.md"]

### T333 — done

- createdAt: 2026-06-09T19:08:29.519Z
- updatedAt: 2026-06-09T20:20:34.554Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Render terminal (no-outgoing-edge) flow nodes as visually distinct
- description: "Terminal-action nodes (role nodes with NO outgoing edges in a flow) must look distinct (Q187: no rounding). DiagramSvg already keys rounding on `n.terminal` (RX_TERMINAL=4 vs RX_NORMAL=14, thicker stroke) and diagramLayout.ts already threads `terminal` through. CONCRETE DERIVATION SITE: in packages/ledger-web/src/roleActions.ts, at the point each RoleFlowDefinition is built, compute per node whether it has zero outgoing edges in THAT flow's `edges` array and set `terminal: true` on those RoleNodes (a small pure post-processing pass over each flow's node+edge lists, co-located with the ROLE_FLOWS definitions). If the RoleNode type does not already carry `terminal?: boolean`, add it there; confirm layoutDiagram in diagramLayout.ts forwards it to DiagramNode (it already does per T326/T329 — verify, no change expected). Apply across ALL four flows (plan/investigate/implement/advance). No DiagramSvg change beyond consuming the already-supported `n.terminal`."
- acceptance: "A test over ROLE_FLOWS asserts for each flow: every node with zero outgoing edges has terminal===true, every node with ≥1 outgoing edge has terminal!==true. A DiagramSvg render test asserts a terminal node's rect uses rx=4 and a non-terminal node's rect uses rx=14. `bun test` passes."
- suggestedModel: standard
- ledgerRefs: ["goals:G41"]
- resultCommit: 18d73dc121485250bc1e73e294ad410f98ac1052
- completion: "withTerminalNodes() derives terminal:true on zero-outgoing-edge nodes across all 4 ROLE_FLOWS; DiagramSvg renders rx=4 (terminal) vs rx=14; tests + bun run check green."
- sessionLogs: ["docs/logs/20260609-201031-a656a0bfa3e0b268f.md","docs/logs/20260609-201031-a360ee5576a9deb33.md"]

### T334 — wip

- createdAt: 2026-06-09T19:08:42.468Z
- updatedAt: 2026-06-09T20:21:24.424Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Make parallel/duplicate flow edges render with distinct visible labels
- description: "REVISED (R399): the defect is a RENDERING fault, NOT missing data. CONFIRMED: all 45 ROLE_FLOWS edges in packages/ledger-web/src/roleActions.ts ALREADY carry a non-empty `label`, and DiagramSvg already renders one label per edge by index. The user's symptom ('Implement flow — 2 arrows orchestrator→ledger, 3 orchestrator→worktree with no labels') is that PARALLEL edges between the same node pair render their labels OVERLAPPING / on top of each other (and feedback edges similarly), so they read as unlabelled. FIRST reproduce: add a layout/render test that lays out a flow with parallel same-pair edges (the implement flow) and asserts each parallel edge's label is placed at a DISTINCT, non-overlapping position (distinct labelPos / y-offset) — confirm it currently FAILS (labels coincide). THEN fix the layout/render path (diagramLayout.ts elk edge routing + per-index labelPos in DiagramSvg) so parallel edges are routed/offset and their labels placed distinctly and visibly. SEPARATELY, audit the label TEXT for the parallel implement-flow edges so each names its DISTINCT trigger/action (orchestrator→ledger: 'create milestone' vs 'update item status / append scope'; orchestrator→worktree: 'dispatch implement-worker' vs 'merge task by SHA + tear down worktree' vs 'dispatch implement-reviewer' — verify against commands/cq/implement/advance.md) and collapse ONLY genuinely-identical edges. Record the PROPOSED final label set in a concrete deliverable for user review: a new docs/drafts/<ts>-flows-edge-labels.md note (NOT a 'planDoc' — that artifact does not exist)."
- acceptance: (1) A reproduce-first layout test asserts each parallel same-pair edge in the implement flow gets a DISTINCT label position (no two coincide) — fails before the fix, passes after. (2) A render test confirms the implement flow's previously-overlapping parallel-edge labels are all visible/non-overlapping in the SVG. (3) A data test asserts every ROLE_FLOWS edge has a non-empty label and parallel edges on a node pair have distinct label strings. (4) The proposed final label set is written to docs/drafts/<ts>-flows-edge-labels.md for user review. `bun run lint` + `bun test` pass.
- suggestedModel: standard
- ledgerRefs: ["goals:G41"]

## M138

### T335 — done

- createdAt: 2026-06-09T19:08:49.874Z
- updatedAt: 2026-06-09T20:01:01.082Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Add the `ideas` ledger schema to CANONICAL_LEDGERS
- description: "In nix/pkg/cq-ledgers/packages/ledger/src/constants.ts add IDEAS_LEDGER='ideas' and IDEAS_SCHEMA: idPrefix 'I' (verified FREE against M/D/T/H/Q/K/G/R/HO), fields { title:{string,required:true}, description:{string,required:false} } (Q188). statusValues ['open','planned','discarded','postponed']. DECIDED (R399, no longer provisional): terminalStatuses = ['planned','discarded'] — `planned` IS terminal because the consume-an-idea flow moves a consumed idea to 'planned' when its goal is seeded and it must STAY there; `discarded` is terminal; `postponed` is NON-terminal and returns to open per Q188; `open` is non-terminal. transitions: open→[planned,discarded,postponed]; postponed→[open,planned,discarded]; planned→[]; discarded→[]. Append { name: IDEAS_LEDGER, schema: IDEAS_SCHEMA } to CANONICAL_LEDGERS so bootstrap/`cq init` provisions it. RECONCILE 'no milestones' with the milestone-attachment model: ideas items attach to the immortal bootstrap milestone M-AMBIENT (MILESTONES_AMBIENT_ID) and render as a flat list (like goals via T83) — no per-idea milestone; document this in the schema doc-comment."
- acceptance: "A ledger unit test bootstraps a fresh FsLedgerStore, asserts the `ideas` ledger exists with the expected schema (statusValues + terminalStatuses=['planned','discarded']), creates an idea under M-AMBIENT with title+description and status open, exercises open→postponed→open and open→planned, and asserts illegal transitions (planned→open, discarded→open) throw. ALSO (R399-round2/codex #3 — the 'no milestones' Q188 requirement): assert ideas carry NO user-milestone association — a created idea attaches ONLY to the ambient M-AMBIENT (not any user milestone), the schema declares no required milestone field beyond the ambient attachment, and ideas are enumerable/rendered as a FLAT list (never grouped under a user milestone). `bun test` passes."
- suggestedModel: frontier
- ledgerRefs: ["goals:G41"]
- resultCommit: 9feb68381abac58398ddddd04caabd148a68592c
- completion: ideas ledger schema (idPrefix I, title+description, open|planned|discarded|postponed, postponed→open) in CANONICAL_LEDGERS + ledgers.yaml regen + lifecycle/illegal-transition/flat-attachment tests; bun run check green.
- sessionLogs: ["docs/logs/20260609-195301-af0e8528968c08a21.md","docs/logs/20260609-195301-a9c0789cc58edc22e.md"]

### T339 — done

- createdAt: 2026-06-09T19:09:28.422Z
- updatedAt: 2026-06-09T20:20:38.782Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Surface the Ideas ledger in ledger-web with an 'Ideas' sidebar button above Goals
- description: "In nix/pkg/cq-ledgers/packages/ledger-web/src/App.tsx add an `ideas` entry to SIDEBAR_GROUPS as a NEW group placed immediately ABOVE ['goals','milestones'] (Q188: Ideas button above Goals). Define an IDEAS_LEDGER const. Ideas render as a FLAT list (no milestone subsections) like goals (T83) — reuse the goals flat-list path / ItemTable; the generic detail panel edits title/description/status through updateItem. Ensure the sidebar group divider logic still renders correctly with the new non-empty group. Pure MCP client — no direct ledger-file reads. TUI gets the Ideas ledger automatically (it lists all canonical ledgers); no special TUI work required."
- acceptance: A happy-dom App test with a fake client exposing an `ideas` ledger asserts the `ledger-ideas` sidebar button renders ABOVE `ledger-goals` in DOM order, opening it shows the ideas items as a flat table, and an idea's detail panel edits title/description/status via updateItem. `bun test` passes.
- suggestedModel: standard
- dependsOn: ["T335"]
- ledgerRefs: ["goals:G41"]
- resultCommit: a39fd9433bc6d5de45a1bc86a5cc08e11db70e2a
- completion: "'Ideas' sidebar group above Goals in ledger-web App.tsx; ideas reuse the flat goals list path + generic updateItem detail edit; ideasFlat tests; bun run check green. (Recovered via format-patch + git am — worker commit was unreachable from main's object db.)"
- sessionLogs: ["docs/logs/20260609-201031-a2e9e3e7a4527c18c.md","docs/logs/20260609-201031-ab3a53a6728cc9212.md"]

### T340 — done

- createdAt: 2026-06-09T19:09:36.098Z
- updatedAt: 2026-06-09T20:20:42.883Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Extend /cq:plan command grammar to accept idea-ids (one goal per idea)"
- description: "EDIT LOCUS: nix/pkg/cq-assets/commands/cq/plan.md ONLY (a slash-command prompt the orchestrator executes; there is NO cq-cli arg-parser for slash commands — the 'grammar' is the documented procedure the orchestrator follows + the ledger MCP ops it performs). Extend plan.md so the orchestrator accepts I-ids as arguments. Grammar (Q188, NO 'mixed' interleaving — R399 dropped that ungrounded scope): the argument is EITHER one or more whitespace-separated idea-ids each matching /^I\\d+$/, OR free text (today's path) — not both interleaved. `/cq:plan I01 I02 I03` creates ONE goal PER idea. Define a named **consume-an-idea sub-procedure** ONCE (a numbered sub-section): (i) fetch_item the idea from the `ideas` ledger; (ii) bootstrap a new goal seeding its title from the idea title and description VERBATIM from the idea description (then the normal clarifying bootstrap); (iii) link bidirectionally — add `ideas:<I>` to the goal's ledgerRefs and `goals:<G>` to the idea's ledgerRefs; (iv) update the idea status to 'planned'. plan.md must reference this sub-procedure so /cq:plan:follow-up reuses it (DRY). Keep the existing defect-vs-goal intake guard, provenance + handoff sections."
- acceptance: "OBSERVABLE: (1) plan.md contains a section documenting the I-id token grammar (the /^I\\d+$/ rule) and the EITHER-idea-ids-OR-free-text (no interleave) rule; (2) it contains the named consume-an-idea sub-procedure with the four steps (fetch → seed verbatim → bidirectional ledgerRefs link → idea→planned); (3) one-goal-per-idea is stated explicitly. Verified by a structural grep/asset test asserting those sections/anchors exist, plus `bun run check` stays green (no code touched). No nonexistent symbol/file is referenced."
- suggestedModel: frontier
- dependsOn: ["T335"]
- ledgerRefs: ["goals:G41"]
- resultCommit: 6aedb28c362ddc99aa7f1ec8a37bfd75546b0a30
- completion: plan.md I-id grammar (EITHER /^I\d+$/ ids OR free text) + named consume-an-idea sub-procedure (DRY, referenced by follow-up.md) + agentsCatalogue.gen.ts regen + 5 grep-invariants; bun run check green.
- sessionLogs: ["docs/logs/20260609-201031-a6676de77b1de785c.md","docs/logs/20260609-201031-a03c758596a249aa0.md"]

### T342 — wip

- createdAt: 2026-06-09T19:09:53.795Z
- updatedAt: 2026-06-09T20:21:25.110Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Extend /cq:plan:follow-up to append idea text as new scope on an existing goal"
- description: "EDIT LOCUS: nix/pkg/cq-assets/commands/cq/plan/follow-up.md ONLY. Make `/cq:plan:follow-up G35 I01` accepted: the FIRST token is the target goal id, the remaining tokens are idea-ids (/^I\\d+$/). For each idea: fetch it from the `ideas` ledger and APPEND its title+description as new scope onto the existing goal G35's description, using follow-up.md's EXISTING re-open mechanism (the same goal re-open path it already documents for adding scope to a planned/building goal — R399: this is the pre-existing follow-up re-open behaviour, NOT a new 're-open semantics' invented here). Then invoke the SAME shared consume-an-idea sub-procedure defined in plan.md for the link + transition (add `goals:G35` to the idea's ledgerRefs + `ideas:I01` to the goal's; set the idea status to 'planned'). Free-text follow-up still supported. Reference (do NOT duplicate) plan.md's consume-an-idea sub-procedure for DRY."
- acceptance: "OBSERVABLE: (1) follow-up.md documents the argument grammar (first token = goal id; remaining /^I\\d+$/ tokens = ideas) and that each idea's title+description is appended as new scope via the existing re-open path; (2) it REFERENCES (by name/anchor) plan.md's shared consume-an-idea sub-procedure for the link + idea→planned transition (no duplicated procedure text). Verified by a structural grep/asset test asserting the grammar section + the cross-reference exist, plus `bun run check` stays green. No nonexistent symbol/file referenced."
- suggestedModel: frontier
- dependsOn: ["T340"]
- ledgerRefs: ["goals:G41"]

## M139

### T336 — planned

- createdAt: 2026-06-09T19:08:57.294Z
- updatedAt: 2026-06-09T19:29:36.863Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Design the typed prompt-catalog data model + formal JSON Schemas (single source of truth)
- description: "Establish the typed catalog that REPLACES the hand-authored agentsCatalogue/roleActions.ts prose as the single source of truth for agent/subagent prompts + input/output schemas (Q185, reconciling G38). Current source: cq-assets/agents/*.md + commands/cq/*.md prose `## Catalogue` blocks → gen-agents-catalogue.ts → agentsCatalogue.gen.ts. DECISIONS to LOCK in this task (a decisions item): (1) **Role scope** — distinguish DISPATCHED-SUBAGENT roles (plan-advance, plan-reviewer, implement-worker, implement-reviewer, conflict-resolver, investigate-explorer, prober, plan-synthesizer, … — the roles with a non-null agentTierKey, dispatched with a parent-supplied input and returning a validated output) from ORCHESTRATOR-COMMAND roles (agentTierKey===null / not-model-configurable — the /cq:* commands, never dispatched-with-validated-input by a parent). ONLY dispatched-subagent roles get formal input/output JSON Schemas + the validate-in/out flow; orchestrator-command roles carry the prompt + metadata but no parent-validated input/output contract. (2) **Validator** — PREFER a JSON-Schema validator ALREADY in the cq-ledgers workspace; only if none exists add the most-recent stable Ajv AND, in the SAME task, perform the mandatory FOD refresh (set flake.nix outputHash to 52 A's → `nix build .#node-modules` → paste the `got:` hash) so `nix build .#node-modules` stays green. (3) **Storage format** — COMMIT to ONE representation: per-role typed schema declarations co-located with each role (a sidecar consumed by gen-agents-catalogue.ts), NOT embedded in the prose Catalogue blocks. Author the input+output JSON Schemas for ONE role first — plan-advance — matching its actual input (goal id, mode flags) and output (status token / candidate JSON) from agents/plan-advance.md."
- acceptance: "A decisions (locked) item records the three decisions above (role-scope split, validator choice + FOD-refresh-if-new-dep, storage format) reconciling the G38 agentsCatalogue/ROLE_FLOWS question. A typed PromptCatalogEntry { id, kind, dispatched:boolean, model/tier, version, promptTemplate, inputSchema?, outputSchema? } compiles; plan-advance's inputSchema+outputSchema are valid JSON Schema (a test compiles each with the chosen validator) and accept a valid example / reject an invalid one. If a dependency was added, `nix build .#node-modules` is green. `bun run typecheck` + `bun test` pass."
- suggestedModel: frontier
- ledgerRefs: ["goals:G41"]

### T341 — planned

- createdAt: 2026-06-09T19:09:47.849Z
- updatedAt: 2026-06-09T19:30:00.997Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Build the catalog store + extend gen-agents-catalogue to emit typed JSON Schemas
- description: "Make the typed catalog the producer for all DISPATCHED-SUBAGENT roles (per the T336 role-scope decision: roles with a non-null agentTierKey get input/output schemas; orchestrator-command roles carry prompt+metadata only). COMMITTED storage format (T336 decision): per-role typed schema declarations co-located with each role as a SIDECAR (e.g. a `<role>.schema.ts`/`.schema.json` beside the role's prompt, or a typed schema field in a sidecar module) — NOT embedded in the prose `## Catalogue` blocks. Rework nix/pkg/cq-ledgers/packages/ledger-web/scripts/gen-agents-catalogue.ts + agentsCatalogue.ts so the generated catalogue (agentsCatalogue.gen.ts) carries the typed inputSchema/outputSchema (for dispatched roles) + promptTemplate as the single source. Keep the determinism + hard-fail contract (every role complete or nothing emitted) and the AGENT_ROLE_TIERS roster cross-check. Place the node-free typed catalog in a location ledger-mcp can import directly (a shared module), avoiding a second copy. ROLE_FLOWS edge/label data in roleActions.ts STAYS (it models flow edges, not prompts)."
- acceptance: "`bun run gen-agents` regenerates agentsCatalogue.gen.ts byte-deterministically with typed inputSchema/outputSchema present for every dispatched-subagent role (and absent for orchestrator-command roles); a test asserts every dispatched role's two schemas validate as JSON Schema and the roster cross-check passes; the typed catalog is importable by ledger-mcp (no duplicate copy). `bun run check` passes."
- suggestedModel: frontier
- dependsOn: ["T336"]
- ledgerRefs: ["goals:G41"]

### T343 — planned

- createdAt: 2026-06-09T19:09:59.608Z
- updatedAt: 2026-06-09T19:09:59.608Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Expose fetch-prompt / validate-input / validate-output MCP endpoints in ledger-mcp
- description: "Add three MCP tools to ledger-mcp (mirror the configCapability injection pattern in packages/ledger-mcp/src/configCapability.ts + tool registration in main.ts): `fetch_prompt(roleId)` → { promptTemplate, inputSchema, outputSchema } from the typed catalog; `validate_input(roleId, input)` → validates `input` against that role's inputSchema (returns ok / structured errors with the failing JSON-Schema path); `validate_output(roleId, output)` → validates against outputSchema. Build a PromptCatalogCapability injected like ConfigCapability, reading the committed typed catalog (re-read per call, no caching, consistent with the compute* methods). Use the validator chosen in the design task. Fail fast with a precise error on unknown roleId."
- acceptance: "ledger-mcp tests (dual-tests style against the in-memory + real store wiring) assert: fetch_prompt('plan-advance') returns the prompt + both schemas; validate_input accepts a valid plan-advance input and rejects an invalid one with a structured error (failing field path); validate_output likewise; unknown roleId throws a precise error. `bun run check` passes."
- suggestedModel: frontier
- dependsOn: ["T341"]
- ledgerRefs: ["goals:G41"]

### T344 — planned

- createdAt: 2026-06-09T19:10:09.075Z
- updatedAt: 2026-06-09T19:10:09.075Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Wire plan-advance end-to-end through the catalog as proof, then update the Agents tab
- description: "Prove the full flow (Q185 steps a–g) for ONE dispatching path: the plan-flow orchestrator (commands/cq/plan/advance.md and/or plan.md) dispatching plan-advance. Update that command's documented procedure to: (a) fetch_prompt('plan-advance') for the prompt template, (b) take its inputSchema, (c) compose the input, (d) validate_input via MCP, (e) run the subagent, (f) await output, (g) validate_output via MCP. Update ledger-web's Agents tab (HelpOverlay / agentsCatalogue consumers in App.tsx) to render the typed schemas from the catalog instead of the prose ioSchema strings. Degrade gracefully where the MCP tool is unavailable (older/embedded server), like the existing get_agent_models overlay-error path."
- acceptance: plan/advance.md documents the fetch→validate-input→run→validate-output sequence for plan-advance; an Agents-tab test asserts the plan-advance row renders the typed input/output schema sourced from the catalog (not the legacy prose); `bun run check` passes. Reviewer confirms the documented flow matches the three MCP endpoints' contracts.
- suggestedModel: frontier
- dependsOn: ["T343"]
- ledgerRefs: ["goals:G41"]

### T345 — planned

- createdAt: 2026-06-09T19:10:17.305Z
- updatedAt: 2026-06-09T19:30:21.542Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: Wire ALL remaining agents through the catalog and remove legacy prompt/schema duplication
- description: "Generalize the plan-advance proof to every DISPATCHED-SUBAGENT dispatch path (per the T336 role-scope split): each parent that DISPATCHES a subagent fetches that subagent's prompt + validates input/output via the catalog MCP endpoints. ENUMERATED dispatch sites (the commands that spawn subagents): commands/cq/plan/advance.md (plan-advance, plan-reviewer, plan-synthesizer), commands/cq/implement/advance.md (implement-worker, implement-reviewer, conflict-resolver), commands/cq/investigate/advance.md (investigate-explorer, prober). Orchestrator-COMMAND roles (the /cq:* commands themselves, agentTierKey===null) are NOT dispatched-with-validated-input and are OUT of this wiring — they are catalogued (prompt+metadata) but get no validate-in/out. Then clean up legacy: remove the now-duplicated hand-authored prompt/schema sources the typed catalog supersedes (Q185 'clean up legacy code/prompts if any') — e.g. the prose `## Catalogue` ioSchema lines for dispatched roles once the typed schemas are authoritative, and any duplicated prompt copies. Keep roleActions.ts ROLE_FLOWS (edges/labels, not prompts), link-prompts.ts, and the AGENT_ROLE_TIERS roster consistent."
- acceptance: Every DISPATCHED-SUBAGENT role is reachable via fetch_prompt and each of the enumerated dispatch sites above documents the validate-input → run → validate-output steps; orchestrator-command roles are catalogued without an input/output schema; a repo grep confirms no remaining hand-authored prose ioSchema duplicating a typed schema for a dispatched role; `bun run link-prompts --check` (or the equivalent asset-link check), `bun run gen-agents`, and `bun run check` all pass. Reviewer confirms no legacy prompt source the catalog replaced remains.
- suggestedModel: frontier
- dependsOn: ["T344"]
- ledgerRefs: ["goals:G41"]

## M140

### T337 — planned

- createdAt: 2026-06-09T19:09:09.731Z
- updatedAt: 2026-06-09T19:09:09.731Z
- author: "opus-4.8[1m]"
- session: 7e451a99-b692-4ea6-b078-7776ebb17ca0
- headline: "Spike: assess feasibility of storing the ledger on an orphan git branch without working-tree switches"
- description: "SPIKE-ONLY (Q186): deliver a feasibility DECISION + documented findings (and optionally a throwaway PoC), NOT a production implementation. Investigate keeping the ledger (docs/*.md) on a SEPARATE git branch rooted at the EMPTY/zero commit (orphan ref), with the HARD constraint that writes must NOT switch the working tree to that branch. Evaluate the git-plumbing approach: `git hash-object -w` for blobs, `git mktree`/`update-index --index-info` to build trees, `git commit-tree` for commits, `git update-ref refs/heads/<ledger-branch> <sha>` to advance the orphan ref — all without checkout — and/or a dedicated linked `git worktree`. Prototype the minimal command sequence in a throwaway script under nix/pkg/cq-ledgers/debug/ run against a THROWAWAY test repo (NOT the cq repo; do not wire into ledger-mcp). Assess: correctness, concurrency/locking vs FsLedgerStore, how reads work (cat-file), interaction with the existing ledger git-commit steps in the commands, reflog/push-fetch edge cases, and failure modes. Produce a clear go/no-go recommendation; if feasible, note what a SEPARATE later goal would need."
- acceptance: "A locked decisions item records the feasibility verdict (feasible / not-feasible / feasible-with-caveats) with concrete evidence: the exact plumbing command sequence tested, captured proof that an orphan-ref commit advanced WHILE the main checkout's HEAD ref AND working tree stayed BYTE-IDENTICAL before/after (or proof it cannot), the concurrency/locking assessment, and a recommendation for the follow-up goal. Findings written into the decision rationale and/or a docs/drafts/<ts>-orphan-ledger-feasibility.md note. NO production code merged into packages/*/src; a grep confirms the PoC is referenced only under debug/ + the findings doc."
- suggestedModel: frontier
- ledgerRefs: ["goals:G41"]
