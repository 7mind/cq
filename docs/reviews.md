---
ledger: reviews
counters:
  milestone: 0
  item: 86
archives:
  - id: M5
    path: ./archive/reviews/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
  - id: M6
    path: ./archive/reviews/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
  - id: M7
    path: ./archive/reviews/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
  - id: M8
    path: ./archive/reviews/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
  - id: M9
    path: ./archive/reviews/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
  - id: M12
    path: ./archive/reviews/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
  - id: M13
    path: ./archive/reviews/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
  - id: M16
    path: ./archive/reviews/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
  - id: M17
    path: ./archive/reviews/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
  - id: M19
    path: ./archive/reviews/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
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

## M15

### R31 — revise

- createdAt: 2026-06-02T10:18:25.488Z
- updatedAt: 2026-06-02T10:18:25.488Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["VERDICT (revise): the plan (T69-T78) encodes the user's actual Q42-Q47 answers correctly (file-all-defects + orchestrator auto-launch, command-only triggers, K8 supersession not amendment, never-auto-close-goal with planned->building allowed) and is well-grounded against the live files (implement/advance.md L203 offending phrase, plan/advance.md L4/27/33/56 caps, K8 point-3 prohibition, plan-advance.md rules 5/7). Change B (M16) is sound. Change A (M17) needs the fixes below before build. No out-of-scope/pre-existing repo defects found (no `defects` to file).","[HIGHEST RISK] T74: removing the 4-iteration cap leaves the NEW auto-investigate<->replan chain (a cross-command loop: investigate confirms -> seeds goal -> plan replans -> may surface a new defect -> investigate again) WITHOUT concrete termination predicates. T74 acceptance (c) only requires generic 'model-judged ill-loop detection' and points at implement/advance.md L119-130 -- but those three signals (no file changes; criticism repeats without shrinking; same `bun run check` failure recurs) are about a SINGLE worktree's criticism rounds and do NOT translate to the cross-command auto-investigate axis. A cap-free auto-launching loop with no operationally-pinned stop for its NEW axis is a runaway-cost hazard. Fix: T74 acceptance must enumerate concrete ill-loop predicates for the auto-investigate<->replan chain specifically (e.g. the same defect D re-confirmed across rounds with no new fix tasks emitted; investigate returns no adjudicable evidence on two consecutive rounds for the same defect; the goal is re-planned with an identical task set; a defect cycles open->investigated->replanned->open without convergence) -> STOP and file an `open` questions item. 'Remove the cap' is not a stop condition.","T74: the orchestrator's auto-investigate phase is specified to run 'AFTER the per-goal planner<->reviewer round completes', but the plan does not say what happens when the round stops on `awaiting-answers` (rule 4: reviewer new_questions sent the goal back to `clarifying`) WHILE the same review's defects[] bucket was also filed (a go-ahead OR revise review may carry defects[], per plan-reviewer.md L92-95). Does auto-investigate run when the goal is simultaneously parked on user questions? Specify the interaction: either auto-investigate still runs on filed defects (they are orthogonal to the goal's clarification, per plan-advance.md L237-242) or it is deferred. As written the executor must guess.","T73/T74 data-passing is fragile and contradicts the subagent output contract. T73 has plan-advance emit a 'Filed defects for auto-investigate: D<n>' line inside its free-text `### Session summary`, and T74 parses it. But plan-advance.md L257-263 fixes the subagent's machine-readable output to a SINGLE status token on the last line; the Session summary is free prose. String-parsing a prose summary line is brittle. T74 already names the robust alternative ('open defects newly linked goals:<G> with no terminal status') -- make the LEDGER QUERY the primary (authoritative) source of the auto-investigate worklist and demote the summary flag to at most an advisory hint. Adjust T73 acceptance accordingly so it does not mandate a parse-dependent contract.","T72: the new superseding decision should state explicitly that it stands on K8 point 4 (defect-seeded clarify-skip) as well as point 3, because T74/T75's auto-resume path ('skips clarification per K8 pt4') depends on point 4 remaining in force. T72's four required points cover point 3 but do not pin that point 4 is untouched; add a one-line 'K8 points 1,2,4,5 remain in force; only point 3's handoff-direction asymmetry is refined' so the executor does not over-read the supersession.","T78 (verify) inherits the T74 gap: its grep set checks the caps are GONE ('4-iteration|8 rounds|safety ceiling') but has NO positive check that a concrete cross-chain ill-loop/termination criterion was ADDED. Add an acceptance clause to T78 that asserts plan/advance.md contains enumerated auto-investigate stop predicates (not merely the absence of a numeric cap), so removing the cap without adding a real stop cannot pass verification."]

