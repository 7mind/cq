---
ledger: reviews
counters:
  milestone: 0
  item: 124
archives:
  - id: M5
    path: ./archive/reviews/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
    title: ""
    status: ""
  - id: M6
    path: ./archive/reviews/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
    title: ""
    status: ""
  - id: M7
    path: ./archive/reviews/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
    title: ""
    status: ""
  - id: M8
    path: ./archive/reviews/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
    title: ""
    status: ""
  - id: M9
    path: ./archive/reviews/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
    title: ""
    status: ""
  - id: M12
    path: ./archive/reviews/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
    title: ""
    status: ""
  - id: M13
    path: ./archive/reviews/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
    title: ""
    status: ""
  - id: M16
    path: ./archive/reviews/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
    title: ""
    status: ""
  - id: M17
    path: ./archive/reviews/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
    title: ""
    status: ""
  - id: M19
    path: ./archive/reviews/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
    title: ""
    status: ""
  - id: M14
    path: ./archive/reviews/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: ""
    status: ""
  - id: M18
    path: ./archive/reviews/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: ""
    status: ""
  - id: M22
    path: ./archive/reviews/M22.md
    summary: G4-W D2 backup-and-reinit — COMPLETE. T94 backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant, fresh canonical + WARNING); T95 init() !schemasEqual branch → backup-and-reinit by default + onSchemaDivergence:'abort' opt-out; T96 tests (divergence/abort/no-divergence/empty-dir) + abort-suite migration; T97 repo gate. Defect D2 RESOLVED. Reviews R80/R85/R89/R91. Shipped on main; check 661.
    title: ""
    status: ""
  - id: M24
    path: ./archive/reviews/M24.md
    summary: G5 Fix Unit A @cq/ledger packaging — COMPLETE. T98 realigned package.json main+exports → ./dist/src/* (consistent w/ ./columns); T99 browser-safe ./constants subpath export + web tsconfig paths; T100 App.tsx consumes @cq/ledger/constants, deletes MILESTONE_STATUS_SCHEMA dup; T101 package-exports.test.ts (asserts all export targets exist post-build). Defects D3 + D6 RESOLVED. Reviews R81/R86/R87/R88. Shipped on main.
    title: ""
    status: ""
  - id: M25
    path: ./archive/reviews/M25.md
    summary: G5 Fix Unit B column eligibility — COMPLETE. T102 added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence) + first columns.test.ts; suggestedModel still eligible. Defect D4 RESOLVED. Review R82. Shipped on main.
    title: ""
    status: ""
  - id: M26
    path: ./archive/reviews/M26.md
    summary: "G5 Fix Unit C archived-head status badge — COMPLETE. T104 passes archived pointer status as milestoneStatus to the archived MilestoneSubsection (empty-status guarded) → T80 badge renders for archived heads; happy-dom test. T103 withdrawn (R77: no @cq/shared wire mirror — T91's ArchivePointer.status flows over the wire as-is). Defect D5 RESOLVED. Review R92. Shipped on main; check 661."
    title: ""
    status: ""
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
---

# reviews

## M1

### R1 — go-ahead

- createdAt: 2026-06-01T19:54:45.270Z
- updatedAt: 2026-06-01T19:54:45.270Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- criticism: ["Q5 'no cap' needs concrete ill-loop signals + a high absolute safety ceiling, else infinite spend if detection misfires — folded into T9 acceptance.","suggestedModel values are Claude-only aliases; portability requires a tier vocabulary mapped per-host — made the foundational T4 decision.","Codex has no native subagent worktree isolation; advance command must branch (Claude native / Codex manual) — folded into T4 + T9.","/implement:advance must be idempotent/resumable and flip blocked->planned when a blocking question is answered — folded into T9.","Fresh worktrees may lack node_modules; worker must ensure deps before `bun run check` — folded into T5.","Per-round reviews would flood the ledger; orchestrator records one terminal review per task — folded into T6."]
- new_questions: []
- ledgerRefs: ["goals:G1"]

### R3 — revise

- createdAt: 2026-06-01T23:21:22.478Z
- updatedAt: 2026-06-01T23:21:22.478Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["T27 mis-grounds summarize() as a shared util: it is duplicated VERBATIM in packages/ledger-tui/src/app.tsx:63 and packages/ledger-web/src/App.tsx:110 (both bodies: f[\"headline\"] ?? f[\"title\"] ?? f[\"question\"] ?? f[\"summary\"] ?? Object.values(f)[0]). T27's description assumes one shared location and its acceptance only names happy-dom WEB tests. The TUI copy ALSO falls through to the long criticism string[] for legacy reviews and needs the same truncate-first-criticism fallback. Fix: scope BOTH summarize() copies in T27 (or split a TUI-summarize subtask), and add an ink-testing-library assertion that a legacy review with no summary renders a truncated single line in the TUI, not the full joined criticism. As written, Req5 is only half-delivered for the TUI.","T34 bundles an objective automated gate (bun run check) with five manual observed-vs-expected smoke checks into one mega-task; the manual halves are not independently verifiable. Where feasible, fold each request's verification into the per-task acceptance tests it already owns (T30/T31/T32/T33/T27 each name happy-dom or ink tests) and reduce T34 to the green-check gate plus any cross-cutting regression assertion, rather than a manual five-point sweep.","T26 acceptance overstates the canonical-ledgers test: that test (packages/ledger/test/canonical-ledgers.test.ts) does NOT assert an exact reviews field-SET — it exercises specific fields plus a schema-divergence guard across docs/ledgers.yaml + examples/sample-ledger + the lib constant. Adding optional summary keeps it green but is not 'verified' by it. Either add an explicit assertion that REVIEWS_SCHEMA.fields.summary exists (type string, required:false) and that all three registry copies declare it, or reword T26's acceptance to claim only divergence-guard parity, not field-set assertion."]
- ledgerRefs: ["goals:G1"]

### R4 — go-ahead

- createdAt: 2026-06-01T23:23:52.315Z
- updatedAt: 2026-06-01T23:23:52.315Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G1"]

### R5 — revise

- createdAt: 2026-06-01T23:41:46.802Z
- updatedAt: 2026-06-01T23:41:46.802Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["T37 (and the T35 decision lock) under-specify the investigation->planning handoff and conflate two incompatible mechanisms. T37 acceptance says on a confirmed root cause /investigate:advance should 'HAND OFF to plan-flow ... then the standard plan-advance<->plan-reviewer cycle produces reviewed fix tasks'. But /plan:advance (llm/commands/plan/advance.md) IS itself a command whose body runs the planner<->reviewer loop by spawning plan-advance/plan-reviewer subagents; a command cannot invoke another command's loop. So 'run the cycle' resolves to EITHER (a) /investigate:advance re-implements the plan loop inline (duplicates the loop that already lives in /plan:advance, and contradicts the Q26 file-and-defer integration principle the rest of the plan adopts), OR (b) it writes rootCause/suggestedFix, creates/extends the goal, and DEFERS to the user to run /plan:advance. The plan must pick (b) explicitly (consistent with Q26 file-and-defer + resumability) and state it in both T35's locked decision and T37's acceptance; as written the executor could build either.","T37/T35 do not specify the clarify-skip for the seeded goal. Q25 hands a defect with an ALREADY-confirmed root cause to plan-flow, but /plan:start and /plan:follow-up both re-open the goal to `clarifying` and spawn plan-advance for a FRESH clarifying round (llm/commands/plan/{start,follow-up}.md). Re-clarifying a defect whose root cause is confirmed is redundant. The handoff task must state how the seeded goal enters planning without a wasted clarifying round (e.g. seed the goal description with the confirmed root cause + suggestedFix so plan-advance has nothing left to clarify, or document that the planner may skip clarification when the goal is defect-seeded). Currently neither T35 nor T37 addresses this, leaving the executor to guess.","Cross-milestone dependency on the #1 follow-up (M6) is unstated and risks a same-file conflict. T42 edits implement-reviewer.md's returned-JSON contract to add `defects[]`, and its description asserts the contract 'currently' carries 'taskId/verdict/criticism/questions/rationale, plus the `summary` from the #1 follow-up'. But M6/T28 (the task that adds `summary` to that exact JSON contract) is still `planned`, and M8 dependsOn M7 ONLY (not M6). If M8 runs before M6/T28, T42's stated premise is false and two tasks edit the same JSON block in implement-reviewer.md independently. Either add M6 (or T28) to T42/M8's dependsOn, or reword T42 so its acceptance does not presuppose the `summary` field already exists (state the defects[] addition is independent of the summary work). Same applies to T40/T28 both editing plan-reviewer.md.","T44 acceptance is not operationally verifiable, repeating the defect R3 already flagged on the old T34. Its acceptance is 'A short written audit (in the task completion / PR description) confirming the closed loop ... with any drift corrected' plus 'no contradictory routing language remains' - a subjective prose deliverable, not a checkable command/invariant. The only mechanical clause is `bun run check` green (which a markdown-only consistency task cannot actually exercise for routing correctness). Tighten the acceptance to a verifiable form: e.g. a grep-able invariant (every fix task references `defects:` in ledgerRefs; no prompt instructs implement to execute a defect directly; the `[correct]`/`[incorrect]` evidence convention string appears identically in investigate-explorer + investigate/advance), so the audit's conclusion rests on enumerable checks rather than a narrative."]
- ledgerRefs: ["goals:G1"]

### R6 — go-ahead

- createdAt: 2026-06-01T23:45:46.867Z
- updatedAt: 2026-06-01T23:45:46.867Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G1"]

## M10

### R29 — revise

- createdAt: 2026-06-02T08:52:22.071Z
- updatedAt: 2026-06-02T08:52:22.071Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["VERDICT: Plan covers all 8 in-scope items (T50-T68), is well-grounded against source, correctly sequenced, and Q31's field order (context BEFORE suggestions) plus the #6/#8 shared bucket->hex palette design are encoded correctly. Three under-specified acceptances need tightening before build (below).","T65/T66 (#7 title seam) is under-specified about HOW the displayName reaches the client. Verified: buildServer(store) constructs `new McpServer(SERVER_INFO,{instructions})` where SERVER_INFO is a module constant {name,version} and buildServer receives only `store`, NOT cwd (packages/ledger-mcp/src/main.ts L49,L183-190); the server.ts the planner could not find does not exist (main.ts is the wiring). To surface basename(--cwd), T65 must thread `cwd` into buildServer/attachMcpHttp AND into the embedded TUI (in-memory transport) and embedded web (co-hosted /mcp) hosts that call them. The MCP Implementation/serverInfo type carries only name/version/title, so the displayName must ride in name/title or in `instructions`; T66's McpLedgerClient must read it via the SDK (client.getServerVersion()/getInstructions()). Add to T65 acceptance: cwd is threaded into buildServer and the basename rides a NAMED carrier (serverInfo.title or instructions). Add to T66: the real client reads that exact carrier (not just the fake).","T54 (#4 array-editor delimiter) defers the id[] delimiter decision to the implementer ('id[] only if it does not regress ... choose one rule and apply identically'). dependsOn/blockedBy are id[] (COMMON_REF_FIELDS) and existing multi-id entry/tests may rely on comma-splitting. The plan must DECIDE the id[] rule (lowest-risk: keep comma for id[], switch only string[] to semicolon/newline) rather than leaving 'choose one rule' inside the task - that is an unscoped decision embedded in a task.","T55 (#4 one-shot normalize) declares dependsOn:T54 but the normalize must split existing array ELEMENTS directly (each element on semicolons/newlines) to stay idempotent and independent of T54's editor-parser change; re-running update_item through a parseFieldValue that now also splits could double-process or behave inconsistently. Make T55's description explicit that it operates on stored array elements, not by re-invoking the editor parse path, so its asserted idempotence holds."]
- ledgerRefs: ["goals:G2"]

### R30 — go-ahead

- createdAt: 2026-06-02T08:56:40.404Z
- updatedAt: 2026-06-02T08:56:40.404Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["VERDICT (go-ahead): the revision resolves all three R29 under-specification criticisms; the plan (T50-T68) is fine-grained, correctly sequenced, testable, grounded against source, and complete for the 8 in-scope items. No new defects, no out-of-scope faults. Verification detail follows.","R29 #1 RESOLVED (T65/T66, #7 title seam). Confirmed against packages/ledger-mcp/src/main.ts: buildServer(store) at L183 takes ONLY store (no cwd); SERVER_INFO={name,version} module const at L49; the referenced server.ts does not exist (main.ts is the wiring). T65 now threads cwd/displayName into buildServer and ALL four real call sites: stdio (L366), attachMcpHttp's inner buildServer (L258), embedded TUI in-memory host (packages/ledger-tui/src/mcpClient.ts L81, where embedded(cwd) already has cwd in scope), and embedded web co-hosted /mcp (packages/ledger-web/src/serve.ts via attachMcpHttp). NAMED carrier decided (serverInfo.title primary, instructions fallback) rather than left open. T66's read path is real: both McpLedgerClient classes wrap a private SDK Client, so getServerVersion() (Implementation.title) / getInstructions() are reachable, and T66 requires the client read the SAME carrier T65 wrote (not just the fake). The instructions fallback correctly hedges an SDK build that omits Implementation.title.","R29 #2 RESOLVED (T54, #4 delimiter). The id[] decision is now DECIDED in the task, not deferred: string[] splits on semicolon/newline, id[] KEEPS comma. Grounded against the identical parseFieldValue in both UIs (web App.tsx L144-149, TUI app.tsx L90-95) which today comma-split both string[] and id[]; suggestions is string[] (constants.ts L193) and dependsOn/blockedBy are id[] (COMMON_REF_FIELDS), so the split-by-type rule lands on the right fields. Lowest-risk, no id[] regression surface.","R29 #3 RESOLVED (T55, #4 normalize). dependsOn is now cleared to [] (stale [T54] removed, confirmed on the item). The task and acceptance now state normalization splits stored array ELEMENTS directly (not via parseFieldValue), making it idempotent by construction (already-split elements carry no semicolons/newlines; second run diffs to empty) and independent of T54's editor-parser change."]
- ledgerRefs: ["goals:G2"]

### R33 — go-ahead

- createdAt: 2026-06-02T10:39:57.990Z
- updatedAt: 2026-06-02T10:39:57.990Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["GO-AHEAD. G2 follow-up plan (T79-T89 across M18/M19) is fine-grained, correctly sequenced, operationally testable, and grounded in verified source (App.tsx ItemTable L1283-1354 / ArchiveSection L1404-1484; TUI render path per Q49). Every task encodes the user's literal answer: T83/T84 (#12) implement the user's DEVIATION (Q48: 'flat list without subsections - as milestones list'), suppressing coordination subsections and rendering fields.milestones, NOT the planner's keep-grouping recommendation. T79 (#9, Q38) unifies archived groups into the collapsible-section renderer with an archived badge, default-collapsed + lazy-fetch on first expand (preserves the read-only/per-pointer fetch shipped in T32, drops the pointer-button path). T80/T81 (#10, Q40) correctly depend on the shared M12 palette (T80->T52 web BUCKET_HEX/CSS vars; T81->T51 TUI warning bucket) and reuse statusBucket+lw-status-<bucket> / statusColor with the milestones schema threaded in -- no new divergent color map. T82 (#11, Q41) is the standalone web-only colgroup CSS fix, independent of T60-T62. T85 (#13, Q49) acceptance is operationally verifiable -- instrument builder call counts and assert zero additional invocations on a pure cursor move, reproduction-first at N~500/1000 -- not 'make it faster'; its deps [T62,T81,T84] are justified, not over-coupled (all three mutate the TUI render path the useMemo keys must cover, so memoizing must land after them). T86/T87 (#14, Q50) immediate-save pick controls depend on the suggestions-list T56/T57, questions-ledger only. T88/T89 (#15, Q51) gate on the onInput non-whitespace signal (uncontrolled textarea, happy-dom-testable) / persisted-answer-non-empty inert keys, covering the batch modal, depending on #14 (T86/T87) + batch (T63/T64). Scope is complete: web/TUI split matches the answered scope exactly (#9/#11 web-only per Q39/Q41, #13 TUI-only, rest both). The plan adds dependency edges INTO the approved T50-T68 (R30/K9) without disturbing them. No planner-fixable defects, no user-only gaps, no out-of-scope defects to file."]

### R73 — revise

- createdAt: 2026-06-02T16:24:09.615Z
- updatedAt: 2026-06-02T16:24:09.615Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["REVISE. G2 follow-up #4 plan (M21: T90-T93, defects D7/D8) maps all four items 16/17/18/19, is correctly sequenced, and is well-grounded against source on items 16/17/18; two planner-fixable nits below. VERIFIED CORRECT: #16/T90 — ArchiveSubsections render site (App.tsx L1193) is gated only on showArchive+archivePointers, NOT on isMilestones (which IS in scope, L1232/L1246/L1258); adding `&& !isMilestones` is surgical and preserves the T79 unification for non-milestones (renderer at L1916-2019, tested app.test.tsx L688-722). #17/T91 — active head uses ms.title (L1847) vs archived head uses p.summary=description (L2000); fix is real. #18/T92 vs K13 — only implement/advance.md §3 (L103-108) actually contains a `/investigate:start <D>` routing-question step to DELETE; plan/advance.md (LEDGER-QUERY worklist L87-98, no routing-question) and plan-reviewer.md (defects[] report-only, L62-78) ALREADY conform, and T92's acceptance correctly treats those two as confirm/guard. One-time cleanup confirmed: Q52/Q53 withdrawn with full D3-D6 triage preserved on the defect records — no information loss, non-blocking file-and-defer retained. T92/T93 (prompts/CSS) are disjoint from T90→T91 (same App.tsx archive path) and parallel-safe; M21 dependsOn M19 is appropriate.","T93 (item 19) is mis-grounded: its description tells the implementer to 'tune the existing .lw-batch* rules' (width/max-width, height/max-height, font-size on `.lw-batch` / `.lw-batch-body`), but packages/ledger-web/src/styles.css (full 763-line file) contains NO `.lw-batch`, `.lw-batch-body`, or `.lw-batch-nav` rule at all. The batch modal (T63, done, commit e677b77) reused the HelpOverlay backdrop pattern; `.lw-batch` exists only as a MARKER class on the dialog element (app.test.tsx L1039 queries q('.lw-batch')) with no CSS rule backing it, and `.lw-batch-body`/`.lw-batch-nav` classes are unconfirmed anywhere (no test references them). Re-ground T93: state the work is to ADD/define `.lw-batch*` sizing rules (not 'tune' pre-existing ones), and confirm against the actual BatchAnswerModal markup which element(s) carry the box/body/nav classes the rules must target. The acceptance (assert width/height/font-size resolve to the new values via computed style or the literal CSS rule) is otherwise operational and survives the fix.","T91 (item 17) acceptance under-specifies the collapsed-head case and so does not truly leave the title-source mechanism free. Archived sections default COLLAPSED and lazy-fetch their group content (ArchiveSubsections App.tsx L1939-1981; app.test.tsx L724-754). The lazy-content option (deriving title from c.milestone.title) only populates AFTER first expand — so a COLLAPSED archived head built that way would show p.id or p.summary (description), NOT the title. The acceptance 'an archived section head displays the milestone title' is satisfiable on a collapsed head ONLY by the ArchivePointer-payload option (add `title` to the pointer; App.tsx L1932 + packages/ledger/src/types.ts ArchivePointer @ L155 + the server build). Pin the acceptance to assert the title shows on a COLLAPSED (un-expanded) archived head, which effectively forces the payload-extension path rather than leaving it 'implementer's choice'. NON-BLOCKING NOTE (not a new defect): open defect D5 already proposes adding the milestone STATUS to the same ArchivePointer/archive-group payload over MCP — coordinating T91's `title` extension with D5's `status` on the one ArchivePointer shape change would avoid two boundary edits; D5 stays deferred."]
- ledgerRefs: ["goals:G2"]

### R74 — go-ahead

- createdAt: 2026-06-02T16:28:39.618Z
- updatedAt: 2026-06-02T16:28:39.618Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["GO-AHEAD (round 2). Both R73 (revise) criticisms are genuinely resolved against source; the G2 follow-up #4 plan (M21: T90-T93, defects D7/D8) is fine-grained, correctly sequenced, testable, grounded, and complete for items 16/17/18/19. No new defects, no out-of-scope faults to file. Verification detail follows.","R73 #1 RESOLVED (T93 / item 19). Verified packages/ledger-web/src/styles.css (read L280-762, covering all overlay/dialog/modal/table regions) contains NO `.lw-batch`, `.lw-batch-body`, or `.lw-batch-nav` rule. The revised T93 description now states explicitly the work is to ADD/DEFINE new batch-modal sizing rules (not 'tune' pre-existing ones), specifies an explicit wider+taller box via vw/vh caps, a reduced font-size, and a body overflow-scroll rule for long questions, and instructs the implementer to FIRST confirm against the actual BatchAnswerModal JSX which element(s) carry the box/body/nav classes the rules must target (correct, since `.lw-batch` is a marker class with no backing rule). The acceptance (assert width/height/font-size resolve to the new values + body scroll, via computed style or the literal CSS rule under happy-dom) is operational and survives the re-grounding.","R73 #2 RESOLVED (T91 / item 17). Verified packages/ledger/src/types.ts ArchivePointer @ L155-162 is `{id, path, summary}` — no `title`, no `status`; and packages/ledger-web/src/App.tsx L2000 builds the archived head label from `p.summary` (= milestone description) for BOTH collapsed and expanded states, with group content (c) only lazy-fetched on expand. The revised T91 now states the title-source mechanism is NOT implementer's choice — it MUST extend the ArchivePointer payload (add `title` to types.ts + populate it in the server's archivePointer build, then use p.title) — and pins the acceptance to a COLLAPSED (un-expanded) archived head showing the milestone `title` (not description). This is satisfiable on a collapsed head ONLY via the payload extension (lazy c.milestone.title would not be populated pre-expand), so the acceptance genuinely forces the right path.","D5 COORDINATION COHERENT (T91). T91 now lands BOTH `title` (its own item 17 / D8 fix) and `status` (D5's prerequisite) in ONE ArchivePointer-payload + server-build edit; T91 ledgerRefs now include defects:D5. Verified D5 (open, severity low, M18) requires exactly this payload extension to carry the milestone terminal status for the #10 archived-head status badge. D5 stays open for its consuming badge-render work but its payload prerequisite is satisfied here — neither orphaned (D5 still tracks the render) nor double-implemented (T91 adds only the payload field, not the badge render). The added `status` field is bounded additive scope on one shape, not an unscoped task.","COVERAGE/SEQUENCING INTACT. Items 16 (T90/D7: gate ArchiveSubsections on !isMilestones — render site App.tsx ~L1193 gated only on showArchive+archivePointers, isMilestones in scope), 17 (T91/D8), 18 (T92), 19 (T93) all still covered. Item 18/T92 vs K13: verified llm/commands/implement/advance.md §3 L103-108 contains the ONLY real `/investigate:start <D>` routing-question creation step to delete, matching K13 (locked) and T92's revised grounding; plan/advance.md (ledger-query worklist) + plan-reviewer.md (report-only defects[]) already conform (verify-no-op), and the Q52/Q53 one-time cleanup is already done with D3-D6 triage preserved on the defect records. Sequencing sound: T90->T91 serialize (same App.tsx archive path); T92 (prompts) + T93 (CSS-only) disjoint and parallel-safe; M21 dependsOn M19."]
- ledgerRefs: ["goals:G2"]

## M27

### R93 — revise

- createdAt: 2026-06-02T19:55:45.077Z
- updatedAt: 2026-06-02T19:55:45.077Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["Verdict: coverage/sequencing/files all correct (D9->T105, D10->T106, D11->T107; bidirectional defect.dependsOn; file-disjoint, no inter-task deps = parallel-safe); two planner-fixable grounding/acceptance gaps keep this on revise.","T106 (D10): the acceptance 'would FAIL against pre-T91 InMemory' only holds if the rejected archiveMilestone is rejected by the Phase-1b milestone-item-non-terminal gate (all non-milestones group items terminal, milestone-item still open) -- exactly the store-abstract.ts:261 scenario after updateItem(it1, resolved). If the test instead rejects via Phase-1 (a non-terminal GROUP item), no Phase-2 mutation ever runs and the assertion passes even pre-T91, making it a non-reproduction. Pin the scenario explicitly in the task: all group items terminal + milestone-item non-terminal, then assert the non-milestones groups remain attached. Otherwise the reproduction claim in the acceptance is not guaranteed. (Confirmed against InMemoryLedgerStore.ts:464-497 Phase-1b guard running before Phase-2 at line 500.)","T105 (D9): the root-cause framing ('the client connects before the server confirms listening') is imprecise -- the flaky harness in mcpClient.test.ts:27-58 and displayName.test.ts:49-75 ALREADY runs a GET-based waitForServer readiness probe before McpLedgerClient.connect. The more plausible flake mechanism is the FIXED ports (7793/7795) colliding under concurrency and/or the GET probe returning before the MCP session layer is ready. The proposed fix (ephemeral port + readiness probe) is correct AND already proven in-repo: pty.e2e.test.ts:49-76 implements freePort() (bind :0, read assigned port) + waitForPort() (raw TCP connect). The task should (a) reference that existing precedent to reuse rather than reinvent, (b) prefer the TCP-connect readiness probe over the bare-GET probe, and (c) note freePort()'s bind-then-close TOCTOU window, so binding :0 and reading the port without an intermediate close (or retry-on-EADDRINUSE) avoids merely relocating the race."]
- ledgerRefs: ["goals:G6"]

### R94 — go-ahead

- createdAt: 2026-06-02T20:00:04.457Z
- updatedAt: 2026-06-02T20:00:04.457Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G6"]
- tags: ["round-2","go-ahead","both-R93-criticisms-resolved"]

### R95 — revise

- createdAt: 2026-06-02T20:41:16.475Z
- updatedAt: 2026-06-02T20:41:16.475Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "T108 is correctly scoped/sequenced/disjoint, but its grounding premise is false for live data: pre-T91 archive pointers carry EMPTY title/status on disk, so the planned rows won't show titles — T108 as written does not fix D12 issue 1."
- new_questions: []
- criticism: ["T108 GROUNDING GAP (blocking): T108 relies on 'the ArchivePointer title + status that T91 landed' to render each archived-milestone row's title + badge. Verified against LIVE data: fetch_ledger('milestones') returns ALL 23 archive pointers (M2..M26) with title:\"\" and status:\"\", and docs/milestones.md persists each `archives:` entry with ONLY id/path/summary — no title/status field. T91 added the fields to the ArchivePointer TYPE and populates them at ARCHIVE TIME going forward, but every PRE-T91 archived milestone on disk lacks them, so fetch_ledger reconstructs empty strings. Consequence: T108's rows would fall back to the bare id (headerLabel logic `p.title.length>0 ? ... : p.id`, App.tsx:1990) and show NO title — which is exactly user-reported D12 issue 1 ('titles never appear'). T108 therefore does NOT achieve D12's stated outcome for the data the user actually sees. The archived .md files DO contain the title (e.g. docs/archive/milestones/M2.md line 5 `title: TUI + web UI improvements`, header `### M2 — done`), so the data is recoverable. FIX the plan: T108 (or a prerequisite task) must backfill / read-side reconstruct ArchivePointer.title+status for legacy pointers (from the archive .md, or a one-shot migration of docs/milestones.md `archives:` entries), so real archived rows show titles. As written this is in the ledger library (FsLedgerStore pointer read / materialiseFetchedLedger), NOT App.tsx — which also breaks T108's 'file is App.tsx only / disjoint from D9/D10/D11' parallel-safety claim, since the real fix touches packages/ledger (the same area as T106's store-abstract.ts).","T108 ACCEPTANCE is a non-reproduction of the user's issue: the happy-dom test as specified ('renders an archived milestone as a single titled row carrying the archived badge') would construct a fake pointer WITH a title and pass, while the real app still shows blank titles for every actual archived milestone. Acceptance must pin the legacy case — assert a row renders the correct title for an archive pointer that, as persisted pre-T91, lacks an inline title (i.e. exercise the backfill/reconstruction path), AND assert the status badge — to genuinely reproduce D12 issue 1.","T108 GROUNDING (minor): the task says 'list each archived milestone as a ROW in the flat ItemTable' but the ItemTable component (App.tsx:1687-1816) receives neither `view.archivePointers` nor `showArchive` nor a lazy-fetch handler — its signature only takes `groups`/`isMilestones`. The task should state that ItemTable's props must be extended (archivePointers + showArchive + an onSelectArchive/fetchArchive callback) and that the archived rows must produce a Row routed to setSelectedArchiveRow (App.tsx:1230-1240, isArchived=true) — the existing flat-milestones <table> renders Items with milestone/id/status/summary columns, which does not map onto an ArchivePointer; specify the row shape."]
- ledgerRefs: ["goals:G6"]

### R96 — revise

- createdAt: 2026-06-02T20:48:30.565Z
- updatedAt: 2026-06-02T20:48:30.565Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "R95 criticisms 2+3 resolved (acceptance now exercises the T109 backfill; ItemTable wiring fully specified). Criticism 1's residue: T109 mislocates the backfill against the SYNCHRONOUS fetch()/materialiseFetchedLedger contract — its preferred 'read-side reconstruction per fetch' is not implementable as written."
- new_questions: []
- criticism: ["T109 FIX-LOCUS GAP (blocking, grounded): T109 option (a) 'read-side reconstruction in the store's archive-pointer read ... by reading the referenced archive .md at pointer.path ... per fetch' is NOT implementable at the read path that actually produces fetch_ledger('milestones').archivePointers. CONFIRMED against live source: LedgerStore.fetch() is SYNCHRONOUS (LedgerStore.ts:121,130 'reads are sync in-memory unless they touch disk'); FsLedgerStore.fetch() (FsLedgerStore.ts:385-390) returns materialiseFetchedLedger(...) which is a synchronous, FS-free, pure function (InMemoryLedgerStore.ts:570-609) whose archivePointers are just `ledger.archivePointers.map(p=>({...p}))` (line 607). Reading a .md at pointer.path is async I/O and CANNOT happen inside the sync fetch() without either (i) making fetch() async — an interface + ripple change to BOTH adapters and every caller that T109 does NOT scope and that contradicts the documented sync contract — or (ii) backfilling at init() time. FIX the task: name the backfill locus precisely as FsLedgerStore.init() (already async, already reads each archive .md via collectArchivedItems()->fetchArchive(), FsLedgerStore.ts:244-254/432-448), reconstructing title/status from the archive .md (parseArchive already yields the milestone; the `title:` line + `### <id> — <status>` header are available) and CACHING them onto the in-memory ledger.archivePointers so the synchronous fetch() returns them. This is feasible and reuses an existing precedent — but T109 as written points at the wrong boundary (per-fetch read) and is not directly buildable.","T109 MISDIRECTING CANDIDATE LOCUS (planner-fixable): T109 lists 'materialiseFetchedLedger' as a candidate site for the backfill. materialiseFetchedLedger is SHARED with InMemoryLedgerStore (imported by FsLedgerStore from InMemoryLedgerStore.ts) and is synchronous + FS-free; the in-memory adapter has NO pointer.path-on-disk (it stores archive groups in Maps), so a .md read there is impossible and would break the very FsLedgerStore/InMemoryLedgerStore parity that D10/T106 is about. Remove materialiseFetchedLedger from the candidate set and pin the fix to the FS adapter's init-time archive read; state explicitly that the in-memory adapter's archivePointers are populated differently (so the T109 reproduction test must target the FS adapter, or seed an in-memory pointer with title/status directly).","T109 ACCEPTANCE PRECISION (minor, planner-fixable): the reproduction acceptance ('a packages/ledger test ... given an archive pointer persisted WITHOUT inline title/status but WITH an archive .md carrying them, the materialised ArchivePointer carries the reconstructed title+status; FAILS before the fix') is sound ONLY against the FS adapter (which has an on-disk archive .md). Pin the test to FsLedgerStore with a fixture: an `archives:` entry lacking title/status PLUS a docs/archive/milestones/<id>.md carrying `title:` + `### <id> — <status>`, asserting fetch('milestones').archivePointers[i].{title,status} are reconstructed non-empty. Keep the fail-soft assertion (missing/malformed archive .md => empty, no throw)."]
- ledgerRefs: ["goals:G6"]

### R97 — go-ahead

- createdAt: 2026-06-02T20:52:37.058Z
- updatedAt: 2026-06-02T20:52:37.058Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- summary: "R96 residue resolved: T109 now relocates the legacy ArchivePointer title/status backfill to async FsLedgerStore.init() (FS-only), forbids touching materialiseFetchedLedger/InMemory (preserving D10/T106 parity), with a reproduction-first FS-fixture acceptance — verified buildable against live source. Plan sound; go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G6"]

### R111 — revise

- createdAt: 2026-06-03T00:49:13.162Z
- updatedAt: 2026-06-03T00:49:13.162Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: Plan is faithful to Q55-Q72 on shape (state set, transitions, /advance semantics, reset, sweep) and well-grounded against constants.ts/main.ts/FsLedgerStore/link-prompts.ts; but #4A has a blocking transition-legality gap (no open->root-caused edge), an over-broad confirmed-node re-key that would corrupt hypothesis-tree stop predicates, and a missed abandoned->wontfix touch-point in implement/advance.md. Revise.
- new_questions: []
- criticism: ["BLOCKING (T119 / transition-legality): Q67's LOCKED transition map (verified at constants.ts:110-116 today = [open,wip,blocked,resolved,abandoned]; target per Q67 = open->{wip,resolved,wontfix}; root-caused reachable ONLY from wip) has NO open->root-caused edge. The current investigate flow (llm/commands/investigate/advance.md step 5a) NEVER sets the defect's STATUS — the lifecycle lives entirely on the hypothesis tree (status open|uncertain|confirmed|wrong); rootCause is written as the narrative cause + citations, not a marker. So T119's instruction 'a confirmed root cause sets defect STATUS = root-caused' will, for a defect still in status=open, throw InvalidTransitionError against the server's strict transition guard. FIX T119: instruct investigate to move the defect open->wip when it begins investigating (step 1/3), so the file-and-defer path is open->wip->root-caused (both edges legal per Q67). State this explicitly in T119's description and acceptance.","T120 OVER-BROAD RE-KEY (grounded, planner-fixable): 'confirmed node'/'confirmed root cause' in plan/advance.md predicates (b)/(c)/(d) (verified llm/commands/plan/advance.md:150-164) refers to the HYPOTHESIS-TREE `confirmed` status + `[correct]` evidence — the investigate adjudication and ill-loop/convergence detector — NOT a defect rootCause marker and NOT the defect lifecycle. T120's instruction to 're-key every reference to confirmed node/confirmed root cause to status==root-caused' would corrupt those hypothesis-tree stop predicates. Scope the re-key to the DEFECT-STATUS worklist gate only (plan/advance.md:92-98 worklist + plan-advance.md:248-249, currently keyed on status:open; new: include open/wip/inconclusive as actionable, EXCLUDE root-caused/resolved/wontfix), and explicitly PRESERVE the hypothesis-tree confirmed/[correct]-evidence vocabulary in predicates (b)/(c)/(d). T120's acceptance already gets the worklist semantics right; the description's blanket 'confirmed node->root-caused' is the wrong instruction.","MISSED #4A TOUCH-POINT (under-scoped): implement/advance.md:198 (Milestone completion) states defect terminal = `resolved`/`abandoned`. The locked set renames abandoned->wontfix, so this line will reference a removed status. No task covers it — T121 targets only the reviewer-filed-defects section (lines 96-117). Add implement/advance.md:198 (and any other `abandoned` defect-terminal reference in that file) to T121's (or T128's) edit scope.","T121 PREMISE OVERSTATED (minor, planner-fixable): implement/advance.md:96-117 already files reviewer defects with status:open and fields {headline,description,severity,suggestedFix?} — it writes NO rootCause marker. There is no 'CONFIRMED/UNKNOWN in rootCause' instruction to remove, so T121 as written sends the implementer hunting for a nonexistent marker. Correct T121's description: its real content is (a) confirm status=open + no removed status, and (b) fix the abandoned->wontfix reference at line 198 (per the criticism above).","T127 COMPLETENESS (minor): implement/advance.md:36 reads 'at most N = 4 workers ... (configurable — treat 4 as the default ready-batch size)'. T127's acceptance ('no remaining N = 4') must also bump the parenthetical 'treat 4 as the default' to 8, else a stale 4 survives.","T116 INTERNAL CONTRADICTION (minor): the description first lists open: [wip, root-caused, inconclusive, resolved, wontfix] then says 'follow Q67 verbatim: open->{wip, resolved, wontfix}'. The acceptance pins 'Q67 exactly' (open has NO ->root-caused/->inconclusive edge), so drop the contradictory first listing from the description to prevent the implementer encoding the wrong edge set."]
- ledgerRefs: ["goals:G6"]

### R112 — go-ahead

- createdAt: 2026-06-03T00:55:11.437Z
- updatedAt: 2026-06-03T00:55:11.437Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "All 6 R111 criticisms resolved against live source: T119 makes open->wip explicit (file-and-defer path open->wip->root-caused, Q67-legal); T120 surgically scopes the re-key to the defect-STATUS worklist/seed-gate (plan/advance.md:92-98 + plan-advance.md:248-249) and preserves the hypothesis-tree confirmed/[correct] predicates at :150-164; T121 covers abandoned->wontfix at implement/advance.md:198 and corrects the false rootCause-marker premise (reviewer defects stay status:open); T127 bumps both N=4 and the 'default ready-batch size 4' parenthetical to 8; T116 drops the contradictory open-edge listing and encodes Q67 verbatim (add root-caused+inconclusive, drop blocked, rename abandoned->wontfix) with T122 migrating live blocked/abandoned defects. Plan T116-T129 across M33/M31/M32 (M31 dependsOn M33) is fine-grained, sequenced, testable, grounded, complete, and faithful to Q55-Q72. Go-ahead."
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G6"]

## M29

### R103 — revise

- createdAt: 2026-06-02T22:55:46.312Z
- updatedAt: 2026-06-02T22:55:46.312Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: Plan well-grounded and complete (one task/defect, D13 correctly excluded), but T110's stated fix mechanism would not resolve D16's root cause — revise.
- new_questions: []
- criticism: ["T110 (D16) — the stated fix mechanism does NOT resolve the root cause and would make the (correct, reproduction-first) acceptance test FAIL post-fix. The task says 'drop the isMilestones gate so backfillLegacyArchivePointers runs for every loaded ledger' (FsLedgerStore.ts:401-402). But that method (FsLedgerStore.ts:246-272) reads ptr.path and calls parseMilestoneItemArchive(text) at L260 — which parses the milestones-ledger single-ITEM archive grammar (`### M<n> — <status>` with a `title:` field). For a non-milestones ledger, ptr.path resolves to `./archive/<name>/<id>.md`, a GROUP archive (verified: docs/archive/tasks/M12.md begins `## M12` then `### T50 — done`, carries NO milestone title — only item headlines). parseMilestoneItemArchive on a group-archive file does not extract a milestone title (group.items.length !== 1 / structural mismatch) and fails-soft to title:'' — so titles stay empty and the regression test fails post-fix. The correct fix (which the task's own suggestedFix text gestures at) must source the milestone title/status from the milestones-ledger pointer (already backfilled) OR from docs/archive/milestones/<id>.md keyed by the milestone id — NOT from the per-ledger group archive at ptr.path. T110 must specify reading the milestones-archive item, not merely ungating the existing method, and must preserve InMemory parity (no on-disk archive → no backfill) and the milestones-ledger path.","T114 (D18) — acceptance/fix says 'call answerWith(item) (same handler shape as the detail view)', but no answerWith handler exists in BatchAnswerModal scope. The detail view (App.tsx:2424-2451) uses a local answerWith that sets answer-box state; the batch modal (App.tsx:1392-1481) uses an uncontrolled textarea ref (answerRef) + onSave(row, value). Picking a suggestion in the batch modal must instead populate answerRef.current.value and set answerHasText (or call onSave(row, suggestion) directly). Specify the batch-modal binding so the implementer does not chase a nonexistent handler; also iterate individual suggestion entries (Array.isArray(sv) ? sv : [sv]) rather than the single renderVal <dd> at App.tsx:1435.","T111 (D14) — completeness: the task names 'pty.e2e + the HTTP tests' but freePort() has THREE call sites (test/pty.e2e.test.ts:71, test/displayName.test.ts:56, test/mcpClient.test.ts:38). Name all three explicitly (or confirm a signature-preserving hardening of freePort() that leaves call sites untouched) so the 'all freePort call sites updated' acceptance is unambiguous.","T115 (D19) — minor: acceptance covers the 1-question close case and 'multi-question batches still advance', but D19's suggestedFix prefers recomputing the open set post-save so MID-QUEUE answers shrink the queue / close-on-empty handles a residual snapshot correctly. Add an acceptance clause for the recompute-open-set behavior (not just clamp-then-close on the last index) so a stale batchRows snapshot does not keep a fully-answered queue open."]
- ledgerRefs: ["goals:G7"]

### R104 — go-ahead

- createdAt: 2026-06-02T22:59:22.026Z
- updatedAt: 2026-06-02T22:59:22.026Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: All four R103 criticisms resolved against live source; T110-T115 fine-grained, sequenced (App.tsx chain T113->T114->T115 via dependsOn), testable, grounded, complete — go-ahead.
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G7"]

## M33

### R113 — go-ahead

- createdAt: 2026-06-03T01:11:11.427Z
- updatedAt: 2026-06-03T01:11:11.427Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T116 approved: defects schema deep-equals locked Q66/Q67 (no open→root-caused, terminals empty, all targets declared, validateSchema accepts); tests proven discriminating via two mutations (open→root-caused, blocked); abandoned still valid in goals/tasks; check green 704/0. Out-of-scope note: wontfix missing from tui/web DROPPED bucket — covered by T117/T118 (not separately filed)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T116","goals:G6"]

### R114 — go-ahead

- createdAt: 2026-06-03T02:39:47.574Z
- updatedAt: 2026-06-03T02:39:47.574Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T117 approved: root-caused→ready, inconclusive→warning (non-terminal path), wontfix→dropped(not green); status tests 17/17. Sole check failure was the unrelated pre-existing navMemo/ledger-tui timing flake under concurrent load (D20)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T117","goals:G6"]

### R115 — go-ahead

- createdAt: 2026-06-03T02:39:56.817Z
- updatedAt: 2026-06-03T02:39:56.817Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T118 approved: web defect statuses root-caused→ready (new bucket wired through union+BUCKET_HEX+--lw-status-ready), inconclusive→warning, wontfix→dropped; discriminating happy-dom test (3/4 fail on base); tsc+eslint+targeted tests green; scope confined to ledger-web; pure-MCP-client preserved."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T118","goals:G6"]

### R116 — go-ahead

- createdAt: 2026-06-03T02:40:29.818Z
- updatedAt: 2026-06-03T02:40:29.818Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T119 approved: investigate/advance.md carries the defect lifecycle via STATUS (open→wip→{root-caused|inconclusive}, seed gate status==root-caused), rootCause narrative-only with token prohibition; all clauses match the T116 schema; hypothesis-tree vocabulary disambiguated/intact; markdown-only. Red check = unrelated flaky ledger-tui (D20)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T119","goals:G6"]

### R117 — go-ahead

- createdAt: 2026-06-03T02:40:50.653Z
- updatedAt: 2026-06-03T02:40:50.653Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T120 approved: defect-status worklist/seed-gate re-keyed exactly per T116 (open/wip/inconclusive actionable, root-caused ready-to-seed, resolved/wontfix excluded); K12 hypothesis-tree predicates (b)/(c)/(d) at advance.md ~:150-170 outside all diff hunks and intact (no blanket re-key); diff confined to the two prompt files. Red check = pre-existing/flaky ledger-tui under concurrent load (D20)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T120","goals:G6"]

### R120 — go-ahead

- createdAt: 2026-06-03T04:40:27.368Z
- updatedAt: 2026-06-03T04:40:27.368Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T121 approved: implement/advance.md:198 defect-terminal corrected to resolved/wontfix; the 8 other abandoned/blocked matches are TASK-status or dependsOn/blockedBy refs, correctly untouched; reviewer-filed-defects section unchanged; diff confined (1 file, 2 lines)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T121","goals:G6"]

## M32

### R118 — go-ahead

- createdAt: 2026-06-03T04:26:07.837Z
- updatedAt: 2026-06-03T04:26:07.837Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T123 approved: public reset() pre-counts then reuses backupAndReinit verbatim + reloads canonical via init(); targeted tests 8/8, tsc clean; test (d) asserts the post-reset canonical defect status set (proves CANONICAL reuse). One out-of-scope low defect filed (D21: non-canonical ledgers orphaned by reset)."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T123","goals:G6"]

### R121 — go-ahead

- createdAt: 2026-06-03T04:40:29.967Z
- updatedAt: 2026-06-03T04:40:29.967Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- summary: "T124 approved: --reset/--yes parseArgs honouring --cwd; confirm policy correct (--yes unattended, TTY y/Y, non-TTY-no-yes exit2 before any store constructed/no mutation); calls store.reset() prints backupDir+summary, no server started; serve paths byte-identical when --reset absent; IO-injection exercises real policy+reset against a real tmp tree; tsc + 23/0 targeted; diff confined to ledger-mcp."
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T124","goals:G6"]
