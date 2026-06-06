---
ledger: tasks
counters:
  milestone: 0
  item: 206
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
---

# tasks

## M77

### T200 — done

- createdAt: 2026-06-06T20:59:46.674Z
- updatedAt: 2026-06-06T21:37:01.134Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Author the harness-flow state-machine document (plan / investigate / implement / advance)
- description: "Write a single prose Markdown document (Q114) at nix/pkg/cq-assets/docs/flow-state-machines.md describing the state machines of all four harness flows. SOURCE the states/transitions/handoffs by reading the actual flow specs under nix/pkg/cq-assets/commands/cq/ (plan/{start,advance,follow-up,plan-review,planners}, investigate/{start,advance}, implement/{start,advance,implement-review}, advance) plus the plan-advance and plan-reviewer agent prompts (nix/pkg/cq-assets/agents/ or wherever they live). For EACH flow document: (a) its states (e.g. for plan: clarifying / planning / planned / building / done / abandoned, plus the orchestrator's waiting-for-user-input loop states), (b) the transitions between them and what triggers each (user answers, reviewer go-ahead/revise, plan locked, etc.), (c) the cross-flow HANDOFFS where one flow defers/returns to another (advance sequences investigate->plan->implement to quiescence; plan file-and-defers a confirmed/out-of-scope defect to investigate; investigate seeds a confirmed-root-cause goal back to plan; plan reaches planned and implement picks up the task DAG). Include a top-level section for the advance sequencer showing the cross-flow handoff topology (this doubles as the combined overview per Q115). Prose for humans; this doc is SEPARATE from the Flows-tab render data (no shared source of truth required). Match existing docs/ style. NOTE: this doc is the authoritative reference the phase-2 flow render-data module mirrors by hand."
- acceptance: "nix/pkg/cq-assets/docs/flow-state-machines.md exists and contains a dedicated section for each of the four flows (plan, investigate, implement, advance) plus the cross-flow handoff topology; each flow section enumerates its states and its labelled transitions; the states/transitions/handoffs match the current command specs under nix/pkg/cq-assets/commands/cq/ (spot-checked: plan phases clarifying->planning->planned->building->done/abandoned with the planning<->clarifying revise edge; advance's investigate->plan->implement sequencing; plan's file-and-defer-defect-to-investigate and investigate's seed-goal-back-to-plan handoffs are all present). The doc references no nonexistent state/transition."
- suggestedModel: frontier
- ledgerRefs: ["goals:G23"]
- resultCommit: e9bf762
- completion: Authored nix/pkg/cq-assets/docs/flow-state-machines.md (all four flows + cross-flow handoff topology).
- sessionLogs: ["docs/logs/20260606-213541-a45e9cbf3976acb05.md","docs/logs/20260606-213541-ac51a9a79be8601ed.md"]

## M78

### T201 — done

- createdAt: 2026-06-06T20:59:57.550Z
- updatedAt: 2026-06-06T21:37:04.063Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Add elkjs dependency to ledger-web, wire it through the Nix FOD + bundle closure, refresh the FOD hash
- description: "Adopt the elkjs layout library (decision K37) and make it resolvable in BOTH the dev (bun) and Nix-packaged (ledger-web) builds. Steps: (1) add `elkjs` (latest stable, ^0.x current release — verify the exact current version on npm at implementation time) to dependencies in nix/pkg/cq-ledgers/packages/ledger-web/package.json; (2) run `bun install` from nix/pkg/cq-ledgers/ to update bun.lock; (3) refresh the FOD hash per CLAUDE.md §Build: set flake.nix bunNodeModules outputHash (line ~117) to 52 'A's, run `nix build .#node-modules` from the repo root, paste the reported got: hash back into outputHash; (4) add `elkjs` to the ledger-web browser-dep symlink loop in flake.nix (the `for dep in react react-dom react-markdown remark-gfm rehype-sanitize bun-types` line ~345 inside the ledgerWeb derivation) so Bun.build resolves it from the Nix closure at serve.ts startup. NOTE: elkjs's default entry pulls a web-worker file; use the main-thread/bundled entry (import ELK from 'elkjs/lib/elk.bundled.js') so it bundles cleanly under Bun.build with no worker asset — confirm the import path resolves both under bun dev and in the Nix bundle."
- acceptance: "`elkjs` appears in packages/ledger-web/package.json dependencies and in bun.lock; `nix build .#node-modules` succeeds with the refreshed outputHash (no hash-mismatch error); `nix build .#ledger-web` succeeds; `elkjs` is present in the ledgerWeb derivation's `for dep` symlink list; a trivial `import ELK from 'elkjs/lib/elk.bundled.js'` in the ledger-web src typechecks (`bun run typecheck`) and bundles without an unresolved-worker error."
- suggestedModel: standard
- ledgerRefs: ["goals:G23"]
- resultCommit: e9bf762
- completion: Added elkjs 0.11.1 (bundled entry), wired through Nix FOD + ledger-web symlink closure, refreshed FOD outputHash; both nix builds green.
- sessionLogs: ["docs/logs/20260606-213541-adb007e3bc921fd76.md","docs/logs/20260606-213541-ac8524b4dcf023468.md"]