### R32 — go-ahead

- createdAt: 2026-06-02T10:22:27.963Z
- updatedAt: 2026-06-02T10:22:27.963Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["VERDICT (go-ahead): the revised plan (T69-T78) resolves all 5 R31 criticisms and the Change A auto-investigate loop is now provably convergent via operationally-checkable stop predicates. Re-verified against the live files: plan/advance.md L27/33/56 carry the 4-iteration cap to remove, plan-advance.md L213-242 is the file-and-defer 'defects[] bucket' block to edit, and L257-263 fixes the single-status-token output contract that grounds the ledger-query-over-summary-parsing fix. (1 HIGHEST-RISK) T74 pt4 now enumerates concrete cross-chain termination predicates (a-f): once-per-defect-per-round; no-relaunch-without-new-confirmed-evidence; stop+report once a confirmed root cause seeded/extended its goal; park on non-converging open->investigated->replanned->open cycle; park after two consecutive no-adjudicable-evidence rounds; per-pass budget governed by (a)-(e). It explicitly states the generic single-worktree signals do NOT satisfy this. Acceptance (d) restates them as required. Resolved. (2) T74 pt3 specifies the awaiting-answers + defects-filed interaction: filed defects are orthogonal and still auto-investigated even when the goal is parked in `clarifying`, but planning does NOT auto-resume on a clarifying-parked goal. Resolved. (3) T73 + T74 pt2 make the LEDGER QUERY (open defects newly linked goals:<G>, no terminal status) the authoritative worklist; prose-summary parsing demoted to advisory; T73 acceptance forbids mandating any summary parse. Resolved. (4) T72 now requires the explicit 'K8 points 1,2,4,5 remain in force; only point 3 handoff-direction refined' line and pins that pt4 (defect-seeded clarify-skip) must stay because T74/T75 auto-resume depends on it; pt3's prohibition on investigate running the plan loop inline still stands. Resolved. (5) T78 pt4 adds a POSITIVE stop-predicate presence grep ('caps removed cannot pass without convergence guaranteed'); conjoined with pt3 (caps GONE) it catches the exact targeted regression of caps-removed-but-stop-condition-missing. Resolved.","CONVERGENCE PROOF (crux confirmed): within a plan:advance pass the worklist is the finite set of open defects at auto-investigate-phase entry; predicate (a) processes each at most once; new defects are only filed by the in-round planner<->reviewer loop which completes before the auto-investigate phase runs; predicate (c) halts relaunch once a defect seeds/extends a goal (planning then resumes on that goal, itself bounded by planner<->reviewer convergence); predicates (b)/(d)/(e) force a park-to-user on no-new-evidence / non-convergence / two-consecutive-no-evidence. Each predicate is a ledger-state comparison, so the stop is operationally checkable. The cap-free loop terminates.","BY-POINTER CHECK (T75/T77 do not silently reintroduce summary-parsing or drop a stop condition): T75 binds plan/start.md + follow-up.md to 'mirror plan/advance.md new phase (T-A3)' by pointer to the WHOLE T74 auto-investigate phase (which carries both the ledger-query worklist and the stop predicates) and its acceptance requires running /investigate:advance inline by pointer to that phase, not by re-deriving a worklist from a summary -- so the ledger-query authority and the stop predicates are inherited, not duplicated or weakened. T77 is wording-only, explicitly defers mechanics to T74/T75/T76, correctly keeps investigate->plan handback as file-and-defer (K8 pt3 stands) and keeps implement:* file-and-defer (Q43 names only plan:* as triggers). NON-BLOCKING NOTE for the executor (does not flip the verdict): T75 pt1 phrase 'if the plan-advance subagent flagged filed defects' should be read as the ledger-query existence check (no-op when none filed), NOT a parse of an advisory summary flag -- the binding acceptance and the by-pointer reference to T74's ledger-query phase govern; keep the trigger ledger-query-authoritative when implementing T75 to avoid re-importing the brittle summary contract R31#3 removed. Plan is fine-grained, correctly sequenced (T72 root; T73/T74 depend on it; T75/T77 depend on T74; T78 depends on all M17 tasks; M16 T69/T70->T71 independent), testable (each carries a grep/fetch/`bun run check` acceptance), grounded, and complete against the goal description. No out-of-scope/pre-existing repo defects surfaced (none to file-and-defer)."]

