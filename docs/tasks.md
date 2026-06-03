---
ledger: tasks
counters:
  milestone: 0
  item: 157
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
---

# tasks

## M42

### T137 — done

- createdAt: 2026-06-03T15:24:53.245Z
- updatedAt: 2026-06-03T16:11:17.880Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add handoffs CANONICAL_LEDGERS entry (HANDOFFS_SCHEMA, idPrefix HO, all-terminal)
- description: "In packages/ledger/src/constants.ts add HANDOFFS_LEDGER = \"handoffs\" and HANDOFFS_SCHEMA modelled on REVIEWS_SCHEMA (the all-terminal precedent). statusValues = [drained, answers-required, mixed, illness-detected]; terminalStatuses = all four; idPrefix = \"HO\"; transitions = {drained:[], \"answers-required\":[], mixed:[], \"illness-detected\":[]}. Fields (bespoke, NOT via COMMON_REF_FIELDS): summary {string, required:true}, flow {string, required:false} (advance|plan|implement|investigate — documented in the field description, not enum-enforced by the schema type system which only supports string), ledgerRefs {id[], false}, blockingQuestions {id[], false}, handoffReasons {string[], false} (explains a 'mixed' stop, e.g. [drained, answers-required] — per Q83 deviation), sessionLogs {string[], false}, tags {string[], false}, sourceRefs {string[], false}. Append HANDOFFS entry to CANONICAL_LEDGERS (last). Confirm idPrefix HO does not collide (M/D/T/H/Q/K/G/R taken; HO is two chars and distinct)."
- acceptance: HANDOFFS_SCHEMA exported; CANONICAL_LEDGERS has 9 entries ending with handoffs; a unit test asserts the schema shape (statusValues, all-terminal, idPrefix HO, the 8 fields incl. handoffReasons) and that init() bootstraps a fresh handoffs ledger file. bun test green for the ledger package.
- suggestedModel: standard
- ledgerRefs: ["goals:G11"]
- resultCommit: a9148ec
- completion: "Added handoffs ledger: HANDOFFS_SCHEMA (idPrefix HO, all-terminal drained|answers-required|mixed|illness-detected, 8 bespoke fields incl. handoffReasons + sessionLogs) as the 9th CANONICAL_LEDGERS entry; both docs/ledgers.yaml fixtures + canonical-ledgers test updated."

### T138 — planned

- createdAt: 2026-06-03T15:25:03.374Z
- updatedAt: 2026-06-03T15:25:03.374Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "Add sessionLogs:string[] to tasks/reviews/defects/hypothesis/goals schemas"
- description: "In packages/ledger/src/constants.ts add a dedicated field sessionLogs {type:\"string[]\", required:false} (repo-relative docs/logs/<ts>-<agent-id>.md PATHS) to the WORK-producing ledgers per Q86: DEFECTS_SCHEMA, TASKS_SCHEMA, HYPOTHESIS_SCHEMA (inline, AFTER the COMMON_REF_FIELDS spread or alongside the inline fields), GOALS_SCHEMA and REVIEWS_SCHEMA (bespoke field sets). HANDOFFS_SCHEMA already carries it (T137). Do NOT add to questions/decisions, and do NOT add to COMMON_REF_FIELDS (that would propagate to questions/decisions). Give each field a description noting it holds repo-relative log paths. Verify the on-disk-schema divergence guard in init() accepts the new field on a fresh ledger and that existing canonical files round-trip (a schema field addition is additive)."
- acceptance: sessionLogs present on defects/tasks/hypothesis/goals/reviews/handoffs schemas and absent on questions/decisions; a unit test asserts exactly that set; create_item accepts a sessionLogs value on a task and rejects it on a question (unknown field). bun test green.
- suggestedModel: standard
- dependsOn: ["T137"]
- ledgerRefs: ["goals:G11"]

### T139 — done

- createdAt: 2026-06-03T15:25:11.480Z
- updatedAt: 2026-06-03T16:11:23.057Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "Reproduce-first the fts (status:open OR status:wip) empty-result anomaly"
- description: "Per Q77 + repo reproduce-before-fix policy. In packages/ledger/src/search/ (query.ts evaluator + its tests), write a FAILING test FIRST that builds a populated in-memory ledger with items in status open and wip, runs the inline query `(status:open OR status:wip)` through the SAME path fts_search uses, and asserts the open+wip items are returned. Confirm it fails for the RIGHT reason (empty result from OR-of-qualifiers evaluation), not an unrelated error. Capture the observed-vs-expected. This task ONLY establishes the reproduction + adjudicates whether it is a real defect; the fix (if any) is the dependent task. If the test is GREEN (no defect), record that the anomaly was a usage/stale-index artifact (a hypothesis or note) and the dependent fix task becomes documentation-only."
- acceptance: "A committed test exercising `(status:open OR status:wip)` over a populated ledger; its initial run outcome (red/green) is recorded. If red, the failure is shown to be the OR-of-qualifiers evaluator (not a harness error). Adjudication (defect vs usage) is explicit."
- suggestedModel: frontier
- ledgerRefs: ["goals:G11"]
- resultCommit: "2284600"
- completion: "Reproduce-first test for the (status:open OR status:wip) fts anomaly: adjudicated GREEN — the OR-of-qualifiers evaluator is correct (Q77 was a usage/stale-index artifact, not a code defect). Committed as a green regression guard; query.ts untouched. → T140 is documentation-only."