### T202 — planned

- createdAt: 2026-06-06T21:00:15.170Z
- updatedAt: 2026-06-06T21:00:15.170Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Build the elk-based layout adapter + thin SVG diagram renderer (shared by both diagram tabs)
- description: "Create the reusable diagram layer that both the State-machines tab and the new Flows tab render through, replacing the homegrown computeDagLayout path for these tabs (decision K37). Add nix/pkg/cq-ledgers/packages/ledger-web/src/diagramLayout.ts exposing a pure-ish async function that takes a generic graph model { nodes: {id,label,terminal?,fill?}[]; edges: {from,to,label?}[] } and runs elkjs (import ELK from 'elkjs/lib/elk.bundled.js') with a layered layout config (elk.algorithm=layered, direction LEFT->RIGHT to match the current look, edge-label placement enabled, self-loop support) and returns a laid-out model { nodes:{id,label,x,y,w,h,terminal,fill}[]; edges:{from,to,label?,points:{x,y}[],labelPos?:{x,y}}[]; width; height }. Add nix/pkg/cq-ledgers/packages/ledger-web/src/DiagramSvg.tsx — a React component that renders that laid-out model as inline SVG: rounded-rect nodes with the existing BUCKET_HEX/status fills + terminal thick-outline styling carried over from the current StateMachineDiagram, edges as polylines/beziers through elk's routing points WITH an arrowhead marker, and edge labels as <text> at labelPos. Preserve/emit the same data-testid scheme the current tests rely on (parameterised: data-testid `${idPrefix}-node-${id}`, `${idPrefix}-edge-${from}-${to}`, `${idPrefix}-rect-${id}`, and a new `${idPrefix}-edge-label-${from}-${to}` for labels) so structural happy-dom assertions remain possible. Because elk.layout() is async, the consumer computes the laid-out model in a useEffect and renders DiagramSvg when ready (with a loading placeholder). Add a unit test diagramLayout.test.ts asserting a small graph (incl. a self-loop and a labelled edge) yields nodes with finite x/y/w/h, an edge with >=2 routing points, and a label position — all WITHOUT any DOM (pure elk call under bun/happy-dom)."
- acceptance: "src/diagramLayout.ts and src/DiagramSvg.tsx exist; diagramLayout.test.ts passes under `bun test` (happy-dom) and asserts: a graph with a self-loop edge and a labelled edge produces finite node coordinates, an edge with >=2 points, and a finite label position — with NO getBBox/ResizeObserver/DOMMatrix usage; DiagramSvg renders nodes/edges/edge-labels with the documented data-testid scheme; `bun run typecheck` and `bun run lint` pass."
- suggestedModel: frontier
- dependsOn: ["T201"]
- ledgerRefs: ["goals:G23"]

### T203 — planned