## M14

### R41 — go-ahead

- createdAt: 2026-06-02T11:02:05.801Z
- updatedAt: 2026-06-02T11:02:05.801Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T60","goals:G2"]
- tags: ["implement-flow","round-0"]

### R42 — go-ahead

- createdAt: 2026-06-02T11:14:54.541Z
- updatedAt: 2026-06-02T11:14:54.541Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T65","goals:G2"]
- tags: ["implement-flow","round-0"]

### R47 — go-ahead

- createdAt: 2026-06-02T11:32:51.946Z
- updatedAt: 2026-06-02T11:32:51.946Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T66","goals:G2"]
- tags: ["implement-flow","round-0"]

### R54 — go-ahead

- createdAt: 2026-06-02T12:18:20.250Z
- updatedAt: 2026-06-02T12:18:20.250Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T62","goals:G2"]
- tags: ["implement-flow","round-0"]

### R57 — go-ahead

- createdAt: 2026-06-02T12:31:10.885Z
- updatedAt: 2026-06-02T12:31:10.885Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: ["[resolved round 1] @cq/ledger/columns had no tsconfig paths→source mapping — dist-less browser bundle failed to resolve it (nix ledger-web clean-checkout break). Fixed by adding the paths entry mirroring relationships; verified dist-less bundle resolves."]
- new_questions: []
- ledgerRefs: ["tasks:T61","goals:G2"]
- tags: ["implement-flow","round-1","criticism-resolved"]

### R58 — go-ahead

- createdAt: 2026-06-02T12:48:37.209Z
- updatedAt: 2026-06-02T12:48:37.209Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T63","goals:G2"]
- tags: ["implement-flow","round-0","approve","batch-answer modal: every acceptance clause backed by real happy-dom tests; reuses MCP answer write path; check green 565"]

### R59 — go-ahead

- createdAt: 2026-06-02T12:48:39.147Z
- updatedAt: 2026-06-02T12:48:39.147Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T64","goals:G2"]
- tags: ["implement-flow","round-0","approve","batch-answer stepper: all 5 acceptance clauses tested; surgical pure-MCP-client diff; check green 565"]

### R60 — go-ahead

- createdAt: 2026-06-02T12:57:00.963Z
- updatedAt: 2026-06-02T12:57:00.963Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T67","goals:G2"]
- tags: ["implement-flow","round-0","approve","appTitle derived from client.displayName(); document.title + header both asserted; graceful pre-connect fallback; check green 567"]

### R61 — go-ahead

- createdAt: 2026-06-02T12:57:03.778Z
- updatedAt: 2026-06-02T12:57:03.778Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T68","goals:G2"]
- tags: ["implement-flow","round-0","approve","TUI header '[<displayName>] LLM ledgers' with graceful fallback; real frame assertion; layout intact; check green 567"]