### T140 — planned

- createdAt: 2026-06-03T15:25:24.275Z
- updatedAt: 2026-06-03T15:25:24.275Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Fix-or-document the fts OR-of-qualifiers anomaly per T139 adjudication
- description: "Conditional on T139's adjudication. IF T139 reproduced a real defect in the OR-of-qualifiers evaluator (or the inline status: qualifier vs the dedicated status: param interaction in query.ts): implement the minimal fix so `(status:open OR status:wip)` matches per-item, make T139's failing test pass, and verify no other query/search tests regress. ALSO file a defects record (status:open, severity per impact, rootCause + suggestedFix, ledgerRefs:[goals:G11]) for traceability, link the fix back via dependsOn (file-and-defer bidirectional link), then mark it resolved as part of this task since the fix lands here. IF T139 was green (usage artifact): no code change — this task reduces to capturing the correct usage in the query-language docs (handled in W2's doc task) and is closed as documentation-only."
- acceptance: "If defect: T139's test passes, a defects record exists and is linked to this fix task, full query/search suite green. If usage-only: explicit note that no evaluator change was needed and the doc clarification is delegated to the W2 query-language task. bun test green either way."
- suggestedModel: frontier
- dependsOn: ["T139"]
- ledgerRefs: ["goals:G11"]

### T141 — done

- createdAt: 2026-06-03T15:25:31.571Z
- updatedAt: 2026-06-03T16:11:24.631Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add reopenItem + unarchiveItem store ops to LedgerStore (+ in-memory dummy)
- description: |
    Per Q78 (reopen-terminal + un-archive; sweep-guard deferred). On the LedgerStore interface (packages/ledger/src/store/LedgerStore.ts) add two methods.
    
    (1) reopenItem(ledger, itemId, toStatus) — moves a TERMINAL item to a chosen NON-terminal status, bypassing the empty terminal-transition guard but validating toStatus is a real non-terminal status of that ledger's schema. (This half was correctly grounded in R137 and is UNCHANGED.)
    
    (2) unarchiveItem — RE-GROUNDED per R137 criticism #1. CONFIRMED archive layout (FsLedgerStore.ts:7 header + serializeArchive path): non-milestones ledgers are archived as a milestone-GROUP file keyed by MILESTONE id at ./docs/archive/<ledger>/<milestoneId>.md; ONLY the milestones ledger has per-item archive files. The D22 footgun (evidence #5) was a defects ITEM swept INSIDE its milestone-group archive file. So there is NO ./docs/archive/<ledger>/<itemId>.md to read for a non-milestones item — the op MUST operate at the archived-MILESTONE-GROUP granularity. Re-specify the signature to carry the milestone id, e.g. unarchiveItem(ledger, milestoneId, itemId): read ./docs/archive/<ledger>/<milestoneId>.md, EXTRACT the single requested item from that group, re-attach it to the active ledger file, and decide the fate of the remaining group + the archive pointer (leave the rest of the group archived; rewrite the group archive file without the extracted item, removing the group archive file + its ArchivePointer entirely if it becomes empty). For the milestones ledger (per-item archive files) the itemId path still applies. Fail cleanly if no archived group / no such item in the group. Implement in the real file-backed store AND the in-memory dummy (dual-tests). Preserve intrinsic createdAt; set a fresh updatedAt. These are store ops; the MCP tool wrappers are W2 (T146).
- acceptance: "reopenItem: abstract suite (terminal->non-terminal succeeds; terminal->terminal or unknown status rejected) GREEN against BOTH real store and in-memory dummy. unarchiveItem (group-keyed): given an archived milestone-GROUP file ./docs/archive/<ledger>/<milestoneId>.md containing >=2 items, unarchiveItem(ledger, milestoneId, itemId) re-attaches ONLY that item to the active ledger, the remaining item(s) stay in the group archive (file rewritten without the extracted item), and unarchiving the LAST item removes the group archive file + its ArchivePointer; errors when the group or the item is absent. Both behaviours GREEN against the real store AND the in-memory dummy. bun test green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G11"]
- resultCommit: e1bd32a
- completion: Added reopenItem (terminal→validated non-terminal, guard bypassed) + group-keyed unarchiveItem (extract one item from the archived milestone-group, rewrite/delete the group archive + pointer) to LedgerStore + FsLedgerStore + InMemoryLedgerStore via pure core helpers; dual-tested against both stores; assertWithinDocsRoot enforced. (MCP wrappers deferred to T146.)

### T142 — done