- createdAt: 2026-06-06T21:00:31.901Z
- updatedAt: 2026-06-06T21:07:05.350Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Migrate the existing 'State machines' help tab onto the elk renderer; retire computeStateMachine's homegrown layout
- description: |
    Re-point the existing State-machines tab (decision K37, Q116) at the new elk-based diagram layer (T202) so its diagrams stop using computeDagLayout. In App.tsx, replace the StateMachineDiagram component body (lines ~1589-1642) so it: (a) maps the ledger schema to the generic graph model — nodes = schema.statusValues with fill = BUCKET_HEX[statusBucket(status, schema)] and terminal = isTerminal(status, schema); edges = schema.transitions pairs (now ABLE to keep self-loops, which the old layout dropped); (b) computes the laid-out model via diagramLayout in a useEffect (async) and renders DiagramSvg with idPrefix `help-statemachine-${ledger}` so the per-ledger diagram container resolves as `help-statemachine-${ledger}`, the SVG as `help-statemachine-svg-${ledger}`, and nodes/edges as `${idPrefix}-node-${id}` / `${idPrefix}-edge-${from}-${to}` (the documented scheme from T202). Reduce src/stateMachine.ts to a thin schema->graph-model ADAPTER (the status/edge mapping above) OR remove it if the mapping is inlined; either way computeStateMachine must NO LONGER call computeDagLayout. Do NOT touch DagView.tsx / dagLayout.ts (milestone DAG keeps the homegrown layout — out of scope). Keep the lazy batched schema fetch and the loading/error states intact.
    
    TEST COVERAGE — this is NEW coverage, not an edit to an existing tab test. CORRECTION (R237 criticism 1): the repo today has NO happy-dom DOM test of the State-machines tab — app.test.tsx only opens the help overlay on the Shortcuts tab (L1296-1305) and never clicks help-tab-statemachines nor asserts any help-sm-* / help-statemachine-* id; the sole computeStateMachine coverage is the pure unit test test/stateMachine.test.ts. So do NOT frame this as 'updating existing tab tests'. ADD a NEW happy-dom render test (in packages/ledger-web/test/) that: (1) renders the app, opens the help overlay, clicks help-tab-statemachines, and awaits the async elk layout; (2) asserts the migrated DiagramSvg renders exactly one diagram per ledger using the documented data-testid scheme (help-statemachine-<ledger> container, help-statemachine-svg-<ledger> svg, and per-node / per-edge testids); (3) asserts that for a schema that HAS a self-loop transition, the corresponding self-loop edge testid is present (the behavior the elk migration newly ENABLES and the old computeDagLayout dropped). This test must run under happy-dom with NO getBBox/ResizeObserver/DOMMatrix dependence (elk layout is pure data). Regression safety for the migration must rest on THIS happy-dom test, not solely on T206's headless/manual smoke.
    
    D33 RECONCILIATION (R237 criticism 2): T203 rewrites the exact StateMachineDiagram SVG sizing/alignment code (width/height/viewBox, style maxWidth=model.width, preserveAspectRatio) that defect D33 concerns (right-alignment of wide diagrams). Current disposition: D33 has been ROOT-CAUSED this session — the cause is the homegrown computeDagLayout leaving layer 0 empty for cyclic graphs (NOT the CSS) — and goal G24 (task T199, already `planned`) will FIX computeDagLayout and resolve D33 for the homegrown renderer, which after this migration only serves DagView. Because the State-machines tab moves onto elkjs here, it no longer uses computeDagLayout at all, so it must NOT reintroduce D33's symptom: the elk-rendered diagrams must be LEFT-ALIGNED with no empty leading column. Do NOT create a new defect; just preserve left-alignment in the new renderer and rely on G24/T199 for the homegrown-renderer fix.
- acceptance: "The State-machines tab renders one diagram per ledger via DiagramSvg (no computeDagLayout in the State-machines code path — grep confirms computeStateMachine no longer imports/calls computeDagLayout); node fills still match the status-bucket palette; DagView/dagLayout untouched (git diff shows no change to DagView.tsx or dagLayout.ts). NEW happy-dom render test (added by this task; there was no prior DOM tab test) PASSES under `bun test` and: (a) opens the help overlay, clicks help-tab-statemachines, awaits the async elk layout, and finds exactly one diagram per ledger under the documented testid scheme (help-statemachine-<ledger> container + help-statemachine-svg-<ledger> svg + per-node/per-edge testids); (b) asserts a schema with a self-loop transition renders its self-loop edge testid (previously dropped by computeDagLayout); (c) uses NO getBBox/ResizeObserver/DOMMatrix. LEFT-ALIGNMENT / D33 (criticism 2): the elk-rendered State-machines diagrams are left-aligned with no empty leading column — assert the minimum laid-out node x is flush-left (e.g. min node.x equals the diagram's left padding, no phantom empty layer-0 gap); this guards against reintroducing D33's right-alignment symptom in the new renderer (D33 itself is resolved for the homegrown renderer by G24/T199 — not re-filed here). `bun run check` (typecheck + lint + test) is green."
- suggestedModel: frontier
- dependsOn: ["T202"]
- ledgerRefs: ["goals:G23"]