## M18

### R62 — go-ahead

- createdAt: 2026-06-02T13:26:44.655Z
- updatedAt: 2026-06-02T13:26:44.655Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: ["[resolved round 1] lazy archive-fetch had no .catch — swallowed rejections, stuck on 'loading…'. Fixed: onError→setFlash via errMsg + retryable error placeholder + re-expand retries; reproduced rejection test."]
- new_questions: []
- ledgerRefs: ["tasks:T79","goals:G2"]
- tags: ["implement-flow","round-1","criticism-resolved","T79 archived-milestone unify approved at 573 green"]

### R63 — go-ahead

- createdAt: 2026-06-02T13:26:48.427Z
- updatedAt: 2026-06-02T13:26:48.427Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: ["[resolved round 1] 4 T81 tests asserted whole-frame ANSI; cyan/green leaked from selected-row + item badges (reverting source left tests green). Fixed: buildItemEntries node-prop unit tests; reproduction verified 3/4 fail without source coloring. Production code was correct."]
- new_questions: []
- ledgerRefs: ["tasks:T81","goals:G2"]
- tags: ["implement-flow","round-1","criticism-resolved","T81 milestone-header statusColor approved"]

### R64 — go-ahead

- createdAt: 2026-06-02T13:39:15.592Z
- updatedAt: 2026-06-02T13:39:15.592Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T80","goals:G2"]
- tags: ["implement-flow","round-0","approve","active head renders shared status badge via statusBucket; archived-head + schema-dup filed out-of-scope (D5/D6); check 578"]

### R65 — go-ahead

- createdAt: 2026-06-02T13:39:17.948Z
- updatedAt: 2026-06-02T13:39:17.948Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T84","goals:G2"]
- tags: ["implement-flow","round-0","approve","goals flat list + fields.milestones in content pane; other ledgers + T81 coloring unchanged; check 578"]

### R66 — go-ahead

- createdAt: 2026-06-02T14:09:59.698Z
- updatedAt: 2026-06-02T14:09:59.698Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T82","goals:G2"]
- tags: ["implement-flow","round-0","approve","single .lw-col-narrow rule + colgroup all 3 variants; col/cell counts consistent; check green"]

### R67 — go-ahead

- createdAt: 2026-06-02T14:10:03.840Z
- updatedAt: 2026-06-02T14:10:03.840Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: ["[resolved round 1] embedded NUL byte (0x00) at app.tsx:727 columnsKey join separator — corrupted source (flagged binary). Fixed: replaced with '|'.","[resolved by orchestrator integration fix] navMemo determinism guard read module-global counters without resetting — cross-file pollution failed the mount-cap (<=8) assertion in the full tui suite. Fixed: reset before measure + waitQuiescent poll; 116/0 ×3, full 584/0."]
- new_questions: []
- ledgerRefs: ["tasks:T85","goals:G2"]
- tags: ["implement-flow","round-1","criticism-resolved","memoization correct + reproduction verified"]

### R68 — go-ahead

- createdAt: 2026-06-02T14:22:17.688Z
- updatedAt: 2026-06-02T14:22:17.688Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T83","goals:G2"]
- tags: ["implement-flow","round-0","approve","goals flat + fields.milestones list; non-goal unchanged; reproduction confirmed; check 596"]

## M20

### R75 — revise