- createdAt: 2026-06-03T15:25:42.939Z
- updatedAt: 2026-06-03T16:11:28.047Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add compact-projection helper (LONG_FIELD_DENYLIST + grounding) for fetch_ledger
- description: |
    Per Q76. Add a pure store/helper function in @cq/ledger (projectCompact) that takes a ledger's items and returns a PROJECTED form omitting long narrative fields, keeping id+status+summary-source+short fields.
    
    DENYLIST COMPLETENESS (RE-GROUNDED per R137 criticism #5 + R138 watch-item): the existing columns.ts LONG_FIELD_DENYLIST = {description,rationale,criticism,context,alternatives,evidence,completion,answer,rootCause,suggestedFix,fix} OMITS several large non-denylisted fields. FIX: define a projection-specific exclusion set = LONG_FIELD_DENYLIST + {grounding, recommendation, suggestions} (preferred: do NOT mutate columns.ts LONG_FIELD_DENYLIST, which drives the TUI/web column layout — keep concerns separate). Specifically:
    - GOALS: `grounding` (the large per-goal repo-grounding blob — a primary cause of the 51.8KB goals overflow, evidence #2; NOT in LONG_FIELD_DENYLIST) MUST be stripped. `description` is already covered.
    - QUESTIONS: `context` (covered) and `answer` (covered) are stripped by the base denylist; ADDITIONALLY `recommendation` (string, a long non-denylisted question field — R138 watch-item) and `suggestions` (string[], may be large) MUST be stripped so the 142.7KB questions ledger fits under the limit. Confirm context/answer/suggestions/recommendation are ALL handled for questions.
    AUDIT: confirm no other large narrative field absent from LONG_FIELD_DENYLIST survives the projection across all ledgers. Reuse the existing LONG_FIELD_DENYLIST export directly as the BASE (do NOT duplicate the list); add only the projection-specific extras {grounding, recommendation, suggestions}.
    
    ALSO add a pagination helper (offset/limit slice over the full-item list, stable ordering by id/createdAt). Pure, side-effect-free, unit-testable in isolation. Consumed by the W2 fetch_ledger params. Addresses evidence #2 (51.8KB/142.7KB overflow).
    
    FILE-DISJOINTNESS (R138 confirm): projectCompact + paginate land in their OWN helper module — they do NOT touch columns.ts, the LedgerStore interface, or the store trio (LedgerStore.ts/FsLedgerStore.ts/InMemoryLedgerStore.ts). They are pure isolation-testable functions, so this task shares no file with T141/T143 (the store-trio tasks).
- acceptance: projectCompact(items) drops every base LONG_FIELD_DENYLIST field AND the goals `grounding` field AND the questions `recommendation` + `suggestions` fields (and any other audited large narrative field), retaining id/status/summary + short fields; a unit test feeds a goals item carrying a large `grounding` blob and asserts the projected output contains NO `grounding` and is small, and a questions item carrying long `recommendation`/`suggestions` and asserts both are absent and the projected item is small. paginate(items, offset, limit) returns the correct stable slice and total count. Unit tests cover an item with every long field (all stripped, incl. grounding/recommendation/suggestions) and pagination boundaries. projectCompact/paginate live in their own module touching neither columns.ts nor the store trio. bun test green.
- suggestedModel: standard
- ledgerRefs: ["goals:G11"]
- resultCommit: f11a872
- completion: "Added packages/ledger/src/projection.ts: projectCompact (strips LONG_FIELD_DENYLIST ∪ {grounding,recommendation,suggestions} — fixes the goals/questions token overflow) + paginate (stable offset/limit slice + total). Pure, own module; exported from index."

### T143 — planned

- createdAt: 2026-06-03T15:25:50.635Z
- updatedAt: 2026-06-03T15:39:55.097Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "Add cross-ledger snapshot helper ({id,status,summary} grouped by ledger×status)"
- description: |
    Per Q75 (GENERIC, flow-agnostic, compact item stubs). Add a pure store helper in @cq/ledger that enumerates all ACTIVE (non-archived) ledgers and returns { [ledger]: { [status]: { count: number, items: Array<{id, status, summary}> } } } where summary = headline ?? title ?? question ?? summary (the existing summarize() precedence — reuse SUMMARY_SOURCE_FIELDS / the summarize helper, do NOT reimplement). NO DAG/phase/predicate semantics (those stay in flow prompts). This collapses the /advance bootstrap (evidence #1/#4) to ~1 call. Build it on the existing enumerate + per-ledger read store methods; keep it a single store-level method (e.g. snapshot()) so the W2 MCP tool is a thin wrapper.
    
    SEQUENCING (R138 criticism #1): snapshot() is a store-level method that lands in the SAME LedgerStore trio (LedgerStore.ts interface + FsLedgerStore.ts + InMemoryLedgerStore.ts dummy) as T141's reopenItem/unarchiveItem. To avoid two isolated-worktree workers editing the store trio concurrently and clobbering on merge-back, this task is serialized AFTER T141 (dependsOn T141). T141's recovery ops are foundational and unaffected by snapshot; ordering snapshot after them keeps the store-trio edits strictly sequential.
- acceptance: "snapshot() over a fixture with items across multiple ledgers/statuses returns the correct grouped counts + {id,status,summary} stubs, excludes archived items, and contains NO long fields. summary precedence matches summarize(). Unit test green; output size for a realistic ledger is well under the token-overflow threshold that motivated the goal."
- suggestedModel: frontier
- ledgerRefs: ["goals:G11"]
- dependsOn: ["T141"]

## M43

### T144 — planned

- createdAt: 2026-06-03T15:26:00.242Z
- updatedAt: 2026-06-03T15:34:49.994Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add projection + pagination params to the fetch_ledger MCP tool
- description: |
    Per Q76/Q80 (params on existing tool, no new tool). In packages/ledger/src/mcp/ledgerTools.ts extend the fetch_ledger tool input schema with optional params: summary/compact (boolean - returns the T142 projected form omitting the long narrative fields) and offset/limit (T142 pagination, returning items + total). Wire the handler to call the W1 helpers. Keep defaults backward-compatible (no params = current full behaviour). Update the fetch_ledger tool DESCRIPTION to document the new params and when to use compact (avoids the token-overflow).
    
    PROJECTION COMPLETENESS (R137 criticism #5): the compact projection MUST strip the goals `grounding` field (the large per-goal repo-grounding blob that is a primary cause of the 51.8KB goals overflow, evidence #2) - it is NOT in columns.ts LONG_FIELD_DENYLIST, so this task depends on T142 having added `grounding` (and any other audited large field) to the projection exclusion set. This task's acceptance must PROVE the previously-overflowing goals ledger now fits under the tool-output limit in compact mode (i.e. with grounding stripped), genuinely closing evidence #2.
    
    SEQUENCING (R137 criticism #2): this task edits ledgerTools.ts (shared with T145/T146/T147); it is the HEAD of that file's dependsOn chain (T145 chains after it), so the four ledgerTools.ts tasks never run as concurrent isolated-worktree edits.
- acceptance: "fetch_ledger with compact:true returns projected items omitting all long narrative fields INCLUDING goals `grounding`; with offset/limit returns the correct page + total; with no params returns the unchanged full ledger. A tool-handler test asserts all three AND specifically asserts a compact fetch of a goals fixture carrying a large `grounding` blob produces output with NO `grounding` field that fits under the tool-output limit that previously overflowed (51.8KB goals / 142.7KB questions). bun test green."
- suggestedModel: standard
- dependsOn: ["T142"]
- ledgerRefs: ["goals:G11"]

### T145 — planned

- createdAt: 2026-06-03T15:26:05.265Z
- updatedAt: 2026-06-03T15:33:55.329Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add the `snapshot` MCP tool (thin wrapper over the W1 snapshot helper)
- description: "Per Q75/Q80. In ledgerTools.ts add a new read tool `snapshot` (no required params; optional include_archived defaulting false) that calls the W1 snapshot() store method and returns the {ledger:{status:{count,items[{id,status,summary}]}}} grouping as JSON. Write a clear tool description: 'one-call cross-ledger actionable-state overview; compact {id,status,summary} stubs grouped by ledger x status; flow-agnostic (compose /advance predicates from this).' Register it in the tool factory. This is the primary fix for evidence #1/#4. SEQUENCING (R137 criticism #2): this task edits packages/ledger/src/mcp/ledgerTools.ts, shared with T144/T146/T147; the four are serialized via a dependsOn chain so isolated-worktree implement workers do not edit ledgerTools.ts concurrently. This task chains AFTER T144."
- acceptance: snapshot tool is registered and callable; returns the W1 grouping; a tool test asserts the shape and that one call surfaces every active ledger's status buckets. bun test green.
- suggestedModel: standard
- dependsOn: ["T143","T144"]
- ledgerRefs: ["goals:G11"]

### T146 — planned

- createdAt: 2026-06-03T15:26:13.908Z
- updatedAt: 2026-06-03T15:33:49.244Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add reopen_item + unarchive_item MCP tools (wrap W1 store ops)
- description: "Per Q78/Q80. In ledgerTools.ts add two new write tools: reopen_item(ledger_id, item_id, to_status) wrapping reopenItem (T141) and unarchive_item wrapping unarchiveItem (T141). RE-GROUNDED per R137 criticism #1: because non-milestones items are archived inside a milestone-GROUP file keyed by milestone id (./docs/archive/<ledger>/<milestoneId>.md, NOT per item), unarchive_item must take (ledger_id, milestone_id, item_id) so the handler can locate the group archive, extract that single item, and re-attach it (matching the re-grounded T141 store op). Accept author/session provenance params like the other write tools. Clear descriptions: reopen_item = 'recover an item accidentally set to a terminal status by moving it to a chosen non-terminal status'; unarchive_item = 'restore a single item that was swept into its milestone-group archive (./docs/archive/<ledger>/<milestoneId>.md) back to the active ledger; pass the archived item's milestone id'. Register both. These directly remediate evidence #5 (the D22 footgun). SEQUENCING: this task edits packages/ledger/src/mcp/ledgerTools.ts (shared with T144/T145/T147) and is serialized last in that file's chain."
- acceptance: Both tools registered + callable; reopen_item moves a terminal item to a valid non-terminal status (and rejects an invalid target); unarchive_item(ledger_id, milestone_id, item_id) restores a single item from its milestone-group archive back to the active ledger and rejects an unknown group/item. Tool tests green. bun test green.
- suggestedModel: standard
- dependsOn: ["T141","T145"]
- ledgerRefs: ["goals:G11"]

### T147 — planned

- createdAt: 2026-06-03T15:26:19.911Z
- updatedAt: 2026-06-03T15:34:08.147Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add the `read_log` MCP tool (bounded, root-confined read of a docs/logs file)
- description: |
    Per Q87 deviation (web is a pure MCP client and cannot read docs/ directly, so the clickable sessionLogs popup needs an MCP read tool). In ledgerTools.ts add a read tool read_log(path) that reads a repo-relative log file and returns its text content.
    
    CONFINEMENT ROOT (RE-GROUNDED per R137 criticism #6): the LedgerStore INTERFACE has no cwd/root accessor and InMemoryLedgerStore has no filesystem, so read_log MUST NOT depend on the generic interface for its root. CONFIRMED: FsLedgerStore is constructed with an explicit `root` (FsLedgerStoreOpts.root = server --cwd; ledgers live under <root>/docs/, FsLedgerStore.ts:118-120). Thread that SAME root (or a precomputed <root>/docs/logs base) EXPLICITLY into the tool factory as a bounded read-log capability at the FS-store layer (a dedicated readLog(relPath) FS-store method, or the root passed alongside the store), NOT a method on the generic LedgerStore interface. When the tool factory is wired over the in-memory dummy (no filesystem), read_log returns a stub / throws not-implemented (documented), so the dual-tests for the OTHER ops are unaffected and read_log's path-confinement test runs ONLY against the FS-backed configuration.
    
    SECURITY/BOUNDS: resolve the requested path against <root>/docs/logs and REJECT any path escaping docs/logs/ (reject `..` traversal and absolute paths that resolve outside the root after normalization). Cap the returned size (a max byte/line bound) so a huge log cannot overflow the tool output. Return {path, content, truncated?}. Consumed by the W3 sessionLogs popup viewer (T152).
    
    SEQUENCING (R137 criticism #2): edits packages/ledger/src/mcp/ledgerTools.ts (shared with T144/T145/T146); serialized last in that file's chain.
- acceptance: read_log returns the content of a file under <root>/docs/logs/; REJECTS `..` traversal and absolute paths resolving outside <root>/docs/logs/ (explicit test asserting traversal is rejected); truncates oversized files with a truncated flag. The confinement root is the explicit FS-store root (not the generic LedgerStore interface); against the in-memory dummy read_log returns a documented not-implemented/stub. Tool test covers happy path + rejected traversal + truncation. bun test green.
- suggestedModel: frontier
- ledgerRefs: ["goals:G11"]
- dependsOn: ["T146"]

### T148 — planned

- createdAt: 2026-06-03T15:26:30.453Z
- updatedAt: 2026-06-03T15:40:04.671Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Update '14 tools' comments + LEDGER_TOOL_NAMES + their tests to the new count
- description: |
    Per Q80. After snapshot/reopen_item/unarchive_item/read_log are added (the 4 new tools → 18 total), update every place that hardcodes the count or the tool-name list: the header comment in packages/ledger/src/mcp/ledgerTools.ts (line ~7 '14 tools'), the corresponding '14 tools' reference in packages/ledger-mcp/src/main.ts, the LEDGER_TOOL_NAMES fixed list, and the tests that assert the count/the exact name set. Add the 4 new names to LEDGER_TOOL_NAMES in the right grouping (reads: snapshot, read_log; writes/recovery: reopen_item, unarchive_item). This is a mechanical sweep but the test assertions make it load-bearing.
    
    SEQUENCING (R138 criticism #2): this task edits packages/ledger-mcp/src/main.ts (the '14 tools' count reference, ~main.ts:156), which is ALSO edited by T149 (the SERVER_INSTRUCTIONS query-language docs at ~main.ts:164). Both edit main.ts but had no mutual dependsOn and differing dep-sets, so the implement flow could dispatch them in overlapping ready-waves and clobber main.ts on merge-back. This task is therefore serialized AFTER T149 (dependsOn T149): T149's instruction-string edit is independent of the tool-count sweep, so it goes first and this count-sweep follows, keeping the two main.ts edits strictly sequential.
- acceptance: Count comments read 18 (or the actual final number); LEDGER_TOOL_NAMES includes the 4 new tools; the tool-count + tool-name-set tests pass. No tool is registered without being in LEDGER_TOOL_NAMES. bun test green.
- suggestedModel: fast
- dependsOn: ["T144","T145","T146","T147","T149"]
- ledgerRefs: ["goals:G11"]

### T149 — planned

- createdAt: 2026-06-03T15:26:38.492Z
- updatedAt: 2026-06-03T15:45:27.820Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Clarify query-language docs in SERVER_INSTRUCTIONS + per-tool descriptions
- description: |
    Per Q79 (server instructions + per-tool descriptions; GENERIC, project-agnostic). Update QUERY_LANGUAGE_HELP (packages/ledger/src/search/query.ts) and/or the SERVER_INSTRUCTIONS string (packages/ledger-mcp/src/main.ts:164) and the fts_search tool description to make the previously-confusing points explicit (evidence #3): (1) the dedicated `status:` PARAM vs the inline `status:` qualifier are two paths — document which to use and that they can combine; (2) active-vs-archived semantics (include_archived); (3) terminal-vs-active status semantics; (4) the corrected behaviour of OR-of-qualifiers (informed by T139/T140's adjudication — if it was a usage artifact, document the correct form; if fixed, document the now-correct behaviour). Keep it flow-agnostic (the /advance bootstrap recipe is the SEPARATE W4 prompt task). Also surface the new snapshot + fetch_ledger compact params in the relevant tool descriptions.
    
    FILES EDITED (three): packages/ledger/src/search/query.ts (QUERY_LANGUAGE_HELP), packages/ledger-mcp/src/main.ts (SERVER_INSTRUCTIONS, ~main.ts:164), AND packages/ledger/src/mcp/ledgerTools.ts (the fts_search tool description plus the snapshot + fetch_ledger compact tool-description strings — QUERY_LANGUAGE_HELP is imported at ledgerTools.ts:34 and every per-tool description string is constructed in that file's tool factory).
    
    SEQUENCING (R139 criticism — same class as R137 #2 / R138, previously un-serialized for this task): because this task ALSO edits packages/ledger/src/mcp/ledgerTools.ts (shared with T144/T145/T146/T147), it MUST sit in that file's write-chain. It is therefore serialized AFTER T147 (dependsOn T147), placing it strictly after the entire ledgerTools.ts chain T144→T145→T146→T147 so no two ledgerTools.ts writers are ever co-ready under isolated-worktree execution. It retains its T140 (query.ts) and T144/T145 deps; T147⊇{T145} so the explicit T144/T145 deps are now subsumed but kept for clarity. T148 already dependsOn T149 (serializing the main.ts pair), so T148 still trails correctly. This task is the LAST writer in the ledgerTools.ts chain. The query.ts chain stays T139→T140→T149 and the main.ts pair stays T149→T148.
- acceptance: SERVER_INSTRUCTIONS + fts_search description state the status-param-vs-inline distinction, active/archived + terminal semantics, and the correct OR-of-qualifiers usage; snapshot + fetch_ledger compact mentioned where an agent reads them (the ledgerTools.ts tool-description strings). This task edits ledgerTools.ts and is the last writer in that file's chain (after T144→T145→T146→T147). Any test snapshotting the instructions string is updated. bun test green.
- suggestedModel: standard
- dependsOn: ["T140","T144","T145","T147"]
- ledgerRefs: ["goals:G11"]

## M44

### T150 — planned

- createdAt: 2026-06-03T15:26:50.863Z
- updatedAt: 2026-06-03T15:26:50.863Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Build the reusable HoldButton wrapper (web) with hold+progress UX
- description: "Per Q81/Q82. In packages/ledger-web/src create a single reusable HoldButton component: prop requireHold (default true), onConfirm callback, children/label, disabled passthrough. Behaviour: a completed HOLD fires onConfirm; HOLD_MS = 1000 (named constant, no magic literal). POINTER path: pointerdown arms + starts a progress animation; pointerup/pointerleave BEFORE the threshold cancels and RESETS the progress bar (action does NOT fire). KEYBOARD path: keydown of Enter/Space arms + starts progress; keyup before threshold cancels (so the affordance is identical across modalities). Render a visible PROGRESS BAR filling over HOLD_MS. requireHold:false degrades to an ordinary single-click button (escape hatch). WEB-ONLY (no TUI). Keep it happy-dom-driveable: rely on pointerdown/pointerup/keydown/keyup + a timer (advanceable by fake timers)."
- acceptance: "Unit tests (happy-dom + fake timers + dispatched pointer/key events): (a) full 1000ms hold fires onConfirm once; (b) release at 500ms does NOT fire and resets progress; (c) Enter/Space held to threshold fires; keyup early cancels; (d) requireHold:false fires on a plain click. bun test (web) green; typecheck + lint clean."
- suggestedModel: frontier
- ledgerRefs: ["goals:G11"]

### T151 — planned

- createdAt: 2026-06-03T15:26:57.909Z
- updatedAt: 2026-06-03T15:27:02.578Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Apply HoldButton to ALL state-mutating web buttons
- description: "Per Q81 (a: ALL state-mutating action buttons). In packages/ledger-web/src/App.tsx wrap every state-mutating action button with HoldButton (requireHold default true), preserving each button's existing data-testid and disabled gating: (1) DetailPanel 'save' button (status transition + field edits); (2) create-mode +item / +milestone save; (3) BatchAnswerModal buttons batch-answer-submit, batch-answer-as-recommended, per-suggestion batch-pick-suggestion-N; (4) the detail-panel answerBox buttons. Do NOT gate non-mutating controls (show/hide archived, filter selects, column toggles, splitter, search, navigation). Keep the existing answerHasText gating (HoldButton wraps but does not bypass disabled). Update existing App tests that click these buttons to perform the hold interaction (full-hold helper) so they still drive the action."
- acceptance: Every enumerated mutating button is a HoldButton and only fires its action on a completed hold; non-mutating controls unchanged; existing answerHasText disable-gating still holds; updated App tests drive the buttons via a completed hold and pass. bun test (web) green; typecheck + lint clean.
- suggestedModel: standard
- dependsOn: ["T150"]
- ledgerRefs: ["goals:G11"]

### T152 — planned

- createdAt: 2026-06-03T15:27:09.819Z
- updatedAt: 2026-06-03T15:34:15.188Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Render sessionLogs as clickable links opening a log-content popup (web)
- description: "Per Q87 deviation. In packages/ledger-web/src/App.tsx render an item's sessionLogs (string[] of repo-relative paths) as a labeled 'logs' section where each path is a CLICKABLE link. Clicking opens a POPUP/modal that fetches the file content via the new read_log MCP tool (T147) through the existing MCP client and renders it (preformatted text; honour the tool's truncated flag with a notice). Respect the pure-MCP-client boundary - the web NEVER reads docs/ directly, only via read_log. Handle the empty case (no sessionLogs -> no section) and an error/not-found from read_log gracefully. Keep happy-dom-testable (uncontrolled where text inputs are involved; the modal open/close is state). SEQUENCING (R137 criticism #3): this task and T151 BOTH edit packages/ledger-web/src/App.tsx; to avoid concurrent isolated-worktree edits clobbering on merge-back, this task is serialized AFTER T151 (dependsOn T151) in addition to its T147 data dependency."
- acceptance: An item with sessionLogs shows clickable log links; clicking one calls read_log and shows its content in a popup; truncated logs show the truncation notice; a read_log error renders a message, not a crash. Web test (happy-dom, mocked MCP client) covers open/render/close + error. bun test (web) green; typecheck + lint clean.
- suggestedModel: standard
- dependsOn: ["T147","T151"]
- ledgerRefs: ["goals:G11"]

## M45

### T153 — planned

- createdAt: 2026-06-03T15:27:20.629Z
- updatedAt: 2026-06-03T15:40:23.709Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Amend advance.md §Provenance to permit the single run-level handoffs write
- description: |
    Per Q85. In llm/commands/advance.md the §Provenance section currently states /advance makes NO ledger writes of its own (read-only detection). Amend it to permit EXACTLY ONE write: a single run-level handoffs record at end-of-run, mapping its classification (DRAINED→drained, BLOCKED-ON-QUESTIONS→answers-required, MIXED→mixed, error/abort→illness-detected). Document that this is the ONLY write /advance performs and that all OTHER mutations remain delegated to chained sub-commands. Reference the handoffs item shape (summary required, flow, ledgerRefs, blockingQuestions, handoffReasons for 'mixed', sessionLogs, tags, sourceRefs). This is a precise prompt edit, not code.
    
    SESSIONLOGS ON THE RUN-LEVEL HANDOFF (folded in from T155 to keep advance.md single-owner): this task ALSO instructs that when /advance writes its run-level handoff record, it populates that record's sessionLogs (the docs/logs/<ts>-<agent-id>.md path(s) for the run) in the SAME create_item. This keeps the /advance handoff's sessionLogs instruction in advance.md — owned solely by this task — so T155 (which covers the per-flow plan/implement/investigate prompts) never needs to edit advance.md, leaving advance.md with a single owning edit-chain (T153 → T156).
- acceptance: advance.md §Provenance explicitly allows the one handoffs write, names the classification→status mapping, and reiterates that no other /advance write occurs. The end-of-run report section cross-references writing the handoff. Internally consistent with Q83/Q84/Q85.
- suggestedModel: frontier
- dependsOn: ["T137"]
- ledgerRefs: ["goals:G11"]

### T154 — planned

- createdAt: 2026-06-03T15:27:28.152Z
- updatedAt: 2026-06-03T15:27:32.108Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Wire per-flow handoff writes with /advance suppression
- description: "Per Q85 (b). In the per-flow command prompts (llm/commands/plan/*, implement/*, investigate/* — the flow stop points) add the instruction: when run STANDALONE, write a handoffs record at the flow's stop describing why it stopped (status from its own stop classification; summary; flow=plan|implement|investigate; ledgerRefs to stop-causing items; blockingQuestions id[] when answers-required; handoffReasons when mixed; sessionLogs). When CHAINED under /advance, SUPPRESS the per-flow handoff (a run-context signal the orchestrator passes) so only /advance writes the single run-level record (per the T-advance amendment). Define the suppression signal precisely (e.g. an env/arg the orchestrator sets) so a sub-flow can detect it. Prompt-only."
- acceptance: Each per-flow command prompt instructs a standalone handoff write AND its suppression when chained; the suppression mechanism is concrete and matches what /advance sets; no scenario yields duplicate handoffs in a single /advance run. Consistent with the advance.md amendment.
- suggestedModel: frontier
- dependsOn: ["T137","T153"]
- ledgerRefs: ["goals:G11"]

### T155 — planned

- createdAt: 2026-06-03T15:27:39.131Z
- updatedAt: 2026-06-03T15:40:14.133Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Instruct flow prompts to populate sessionLogs alongside each outcome write
- description: |
    Per Q86/Q87. In the per-flow command prompts that write per-subagent logs to docs/logs/<ts>-<agent-id>.md AND own the corresponding item mutation, add the instruction: populate the item's sessionLogs (repo-relative log path(s)) in the SAME update_item/create_item that records the work outcome — the command holds the agent-id↔item mapping at that moment. SCOPE: the per-flow prompts ONLY — the planner (llm/commands/plan/*) advancing a goal; the implement worker (llm/commands/implement/*) marking a task done + writing its review; investigate explorers (llm/commands/investigate/*) updating defects/hypothesis; and the per-flow handoff writes (T154's standalone-handoff instruction). Cover tasks/reviews/defects/hypothesis/goals/handoffs (the ledgers that now carry sessionLogs). Prompt-only; relies on the T138 schema field existing.
    
    SCOPE BOUNDARY (file-collision avoidance, full-sweep finding beyond R138): this task does NOT edit llm/commands/advance.md. The sessionLogs instruction for the /advance RUN-LEVEL handoff record is folded into T153 (which already owns the advance.md handoff-write amendment), so advance.md has a single owning chain (T153 → T156) and this task stays confined to the plan/implement/investigate prompts.
    
    SEQUENCING (full-sweep finding beyond R138): this task and T154 BOTH edit the per-flow plan/implement/investigate prompt files (T154 adds the standalone-handoff-write + /advance-suppression instruction; this task adds the sessionLogs-population instruction to those same prompts). They had no mutual dependsOn and differing dep-sets, so they were DAG-parallel on the same prompt files and would clobber on merge-back under isolated-worktree execution. This task is therefore serialized AFTER T154 (dependsOn T154): T154 establishes the handoff-write instruction in the per-flow prompts; this task then layers the sessionLogs-population instruction onto the already-amended prompts, keeping the per-flow-prompt edits strictly sequential.
- acceptance: Each relevant flow prompt instructs setting sessionLogs in the same write that records the outcome, naming the docs/logs path convention; covers exactly the work-producing ledgers that carry the field. Consistent with the schema set from T138.
- suggestedModel: standard
- dependsOn: ["T138","T154"]
- ledgerRefs: ["goals:G11"]

### T156 — planned

- createdAt: 2026-06-03T15:27:46.232Z
- updatedAt: 2026-06-03T15:34:22.217Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Add an /advance bootstrap recipe pointing at the snapshot/projection surface
- description: "Per Q79 (flow-specific recipe in the flow prompts, NOT the generic server instructions). In llm/commands/advance.md (and any shared bootstrap section the per-flow commands reuse) add a concise BOOTSTRAP RECIPE: derive the three /advance detection predicates (P-investigate actionable defects, P-plan movable-phase goals, P-implement DAG-ready tasks, + the open-questions gate) from ONE `snapshot` call (compact {id,status,summary} grouped by ledger x status), falling back to fetch_ledger compact / fts_search only for follow-up detail. This replaces the ~13-call bootstrap (evidence #1) with a documented few-call procedure and keeps the flow-specific DAG/phase logic in the prompt (per Q75). Prompt-only. SEQUENCING (R137 criticism #4): this task and T153 BOTH edit llm/commands/advance.md; to avoid concurrent isolated-worktree edits clobbering on merge-back, this task is serialized AFTER T153 (dependsOn T153) in addition to its T145 data dependency. (T154 already serializes after T153 and edits the per-flow plan/implement/investigate prompts, not advance.md - no collision.)"
- acceptance: advance.md documents a snapshot-first bootstrap deriving all predicates in ~1-2 calls, names the compact fetch_ledger fallback, and keeps DAG/phase semantics in the prompt. References the actual tool/param names shipped in W2.
- suggestedModel: standard
- dependsOn: ["T145","T153"]
- ledgerRefs: ["goals:G11"]

## M46

### T157 — planned

- createdAt: 2026-06-03T15:27:57.691Z
- updatedAt: 2026-06-03T15:27:57.691Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: Run bun run check + refresh FOD hash + verify the ergonomics win
- description: "Final integration gate for G11. Run `bun run check` (bun test + tsc -b + eslint) from the repo root across the whole workspace and resolve any cross-package breakage from the schema/tool/web/prompt changes. If bun.lock changed (unlikely — no new deps expected), refresh the flake.nix FOD hash per CLAUDE.md (set outputHash to 52 A's, nix build .#node-modules, paste the got: hash). Operationally VERIFY the goal's motivating wins: (a) `snapshot` returns the full actionable set in ONE call (vs ~13); (b) `fetch_ledger compact` over the goals + questions ledgers fits under the tool-output limit that previously overflowed; (c) reopen_item + unarchive_item recover a terminal/archived item; (d) handoffs ledger bootstraps + accepts a record; (e) the web hold-gate + sessionLogs popup work in their tests."
- acceptance: bun run check is green across the workspace. The five operational checks (a–e) are each demonstrated (test or documented command + observed output). flake FOD hash current if bun.lock changed. No regressions in pre-existing suites.
- suggestedModel: frontier
- dependsOn: ["T138","T140","T148","T149","T151","T152","T154","T155","T156"]
- ledgerRefs: ["goals:G11"]