### T204 — planned

- createdAt: 2026-06-06T21:00:44.362Z
- updatedAt: 2026-06-06T21:00:44.362Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Build the flow render-data module (states/edges/handoffs for plan, investigate, implement, advance)
- description: "Create nix/pkg/cq-ledgers/packages/ledger-web/src/flowData.ts — a hand-authored TS data module holding the FLOW orchestration diagrams the Flows tab renders, mirroring (by hand, per Q114 — NOT a shared source of truth) the phase-1 doc T200. Export an ordered array of flow definitions, one per Q115 requirement: `plan`, `investigate`, `implement`, plus an `advance` top-level overview. Each flow = { id; title; nodes: {id,label,kind?:'state'|'waiting'|'handoff'|'terminal'}[]; edges: {from,to,label?}[] } in the SAME generic graph shape the diagramLayout/DiagramSvg layer (T202) consumes. Encode: plan's clarifying/planning/planned/building/done/abandoned states with labelled transitions (user answers, go-ahead, revise, plan locked) including the planning<->clarifying revise loop; investigate's hypothesis-tree round loop + confirmed-root-cause -> seed-goal-to-plan handoff; implement's pick-ready -> implement -> review -> fix/merge loop + user-question register; and the advance sequencer's investigate->plan->implement quiescence loop showing the cross-flow handoff edges (plan file-and-defer-defect->investigate; investigate seed-goal->plan; plan planned->implement). Use kind to drive distinct node styling (e.g. waiting-for-input vs handoff) in DiagramSvg. Add flowData.test.ts asserting: all four flows present and ordered; every edge endpoint references an existing node id in its flow; the advance flow contains the three named cross-flow handoff edges. NOTE: keep flowData.ts content consistent with T200's doc — reviewer will check the two agree."
- acceptance: src/flowData.ts exports exactly the four flows (plan, investigate, implement, advance) in order; flowData.test.ts passes (`bun test`) asserting every edge's from/to resolves to a node in the same flow and the advance flow includes the file-defer-to-investigate, seed-goal-to-plan, and planned-to-implement handoff edges; the flow graph shape is exactly the generic model DiagramSvg consumes; `bun run typecheck`/`lint` pass; spot-check confirms flowData states/edges agree with docs/flow-state-machines.md (T200).
- suggestedModel: frontier
- dependsOn: ["T200","T202"]
- ledgerRefs: ["goals:G23"]

### T205 — planned

- createdAt: 2026-06-06T21:01:00.659Z
- updatedAt: 2026-06-06T21:01:00.659Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Add the third 'Flows' tab to the help dialog, rendering the flow diagrams via the elk renderer
- description: "Add the new third tab to HelpOverlay in App.tsx (currently Shortcuts + State machines, lines ~1485-1580), per the goal + Q115. (1) Widen the tab state union to `'shortcuts' | 'statemachines' | 'flows'`; add a third tablist <button> (role=tab, data-testid `help-tab-flows`, label 'Flows', aria-selected wiring matching the other two). (2) Add the tab body: when tab==='flows', render one section per flow from flowData (T204) — plan, investigate, implement, then the advance overview — each with an <h4> title and a DiagramSvg (T202) of that flow, idPrefix `help-flow-${flow.id}`, with distinct node styling by `kind` (waiting-for-input vs handoff vs state vs terminal). Compute each flow's laid-out model via diagramLayout in an effect (async) and show the same loading/error placeholder pattern the State-machines tab uses. The Flows data is static (no MCP fetch needed) so it can lay out on first tab open. (3) Keep the existing keyboard capture (Esc/? close) and backdrop-dismiss behavior unchanged. Add tests in packages/ledger-web/test/ asserting: the third tab button exists (help-tab-flows) and is selectable; selecting it renders a section + DiagramSvg for each of the four flows (data-testid help-flow-<id>); a labelled handoff edge in the advance flow renders its edge-label text. Update the help dialog's CSS only as needed for a third tab + any new node-kind styling (styles.css), matching existing lw-help-* conventions."
- acceptance: HelpOverlay shows three tabs; clicking 'Flows' (help-tab-flows) renders a diagram section for each of plan/investigate/implement/advance (help-flow-plan, -investigate, -implement, -advance), each via DiagramSvg; the advance overview renders its labelled cross-flow handoff edges (edge-label text present); new tests pass under `bun test`; Esc/? still close the dialog; `bun run check` green; `nix build .#ledger-web` succeeds and the served bundle includes the Flows tab.
- suggestedModel: frontier
- dependsOn: ["T203","T204"]
- ledgerRefs: ["goals:G23"]