- createdAt: 2026-06-02T16:35:00.336Z
- updatedAt: 2026-06-02T16:35:00.336Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["VERDICT (revise): D2-fix plan (M22: T94-T97) is correctly root-caused, safe (backup-before-reinit, both ledger file(s) + docs/ledgers.yaml, loud WARNING, ENOENT-tolerant), and correctly sequenced (T94 helper -> T95 rewire -> T96 tests -> T97 gate); default backup-and-reinit with onSchemaDivergence:'abort' opt-out matches the user's direction; all named primitives verified to exist (freshLedger/seedBootstrapGroup/serializeRegistry as module fns; ledgerPath/registryPath/writeRegistry/writeLedgerFile/now/docsDir as fields; CANONICAL_LEDGERS; BootstrapViolationError @ types.ts:384; init() throw site @ FsLedgerStore.ts:283-289; main() awaits init() before serve @ main.ts:369). One planner-fixable defect below. No user-only gaps; no out-of-scope repo defects (the stale-global-binary limitation is correctly out-of-scope per the goal).","T96 OMITS a REQUIRED test migration that T95 will break. An EXISTING parameterized test in packages/ledger/test/canonical-ledgers.test.ts:332-356 ('divergence guard fires for a hand-edited <name> schema') runs for SIX canonical ledgers (defects/tasks/hypothesis/questions/decisions/goals): it seeds a registry whose entry has a divergent (superset) schema and asserts `await store.init()` REJECTS with /different schema/ under DEFAULT options. After T95 flips the default to backup-and-reinit (no throw on divergence), all six of these assertions INVERT and FAIL. T96's description only says 'add tests' for the new divergence-backup/abort/regression cases and never names this existing suite; its 'REGRESSION' cases cover only no-divergence and empty-dir, NOT this divergence-throw suite. T97 (`bun run check`) will surface the six failures but carries no scoped mandate to rewrite assertions ('resolve any failures introduced by the change' is too vague for what is a deliberate, EXPECTED behavior-change migration, not a defect to debug). FIX: extend T96 (and call it out explicitly) to MIGRATE canonical-ledgers.test.ts:332-356 -- either re-target each of the six cases to construct FsLedgerStore with onSchemaDivergence:'abort' (preserving the rejects-with-/different schema/ assertion, repurposing this suite as the abort-opt-out coverage), OR replace them with the new backup-and-reinit default assertion. Note this existing suite seeds only ledgers.yaml (no on-disk .md ledger file), which is why T94's ENOENT-tolerance on the ledger file is load-bearing -- the migration and T94 must stay consistent on that.","MINOR (planner-fixable, fold into T95): T95's description hedges the re-load mechanism ('re-derive this.registry from the freshly-written registry before the load loop, OR have the helper update this.registry in place'). Since T94's helper already rewrites the registry file via writeRegistry (which serializes this.registry), the helper should authoritatively update this.registry IN PLACE (the single source the load loop at FsLedgerStore.ts:294-334 iterates), and T95's acceptance should PIN that the post-reinit load loop iterates the fresh canonical registry -- not leave the executor a choice that could load stale entries. Operationally verifiable: assert init() leaves this.registry.ledgers equal to CANONICAL_LEDGERS schemas after a divergence-reinit."]
- ledgerRefs: ["goals:G4"]

### R76 — go-ahead

- createdAt: 2026-06-02T16:38:26.061Z
- updatedAt: 2026-06-02T16:38:26.061Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["VERDICT (go-ahead, round 2): both R75 criticisms genuinely resolved against source. (1) TEST MIGRATION: T96 now carries a 'MANDATORY MIGRATION (do not skip)' section naming packages/ledger/test/canonical-ledgers.test.ts:332-356 — the six-ledger parameterized 'divergence guard fires for a hand-edited <name> schema' suite (verified in source: schemas[] = DEFECTS/TASKS/HYPOTHESIS/QUESTIONS/DECISIONS/GOALS, constructs new FsLedgerStore({root:dir}), asserts rejects.toThrow(/different schema/)) — mandating re-target to new FsLedgerStore({root:dir, onSchemaDivergence:'abort'}) preserving the /different schema/ assertion; T96 acceptance explicitly states NO test asserts a DEFAULT init() throw on divergence. Resolved. (2) RE-LOAD MECHANISM: T95 now has a 'PINNED (no executor choice)' section — helper mutates this.registry in place to canonical, writeRegistry() (verified @878: serializes this.registry) writes it, load loop @294-334 (verified) iterates the fresh canonical registry; T95 acceptance asserts post-reinit this.registry.ledgers schemas == CANONICAL_LEDGERS and the in-memory loaded ledger is fresh-canonical. Resolved; mechanism is internally consistent since writeRegistry cannot persist canonical unless this.registry is canonical first.","COVERAGE (no regression): T96 asserts all four paths — default divergence->backup+reinit (no throw, backup dir holds prior ledgers.yaml + prior .md byte-for-byte, live ledger fresh-canonical, one stderr WARNING), abort opt-out (throws BootstrapViolationError, files untouched, no backup dir), no-divergence regression (unchanged, no backup), empty-dir regression (unchanged, no backup) — plus the migrated six-ledger abort suite. ENOENT-tolerance in T94 stays load-bearing and consistent with the migrated suite (which seeds only ledgers.yaml, no .md). SEQUENCING T94->T95->T96->T97 via dependsOn is coherent (helper -> rewire init() -> tests needing both behaviors -> bun run check gate). GROUNDING: all cited symbols verified — FsLedgerStoreOpts @106 (option to be added), init throw @283-289, load loop @294-334, writeRegistry @878, ledgerPath/writeLedgerFile @870-876, freshLedger @921, seedBootstrapGroup @938, BootstrapViolationError @types.ts:384; FsLedgerStore-only scope correct (InMemoryLedgerStore has no on-disk registry; the migrated suite is FsLedgerStore-specific, not dual). Plan is fine-grained, sequenced, testable, grounded, and complete. Approve."]
- ledgerRefs: ["goals:G4"]

## M23

### R77 — revise

- createdAt: 2026-06-02T17:42:46.221Z
- updatedAt: 2026-06-02T17:42:46.221Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: ["VERDICT: revise. Coverage (D3->T98/T101, D6->T99/T100, D4->T102, D5->T103/T104) is complete and defect ledgerRefs are bidirectional; Fix A and Fix B are sound; Fix C (T103) is grounded on a nonexistent @cq/shared Zod wire mirror. Details below.","T103 is built on a symbol that does not exist: there is NO @cq/shared package and NO Zod wire mirror of fetch_ledger's archivePointers[]. The server tool (packages/ledger/src/mcp/ledgerTools.ts:158-163) serialises store.fetch() via plain JSON.stringify with no output schema; the web client (packages/ledger-web/src/mcpClient.ts:116-119) does `JSON.parse(text) as FetchedLedger` with no runtime validation, and its ArchivePointer is a type-only re-export from @cq/ledger (packages/ledger-web/src/types.ts:7-18). Consequently, once T91 adds `status` to the ArchivePointer interface in packages/ledger/src/types.ts:155-162, the field already flows over the wire into the web client — there is NO separate 'wire half' to extend. The goal's own grounding ('the @cq/shared Zod mirror of archivePointers[] is the un-covered half') is factually wrong against the repo. Fix: DROP T103 as redundant, OR re-scope it to the real verifiable gap — an end-to-end round-trip assertion (e.g. extend packages/ledger-web/test/serve.test.ts or a store test) that an archived milestone's `status` survives fetch_ledger from server to client. Either way M26 loses its dependency on a fictitious wire schema.","T104 dependsOn/blockedBy T103, but T104's only real prerequisite is T91 (the ArchivePointer types+server-build data). Since T103 rests on a nonexistent package, T104's dependency chain is contaminated: re-point T104 to dependsOn T91 directly (M26 already dependsOn M21 for T91). T104's render fix itself is correct — passing p.status as milestoneStatus to the archived MilestoneSubsection (packages/ledger-web/src/App.tsx:2002-2008), mirroring the active head (App.tsx:1853, badge gated App.tsx:1659).","T98 leaves a risky either/or (set rootDir:'src' for a flat ./dist/*.js layout, OR realign all entries to ./dist/src/*) for the implementer to resolve at build time. The rootDir:'src' branch carries a concrete, known failure: the ledger tsconfig has include:['src','test'] (packages/ledger/tsconfig.json:10) and tsconfig.base.json sets no rootDir, so setting rootDir:'src' makes tsc emit TS6059 ('File is not under rootDir') for every test/ file unless test inclusion is restructured. Pick the FALLBACK (realign all exports/main to ./dist/src/*) as the PRIMARY approach: it matches the already-correct ./columns entry (package.json:18), requires no tsconfig or test-layout change, and avoids the TS6059 conflict. Reserve rootDir:'src' only if a flat layout is independently desired."]
- ledgerRefs: ["goals:G5"]