### T206 — planned

- createdAt: 2026-06-06T21:01:10.756Z
- updatedAt: 2026-06-06T21:07:23.764Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: "End-to-end verification: full check suite + Nix builds + manual render smoke of both diagram tabs"
- description: |
    Final integration gate for G23 phase 2. (1) Run `bun run check` (tsc -b + eslint + bun test) from nix/pkg/cq-ledgers/ — must be fully green, including the new diagramLayout/flowData/Flows-tab tests and the NEW State-machines tab happy-dom render test added by T203 (the migration's regression safety lives in that test, not in this smoke). (2) From the repo root run `nix build .#node-modules` (confirms the refreshed FOD hash is correct) and `nix build .#ledger-web` (confirms elkjs resolves in the Nix closure and the bundle builds with no unresolved-worker/module error). (3) Manual render smoke: launch the built ledger-web (or bun dev), open the help dialog, and confirm BOTH the State machines tab AND the new Flows tab render their diagrams via the elk renderer without console errors — nodes laid out, edges routed, labels visible, self-loops shown. Because happy-dom cannot do real layout, ground-truth the VISUAL output with the nixpkgs headless chromium (nix eval --raw nixpkgs#chromium.outPath, the same approach used for D33 this session) by screenshotting both diagram tabs.
    
    D33 / LEFT-ALIGNMENT verification (R237 criticism 2): in the headless-chromium screenshot of the State-machines tab, verify the elk-rendered diagrams are LEFT-ALIGNED — the leftmost diagram content is flush against the diagram's left edge with NO empty leading column (i.e. the elk migration does NOT reintroduce D33's right-alignment symptom). Record D33's disposition explicitly in the verification notes: D33 (homegrown computeDagLayout leaving layer 0 empty for cyclic graphs) is resolved for the homegrown renderer by G24/T199; after T203 the State-machines tab uses elk (not computeDagLayout), and this task confirms the elk renderer is left-aligned. Do NOT re-file or duplicate D33. (4) Confirm no regression to the milestone DagView (it still renders via the untouched computeDagLayout). Record any OTHER residual defect found via file-and-defer rather than expanding scope.
- acceptance: "`bun run check` exits 0 (all tests pass, including the NEW T203 State-machines-tab happy-dom render test and the diagramLayout/flowData/Flows-tab tests); `nix build .#node-modules` and `nix build .#ledger-web` both succeed; manual (or headless-chromium) smoke confirms the State machines tab and the Flows tab both render diagrams (nodes/edges/labels/self-loops) with no console errors. D33/left-alignment: the headless-chromium screenshot of the State-machines tab shows the elk-rendered diagrams LEFT-ALIGNED with no empty leading column (the elk migration does not reintroduce D33's right-alignment symptom), and the verification notes record D33's disposition (resolved for the homegrown renderer by G24/T199; State-machines tab no longer uses computeDagLayout). D33 is NOT re-filed. The milestone DagView still renders unchanged. Any OTHER newly-discovered fault is filed as an open defect linked goals:G23, not silently fixed here."
- suggestedModel: standard
- dependsOn: ["T205"]
- ledgerRefs: ["goals:G23"]