### R78 — go-ahead

- createdAt: 2026-06-02T17:47:09.723Z
- updatedAt: 2026-06-02T17:47:09.723Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G5"]
- tags: ["round-2","go-ahead","all-R77-criticisms-resolved"]

## M21

### R79 — go-ahead

- createdAt: 2026-06-02T18:25:25.168Z
- updatedAt: 2026-06-02T18:25:25.168Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T90","goals:G2"]
- tags: ["implement-flow","round-0","approve","!isMilestones gate; valid fail-first repro + regression guard; check 634; out-of-scope ledger-tui HTTP flake filed D9"]

### R83 — go-ahead

- createdAt: 2026-06-02T18:49:11.795Z
- updatedAt: 2026-06-02T18:49:11.795Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T91","goals:G2"]
- tags: ["implement-flow","round-0","approve","collapsed head shows title (repro-confirmed); ArchivePointer title+status both stores; wire JSON-clean; check 635; D10 filed for InMemory parity"]

### R84 — go-ahead

- createdAt: 2026-06-02T18:49:14.614Z
- updatedAt: 2026-06-02T18:49:14.614Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T92","decisions:K13","goals:G2"]
- tags: ["implement-flow","round-0","approve","routing-question removed from implement/advance §3; defect-filing + non-blocking preserved; K13 rationale accurate; peers conform; check 635"]

## M22

### R80 — go-ahead

- createdAt: 2026-06-02T18:25:27.511Z
- updatedAt: 2026-06-02T18:25:27.511Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T94","goals:G4"]
- tags: ["implement-flow","round-0","approve","4-step backup+reinit helper, ENOENT-tolerant, backup-before-reinit, init() untouched; 7 tests; check 634"]

### R85 — go-ahead

- createdAt: 2026-06-02T18:49:17.468Z
- updatedAt: 2026-06-02T18:49:17.468Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T95","goals:G4"]
- tags: ["implement-flow","round-0","approve","init() divergence → backupAndReinit (set, once) default + abort opt-out; registry mutated in place; regressions intact; 6 cases migrated; check 635"]

## M24

### R81 — go-ahead

- createdAt: 2026-06-02T18:25:30.328Z
- updatedAt: 2026-06-02T18:25:30.328Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T98","goals:G5"]
- tags: ["implement-flow","round-0","approve","all exports realigned ./dist/src/*; targets exist after build; tsconfig untouched; no ./constants yet (T99); check 634"]

### R86 — go-ahead

- createdAt: 2026-06-02T18:49:19.778Z
- updatedAt: 2026-06-02T18:49:19.778Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T99","goals:G5"]
- tags: ["implement-flow","round-0","approve","./constants export + web tsconfig paths verified; MILESTONES_SCHEMA type-checks from ledger-web; App.tsx untouched; check 635"]

## M25

### R82 — go-ahead

- createdAt: 2026-06-02T18:25:32.680Z
- updatedAt: 2026-06-02T18:25:32.680Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- criticism: []
- new_questions: []
- ledgerRefs: ["tasks:T102","goals:G5"]
- tags: ["implement-flow","round-0","approve","summary-source exclusion grounded in summarize(); suggestedModel intact; fail-first repro verified; check 634"]
