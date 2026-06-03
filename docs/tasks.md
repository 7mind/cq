---
ledger: tasks
counters:
  milestone: 0
  item: 129
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
    title: ""
    status: ""
  - id: M2
    path: ./archive/tasks/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: ""
    status: ""
  - id: M3
    path: ./archive/tasks/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: ""
    status: ""
  - id: M4
    path: ./archive/tasks/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: ""
    status: ""
  - id: M6
    path: ./archive/tasks/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
    title: ""
    status: ""
  - id: M7
    path: ./archive/tasks/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
    title: ""
    status: ""
  - id: M8
    path: ./archive/tasks/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
    title: ""
    status: ""
  - id: M9
    path: ./archive/tasks/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
    title: ""
    status: ""
  - id: M12
    path: ./archive/tasks/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
    title: ""
    status: ""
  - id: M13
    path: ./archive/tasks/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
    title: ""
    status: ""
  - id: M16
    path: ./archive/tasks/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
    title: ""
    status: ""
  - id: M17
    path: ./archive/tasks/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
    title: ""
    status: ""
  - id: M19
    path: ./archive/tasks/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
    title: ""
    status: ""
  - id: M14
    path: ./archive/tasks/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: ""
    status: ""
  - id: M18
    path: ./archive/tasks/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: ""
    status: ""
  - id: M22
    path: ./archive/tasks/M22.md
    summary: G4-W D2 backup-and-reinit — COMPLETE. T94 backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant, fresh canonical + WARNING); T95 init() !schemasEqual branch → backup-and-reinit by default + onSchemaDivergence:'abort' opt-out; T96 tests (divergence/abort/no-divergence/empty-dir) + abort-suite migration; T97 repo gate. Defect D2 RESOLVED. Reviews R80/R85/R89/R91. Shipped on main; check 661.
    title: ""
    status: ""
  - id: M24
    path: ./archive/tasks/M24.md
    summary: G5 Fix Unit A @cq/ledger packaging — COMPLETE. T98 realigned package.json main+exports → ./dist/src/* (consistent w/ ./columns); T99 browser-safe ./constants subpath export + web tsconfig paths; T100 App.tsx consumes @cq/ledger/constants, deletes MILESTONE_STATUS_SCHEMA dup; T101 package-exports.test.ts (asserts all export targets exist post-build). Defects D3 + D6 RESOLVED. Reviews R81/R86/R87/R88. Shipped on main.
    title: ""
    status: ""
  - id: M25
    path: ./archive/tasks/M25.md
    summary: G5 Fix Unit B column eligibility — COMPLETE. T102 added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence) + first columns.test.ts; suggestedModel still eligible. Defect D4 RESOLVED. Review R82. Shipped on main.
    title: ""
    status: ""
  - id: M26
    path: ./archive/tasks/M26.md
    summary: "G5 Fix Unit C archived-head status badge — COMPLETE. T104 passes archived pointer status as milestoneStatus to the archived MilestoneSubsection (empty-status guarded) → T80 badge renders for archived heads; happy-dom test. T103 withdrawn (R77: no @cq/shared wire mirror — T91's ArchivePointer.status flows over the wire as-is). Defect D5 RESOLVED. Review R92. Shipped on main; check 661."
    title: ""
    status: ""
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
---

# tasks

## M28

### T105 — done

- createdAt: 2026-06-02T19:52:29.136Z
- updatedAt: 2026-06-02T21:31:28.388Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "D9: de-flake ledger-tui HTTP McpLedgerClient tests (ephemeral port + TCP readiness wait, reuse pty.e2e helpers)"
- description: |
    FIX UNIT A (D9, low). packages/ledger-tui/test/{mcpClient,displayName}.test.ts run McpLedgerClient over HTTP and intermittently fail with 'Unable to connect' under full-suite concurrency. ROOT CAUSE (refined per R93): these harnesses ALREADY run a GET-based waitForServer readiness probe before McpLedgerClient.connect, so the bare-connect-before-listening framing is imprecise — the real flake mechanism is the FIXED ports (mcpClient.test.ts uses 7793, displayName.test.ts uses 7795) colliding under concurrent test execution, and/or the GET probe returning before the MCP session layer is fully ready.
    
    FIX (test harness only; no product-code diff): switch both flaky HTTP tests off fixed ports onto an EPHEMERAL/OS-assigned port, and wait for the server to actually accept connections via a TCP readiness wait. REUSE the existing proven precedent rather than reinventing it: pty.e2e.test.ts:49-76 already implements `freePort()` (bind :0, read the OS-assigned port) + `waitForPort()` (raw TCP connect loop). If those helpers are local to pty.e2e.test.ts, EXTRACT them into a shared test helper module and import from all three sites; otherwise import the existing ones.
    
    AVOID merely relocating the race: do NOT bind-then-close-then-reuse a port (the freePort() bind-:0-read-close pattern has a TOCTOU window between releasing the port and the server re-binding it). PREFER either (a) letting the server bind port 0 / OS-assigned and reading back the actual listening port (no intermediate close), or (b) retry-on-EADDRINUSE, combined with the TCP-connect `waitForPort()` readiness wait (preferred over the bare-GET probe). Reproduction note: the flake is intermittent — verify by running the ledger-tui suite repeatedly and observing no connection-race failures.
- acceptance: The affected ledger-tui HTTP McpLedgerClient tests (mcpClient.test.ts, displayName.test.ts) use a NON-FIXED (ephemeral / OS-assigned) port plus a TCP-connect readiness wait (reusing/sharing pty.e2e.test.ts's freePort()+waitForPort() rather than reinventing), with no bind-then-close TOCTOU reintroducing the race; tests are deterministic across repeated full-suite runs (no 'Unable to connect'); `bun run check` green across multiple consecutive runs. Fix confined to the test harness (no product-code diff).
- suggestedModel: standard
- ledgerRefs: ["defects:D9","goals:G6"]
- resultCommit: 8058527d1ea5aa783e60eae63d6763d60c7a5b0e
- completion: Ephemeral OS-assigned ports + TCP readiness wait via shared portHelpers.ts; HTTP tui tests deterministic; test-harness only.

### T106 — done

- createdAt: 2026-06-02T19:52:36.278Z
- updatedAt: 2026-06-02T21:31:30.694Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "D10: dual-store assertion — no partial mutation after Phase-1b non-terminal archiveMilestone rejection"
- description: |
    FIX UNIT B (D10, low; test-hardening). The behavior is ALREADY fixed: T91 added the Phase-1b terminal guard to InMemoryLedgerStore.performArchive (parity with FsLedgerStore — a non-terminal milestone-ITEM now rejects BEFORE any Phase-2 mutation). The remaining gap is test coverage: the current dual-store abstract suite (store-abstract.ts:261) asserts only the throw, not the no-partial-mutation post-state.
    
    FIX: in packages/ledger/test/store-abstract.ts, extending the existing throw-only assertion at store-abstract.ts:261, add an abstract assertion that after a non-terminal archiveMilestone REJECTION, the non-milestones ledger groups remain ATTACHED (no partial archive), run against BOTH adapters via the existing dual-store harness (FsLedgerStore + InMemoryLedgerStore).
    
    PIN THE SCENARIO (per R93 — the reproduction claim only holds for the Phase-1b path): the rejection MUST come via the Phase-1b milestone-item-non-terminal gate, NOT Phase-1. Concretely: make ALL non-milestones group items TERMINAL (e.g. updateItem(it1, resolved) as at store-abstract.ts:261) while the milestone-ITEM itself stays NON-TERMINAL (open), so performArchive passes Phase-1 and is rejected by the Phase-1b guard (InMemoryLedgerStore.ts ~L464-497) which runs BEFORE Phase-2 (~L500). Then assert the non-milestones groups remain attached. This pinning matters because if the test instead rejects via Phase-1 (a non-terminal GROUP item), no Phase-2 mutation ever runs and the assertion would pass even pre-T91 — a non-reproduction. NOTE in the test that this assertion FAILS against pre-T91 InMemory behavior (where Phase-2 mutated before the Phase-3 throw) and passes now.
- acceptance: "New abstract-suite assertion in packages/ledger/test/store-abstract.ts (extending the throw-only assertion at :261) that PINS the Phase-1b path — all non-milestones group items terminal + milestone-item non-terminal — then asserts the non-milestones groups stay ATTACHED after the rejection; runs against BOTH FsLedgerStore and InMemoryLedgerStore; documented to FAIL against pre-T91 InMemory behavior (reproduction) and pass now; `bun run check` green."
- suggestedModel: standard
- ledgerRefs: ["defects:D10","goals:G6"]
- resultCommit: c63d63d41dbdd949bc7005c9d331f5c28916929b
- completion: "Dual-store abstract assertion: Phase-1b non-terminal rejection leaves non-milestones groups attached (Fs + InMemory)."

### T107 — done

- createdAt: 2026-06-02T19:52:42.815Z
- updatedAt: 2026-06-02T21:31:33.102Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "D11: make web .lw-toolbar sticky at top of scroll container (styles.css + happy-dom test)"
- description: "FIX UNIT C (D11, low). In ledger-web, .lw-toolbar (styles.css:305) is a normal-flow row inside the scroll container .lw-main (styles.css:274, overflow:auto, padding 8px 12px), so it scrolls away with the items. FIX: give .lw-toolbar `position: sticky; top: 0;` plus an opaque background (var(--bg)/--panel) and a z-index BELOW the column-selector popup (which is z-index:10 at styles.css:316) so the popup still layers above the sticky bar. Handle the .lw-main padding (8px 12px): offset the sticky top so items don't peek above the bar, and make the bar background span the horizontal gutters (e.g. negative side margins + matching padding) so scrolled content doesn't show beside it. Add a happy-dom test asserting the .lw-toolbar rule carries position:sticky (actual scroll behavior isn't observable under happy-dom — assert the rule). TUI is unaffected. Honor the pure-MCP-client invariant (no direct docs/ reads)."
- acceptance: "styles.css .lw-toolbar carries position:sticky; top:0 with opaque background and z-index below the column-selector popup (z-index:10); .lw-main padding handled so items don't peek above the bar and the bar spans the gutters. A happy-dom test asserts the .lw-toolbar rule has position:sticky. `bun run check` green."
- suggestedModel: standard
- ledgerRefs: ["defects:D11","goals:G6"]
- resultCommit: e266ca4419332a7ab1000fab58b6609111eec8ed
- completion: ".lw-toolbar position:sticky;top:-8px, opaque bg, z-index:5<popup, gutter-spanning; happy-dom rule assertion test."

### T108 — done

- createdAt: 2026-06-02T20:36:54.622Z
- updatedAt: 2026-06-02T22:04:57.010Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "D12: surface archived milestones as single titled rows in the web milestones-ledger ItemTable (App.tsx + happy-dom test)"
- description: |
    FIX UNIT D, part 2 of 2 (D12, medium; user-reported issues 1+2). REVISED per R95.
    
    DEPENDS ON T109: T109 makes fetch_ledger('milestones').archivePointers carry a real title+status for legacy (pre-T91) pointers. WITHOUT T109 this task cannot fix D12 issue 1 — the App receives empty titles and rows fall back to the bare id (App.tsx:1990). Do this task only after T109 lands.
    
    PROBLEM: D7/T90 added `&& !isMilestones` to the ArchiveSubsections render gate (CONFIRMED App.tsx:1182) to stop the milestones ledger showing an archived milestone TWICE (a row + a duplicate per-milestone section). That killed the duplication but OVER-CORRECTED: the milestones ledger now surfaces archived milestones NOT AT ALL. The flat ItemTable milestones branch (App.tsx:1747-1815) iterates only LIVE milestone groups; archived milestones exist only as view.archivePointers, and ArchiveSubsections — their only previous surfacing — is now suppressed there. So with 'show archived' on, the milestones view adds nothing (issue 2) and archived titles never appear (issue 1).
    
    ITEMTABLE WIRING (per R95 criticism 3 — CONFIRMED): ItemTable (App.tsx:1687-1709) currently takes groups/schema/isMilestones/isGoals/statusFilter/milestoneFilter/extraColumns/selectedId/onSelect — NO archivePointers, NO showArchive, NO archive-fetch/select handler. Its isMilestones branch (App.tsx:1747-1815) is a flat <table> of Items with milestone/id/status/summary columns, which does NOT map onto an ArchivePointer (which has id/path/summary/title/status, no fields). So this task MUST: (1) extend ItemTable's props with `archivePointers: ArchivePointer[]`, `showArchive: boolean`, and an `onSelectArchive(pointer)` callback (and pass them from the call site at App.tsx:1160-1181, which already has view.archivePointers + showArchive + client in scope); (2) in the isMilestones branch, when showArchive is on, append one row per archivePointers entry AFTER the live-item rows — a row shape suited to a pointer (id, status badge via the pointer's status, title/summary), NOT the Item-shaped <td> mapping; (3) mark each archived row with the existing archived styling/badge (.lw-archived-badge) and route its click to the existing selectedArchiveRow path (App.tsx:1230-1240 DetailPanel isArchived=true) so clicking lazily opens the archived detail via client.fetchLedgerArchive('milestones', pointer.id). KEEP D7's `&& !isMilestones` gate on ArchiveSubsections (App.tsx:1182) — the rows ARE the milestones-ledger representation of archived milestones; do NOT reintroduce the duplicate per-milestone SECTION.
    
    SCOPE/PARALLEL-SAFETY (REVISED): file is packages/ledger-web/src/App.tsx (+ its happy-dom test). DISJOINT from T107 (styles.css) and T105 (ledger-tui). But the OVERALL D12 fix is NO LONGER App.tsx-only — its prerequisite T109 touches packages/ledger, the SAME package as T106 (store-abstract.ts). So D12 is NOT fully parallel-safe with T106. This App.tsx task is disjoint from T106 at the file level but must run AFTER T109. Honor the pure-MCP-client invariant (archive detail via client.fetchLedgerArchive, never a direct docs/ read). NOTE: user-reported issue 3 (TUI nav ~500ms) is tracked separately as D13 and routed to /investigate — NOT in scope.
- acceptance: "With the milestones ledger selected and 'show archived' on, each archived milestone renders as exactly ONE row in the flat ItemTable (one per view.archivePointers entry), showing its TITLE and a status badge, marked with the archived badge (.lw-archived-badge), distinct from active milestone rows; NO duplicate per-milestone ArchiveSubsections section appears for the milestones ledger (D7's !isMilestones gate at App.tsx:1182 preserved). The happy-dom test MUST reproduce the REAL D12 issue 1 (per R95 criticism 2): construct the archive pointer as it is persisted PRE-T91 in the materialised view path — i.e. exercise the title coming through the T109 backfill (NOT a hand-fabricated pointer that already carries an inline title) — and assert the rendered row shows the reconstructed title AND the status badge, so the test would FAIL if titles fell back to the bare id. Assert also that no duplicate per-milestone section is emitted for the milestones ledger. (Optional, if implemented:) clicking an archived row opens its detail via client.fetchLedgerArchive + selectedArchiveRow. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T91","T109"]
- ledgerRefs: ["defects:D12","goals:G6"]
- resultCommit: 9d3c068bc5c145b4cb3482028b05f7f626c24cdc
- completion: ItemTable gains archivePointers/showArchive/onSelectArchive; milestones-ledger renders archived milestones as single titled rows (status + archived badge) when show-archived is on; D7 !isMilestones gate preserved; click lazily opens archive detail.

### T109 — done

- createdAt: 2026-06-02T20:43:50.567Z
- updatedAt: 2026-06-02T21:31:35.465Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "D12 prerequisite: backfill ArchivePointer title+status for legacy (pre-T91) milestones pointers at FsLedgerStore.init() (packages/ledger FS adapter)"
- description: |
    FIX UNIT D, part 1 of 2 (D12, medium). Prerequisite for T108 (App.tsx): T108 alone cannot fix D12 issue 1 because the title/status data is not present in the milestones-ledger archivePointers the web app receives for legacy archives.
    
    ROOT CAUSE (grounded against LIVE source, re-confirmed per R96): ArchivePointer (packages/ledger/src/types.ts:155-166) carries `title` + `status`, added by T91 — but T91 only POPULATES them at ARCHIVE TIME. Every PRE-T91 archived milestone persists in docs/milestones.md under `archives:` with ONLY id/path/summary and NO title/status (CONFIRMED: docs/milestones.md:10-12 for M2). So fetch_ledger('milestones').archivePointers reconstructs all 23 legacy pointers (M2..M26) with title:"" status:"", and T108's rows would fall back to the bare id (App.tsx:1990 headerLabel `p.title.length>0 ? ... : p.id`) — reproducing D12 issue 1 ('titles never appear'). The data IS recoverable: the archive .md carries it (docs/archive/milestones/M2.md:5 `title: TUI + web UI improvements`; header line 1 `### M2 — done` => status `done`).
    
    FIX LOCUS — `FsLedgerStore.init()` (NOT the read path; corrected per R96 criticism 1): The read path that produces fetch_ledger('milestones').archivePointers is SYNCHRONOUS and FS-free and therefore CANNOT do the archive .md read. CONFIRMED against live source: LedgerStore.fetch() is synchronous; FsLedgerStore.fetch() (packages/ledger/src/store/FsLedgerStore.ts:385-390) returns materialiseFetchedLedger(...), a synchronous, FS-free, pure function (packages/ledger/src/store/InMemoryLedgerStore.ts:570-609) whose archivePointers are just `ledger.archivePointers.map(p=>({...p}))` (InMemoryLedgerStore.ts:607). Reading the archive .md at pointer.path is async I/O and must NOT be pushed into fetch() (that would force fetch() async — an unscoped interface + ripple change across BOTH adapters and every caller, contradicting the documented sync contract). DO NOT touch materialiseFetchedLedger: it is SHARED with (imported by FsLedgerStore from) InMemoryLedgerStore, is synchronous + FS-free, and the in-memory adapter holds archive groups in Maps with no pointer.path-on-disk — a .md read there is impossible and would break the FsLedgerStore/InMemoryLedgerStore parity that D10/T106 protects. materialiseFetchedLedger is therefore REMOVED from the candidate-locus set.
    
    The feasible, FS-only locus is FsLedgerStore.init(), which is already async and already reads each archive .md once via collectArchivedItems() -> fetchArchive() (packages/ledger/src/store/FsLedgerStore.ts:244-254 / 432-448; for the milestones ledger fetchArchive does parseMilestoneItemArchive(text) at FsLedgerStore.ts:444, yielding the archived milestone ITEM which carries title+status, and the `### <id> — <status>` header / `title:` line are available). FIX: at init time, for each milestones-ledger archivePointer whose persisted entry lacks title/status (empty), CACHE the reconstructed title+status onto the in-memory ledger.archivePointers (mutate the pointer held in this.ledgers) by reading its archive .md — reuse the existing fetchArchive/parseMilestoneItemArchive read already performed for archive indexing rather than adding a second disk read where avoidable. Then the synchronous fetch() returns already-populated pointers (materialiseFetchedLedger spreads the now-populated in-memory pointers unchanged). Keep it FAIL-SOFT at this init read boundary: a missing/malformed archive .md leaves title/status empty and never throws (init must not fail on a legacy/absent archive file). Scope strictly the FS adapter; do NOT add an on-disk migration of docs/milestones.md (read-side cache-at-init is idempotent, self-healing for any future legacy pointer, no file rewrite). Honor the pure-MCP-client invariant: server-side library code; frontends still never read docs/ directly.
    
    SCOPE: packages/ledger/src/store/FsLedgerStore.ts (+ packages/ledger/test). Shares packages/ledger with T106 (store-abstract.ts) — NOT parallel-safe with T106; sequence or assign to the same worker. T108 (App.tsx) depends on this task (dependsOn [T91, T109]).
- acceptance: "After FsLedgerStore.init(), fetch_ledger('milestones').archivePointers carries a NON-EMPTY title and status for legacy pre-T91 pointers (e.g. M2 => title 'TUI + web UI improvements', status 'done'), reconstructed from the archive .md (docs/archive/milestones/<id>.md) when the persisted `archives:` entry lacks them — populated at init and returned by the SYNCHRONOUS fetch() (no change to fetch()'s sync signature; materialiseFetchedLedger and the InMemory adapter UNTOUCHED, preserving D10/T106 parity). REPRODUCTION-FIRST TEST (pinned to the FS adapter): a packages/ledger test builds an FsLedgerStore fixture with a docs/milestones.md `archives:` entry that LACKS inline title/status PLUS a docs/archive/milestones/<id>.md carrying `title:` + a `### <id> — <status>` header; after init, asserts fetch('milestones').archivePointers[i].{title,status} are reconstructed NON-EMPTY. This test FAILS before the fix (the pointer reconstructs with empty title/status) and passes after. Fail-soft assertion: a missing/malformed archive .md yields empty title/status with NO throw (init succeeds). The test targets FsLedgerStore specifically (the InMemory adapter has no on-disk archive .md; do not assert backfill there). `bun run check` green."
- suggestedModel: standard
- ledgerRefs: ["defects:D12","goals:G6"]
- resultCommit: 8dfc415f536b7accde97a15085e3931919a3907d
- completion: FsLedgerStore.init() backfills legacy ArchivePointer title/status from archive .md, fail-soft, non-overwrite; fetch() stays synchronous.

## M33

### T116 — done

- createdAt: 2026-06-03T00:41:04.646Z
- updatedAt: 2026-06-03T01:11:08.634Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Defects schema: install locked lifecycle statusValues/terminalStatuses/transitions in CANONICAL_LEDGERS"
- description: |
    Edit DEFECTS_SCHEMA in packages/ledger/src/constants.ts. The LIVE schema (verified constants.ts:102-126) = statusValues [open, wip, blocked, resolved, abandoned], terminalStatuses [resolved, abandoned], transitions open->{wip,blocked,resolved,abandoned} / wip->{blocked,resolved,abandoned} / blocked->{open,wip,resolved,abandoned}. Replace with the LOCKED target (Q66/Q67):
    
    statusValues = [open, wip, root-caused, inconclusive, resolved, wontfix]
    terminalStatuses = [resolved, wontfix]
    transitions = {
      open:        [wip, resolved, wontfix],        // Q67 VERBATIM: open->{wip, resolved, wontfix}. NO open->root-caused and NO open->inconclusive edge — root-caused/inconclusive are reachable ONLY from wip.
      wip:         [root-caused, inconclusive, resolved, wontfix],
      root-caused: [resolved, wontfix, wip],
      inconclusive:[wip, wontfix],
      resolved:    [],
      wontfix:     []
    }
    
    NET DELTA vs the live schema: ADD root-caused + inconclusive; DROP blocked entirely; RENAME the terminal abandoned->wontfix (abandoned is removed everywhere). Keep the rootCause field (free-text narrative, Q68; markers removed) and severity (required).
    
    Update the doc-comment to describe the lifecycle (open->wip->{root-caused|inconclusive}->resolved|wontfix; root-caused is the queryable file-and-defer gate; inconclusive re-openable to wip). No baboon/model-version step (Q69 — direct edit). FsLedgerStore.init() guards on-disk schema divergence (backup-reinit default); the live-data migration of any defect on a removed status (blocked/abandoned) is handled by T122 — this task is the in-code constant + its unit tests.
- acceptance: "DEFECTS_SCHEMA.statusValues deep-equals [open, wip, root-caused, inconclusive, resolved, wontfix]; terminalStatuses deep-equals [resolved, wontfix]; transitions match Q67 EXACTLY (open->{wip,resolved,wontfix} ONLY — no open->root-caused/inconclusive edge; every terminal status has empty outgoing; every referenced target is a declared status; validateSchema accepts it). Add/extend a unit test in packages/ledger asserting the new statusValues/terminalStatuses and that a wip->root-caused->resolved path and a wip->inconclusive->wip path are ACCEPTED while a removed edge (open->blocked) and an illegal direct open->root-caused are REJECTED. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G6"]
- resultCommit: ef4bc69
- completion: "DEFECTS_SCHEMA → [open,wip,root-caused,inconclusive,resolved,wontfix], terminal [resolved,wontfix], Q67-verbatim transitions; rootCause+severity kept; discriminating transition test. Reviewer-noted wontfix→DROPPED-bucket gap is covered by T117/T118."

### T117 — done

- createdAt: 2026-06-03T00:41:21.413Z
- updatedAt: 2026-06-03T02:39:16.990Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "TUI: extend defect status→color/bucket map for root-caused + inconclusive (drop blocked/abandoned)"
- description: "Update the ledger-tui status→bucket/color mapping so the two new non-terminal defect states (root-caused, inconclusive) render with a sensible bucket/color, and the removed states (blocked, abandoned) no longer appear for defects. Locate the TUI status→color map (cf. the G2 'warning' bucket work referenced in grounding; grep packages/ledger-tui for the existing defect status color/bucket table). Map: open/wip→in-progress bucket; root-caused→a distinct 'ready' colour (cause confirmed, fix pending); inconclusive→a 'warning'/parked colour; resolved→done/success; wontfix→muted/terminal. Keep behaviour for other ledgers unchanged. Depends on the locked status names from the schema task."
- acceptance: TUI renders a defect in each new status (root-caused, inconclusive, wontfix) with a defined, distinct colour/bucket; no reference to defect 'blocked'/'abandoned' remains in the map. ink-testing-library test asserts the bucket/colour for root-caused and inconclusive. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: b7fdcfa
- completion: "TUI status map: root-caused→ready(blueBright), inconclusive→warning(magenta, non-terminal path), wontfix→DROPPED(gray). Tests assert all three."

### T118 — done

- createdAt: 2026-06-03T00:41:33.582Z
- updatedAt: 2026-06-03T02:39:34.239Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Web: extend defect status→color/bucket map for root-caused + inconclusive (drop blocked/abandoned)"
- description: "Mirror the TUI change in ledger-web: update the web status→bucket/colour mapping (grep packages/ledger-web for the defect status colour/bucket table, cf. styles.css buckets + the App status→colour logic) so root-caused and inconclusive render with distinct buckets/colours and the removed defect states (blocked, abandoned) are gone. Use the same bucket semantics as the TUI task for consistency (root-caused→ready, inconclusive→warning/parked, wontfix→muted/terminal). Frontends are pure MCP clients — do not read docs/ directly. Depends on the locked status names."
- acceptance: Web renders a defect in each new status with a defined distinct bucket/colour; no defect 'blocked'/'abandoned' mapping remains. happy-dom test asserts the rendered class/colour for a root-caused and an inconclusive defect. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: d05f3d5
- completion: "Web status map: root-caused→ready(#7c6af5, new bucket + --lw-status-ready), inconclusive→warning(WARNING_ACTIVE non-terminal), wontfix→DROPPED(muted). happy-dom test asserts each."

### T119 — done

- createdAt: 2026-06-03T00:41:52.891Z
- updatedAt: 2026-06-03T02:39:41.513Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "investigate/advance.md: adjudication writes root-caused|inconclusive STATUS instead of rootCause text markers"
- description: |
    Rewrite the investigate-flow adjudication + file-and-defer sections of llm/commands/investigate/advance.md (and llm/commands/investigate/start.md if it restates the marker convention) so defect STATUS — not a rootCause prose marker — carries the lifecycle.
    
    TRANSITION-LEGALITY (BLOCKING, per R111): Q67's locked transition map has NO open->root-caused edge — root-caused is reachable ONLY from wip. Today the investigate flow (step 5a) NEVER sets the defect's STATUS; the lifecycle lives entirely on the HYPOTHESIS tree (open|uncertain|confirmed|wrong) and rootCause is written as narrative + citations. So the flow MUST move the defect open->wip when it BEGINS investigating (the adjudication step / step where an explorer starts work), making the path open->wip->root-caused — both edges legal per Q67. A direct open->root-caused write WOULD throw InvalidTransitionError against the server's strict transition guard. Make the wip transition EXPLICIT in the adjudication task.
    
    Thus, edit the prompt to instruct: (1) when investigation STARTS on an `open` defect, update_item status=wip (explicit); (2) on a CONFIRMED root cause, update_item status=root-caused (legal from wip); (3) on an investigated-but-unpinned cause, update_item status=inconclusive (legal from wip; re-openable to wip). The rootCause FIELD stays as the free-text cause NARRATIVE (Q68) WITHOUT lifecycle tokens. The file-and-defer seeding gate becomes 'status == root-caused' (Q68). Update any prose that says 'confirmed root cause'/'mark rootCause CONFIRMED' to the status-based phrasing. Keep the explorer-dispatch + citation-validation behaviour unchanged.
- acceptance: "grep of llm/commands/investigate/*.md shows NO remaining instruction to stuff UNKNOWN/CONFIRMED/GROUNDED into rootCause; the prompt EXPLICITLY instructs update_item status=wip when investigation begins on an open defect (so no direct open->root-caused write occurs), then status=root-caused (confirmed) / status=inconclusive (unpinned) at adjudication; the file-and-defer precondition is stated as status==root-caused; the documented path is open->wip->{root-caused|inconclusive} (Q67-legal). `bun run check` green (markdown-only; no-op gate)."
- suggestedModel: frontier
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 9456c23
- completion: "investigate/advance.md: open→wip at investigation start, root-caused/inconclusive at adjudication, seed gate status==root-caused; rootCause narrative-only + marker prohibition; hypothesis-tree vocabulary intact."

### T120 — done

- createdAt: 2026-06-03T00:42:07.203Z
- updatedAt: 2026-06-03T02:39:46.009Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "plan prompts: re-key the DEFECT-STATUS auto-investigate worklist/seed-gate to status==root-caused (leave hypothesis-tree predicates intact)"
- description: |
    Update llm/commands/plan/advance.md AND llm/agents/plan-advance.md so the DEFECT-STATUS worklist + file-and-defer SEED GATE key off the queryable defect STATUS — NOT a prose marker.
    
    SCOPE (BLOCKING DISTINCTION, per R111 — be SURGICAL about which 'confirmed' is which):
    - CHANGE (defect lifecycle): the auto-investigate WORKLIST (plan/advance.md:92-98 + plan-advance.md:248-249, currently keyed on status:open) and the file-and-defer SEED GATE. New semantics: the worklist treats `open`/`wip`/`inconclusive` defects as still-ACTIONABLE, `root-caused` as READY-TO-SEED (the seed gate becomes status==root-caused, replacing any 'confirmed root cause' prose check), and `resolved`/`wontfix` as terminal/EXCLUDED. Replace any prose marker checks (rootCause CONFIRMED/UNKNOWN) here with status queries.
    - PRESERVE (hypothesis tree — DO NOT TOUCH): the K12 stop-predicates (b)/(c)/(d) at plan/advance.md:150-164 reason over the HYPOTHESIS TREE (hypothesis status `confirmed` + `[correct]` evidence — the investigate adjudication + ill-loop/convergence detector), which is a SEPARATE concept from the defect lifecycle. A blanket 're-key every confirmed node/confirmed root cause to status==root-caused' would CORRUPT these. Leave the hypothesis-tree `confirmed`-node vocabulary and the stop predicates' hypothesis reasoning INTACT. Only the defect-STATUS seed gate / worklist references change.
    
    Keep the auto-investigate ledger-query mechanism (re-derive worklist from the ledger) intact; only the defect-status predicate vocabulary changes. NOTE: these two files are ALSO edited by the M31 /advance + sweep tasks — this task lands FIRST (M33 precedes M31); the M31 tasks declare dependsOn this task to serialize the shared files.
- acceptance: "grep of llm/commands/plan/advance.md + llm/agents/plan-advance.md shows the auto-investigate WORKLIST + file-and-defer SEED GATE keyed off defect STATUS (open/wip/inconclusive actionable, root-caused ready-to-seed, resolved/wontfix excluded), with no remaining 'confirmed root cause' prose-marker gate on the DEFECT path. The K12 stop-predicates (b)/(c)/(d) at plan/advance.md:150-164 STILL reference the HYPOTHESIS-TREE `confirmed` node + `[correct]` evidence UNCHANGED (verify via diff that those lines' hypothesis vocabulary is preserved, not re-keyed to defect status). `bun run check` green (markdown-only)."
- suggestedModel: frontier
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 6818f7a
- completion: "plan/advance.md + plan-advance.md: auto-investigate worklist keyed to open/wip/inconclusive actionable, seed gate status==root-caused, resolved/wontfix excluded; K12 hypothesis-tree predicates (b)/(c)/(d) untouched."

### T121 — done

- createdAt: 2026-06-03T00:42:18.563Z
- updatedAt: 2026-06-03T04:40:06.423Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "implement/advance.md: align defect-terminal vocabulary with the locked set (abandoned->wontfix at :198; reviewer-filed defects already status:open)"
- description: |
    Two SURGICAL edits to llm/commands/implement/advance.md, both grounded against the live file (R111 corrected the original premise):
    
    (a) MILESTONE-COMPLETION terminal vocabulary (the MISSED touch-point, BLOCKING-adjacent): line 198 states the defect terminal set as `resolved`/`abandoned`. The locked schema (T116) RENAMES abandoned->wontfix and DROPS blocked, so this line references a REMOVED status. Edit :198 (and grep the whole file for any OTHER `abandoned` defect-terminal reference) to read `resolved`/`wontfix`. This is the primary content of this task.
    
    (b) REVIEWER-FILED defects section (lines 96-117): the original T121 premise was WRONG — this section ALREADY files reviewer defects with status:open and fields {headline, description, severity, suggestedFix?}; it writes NO rootCause marker and NO CONFIRMED/UNKNOWN token. So there is NOTHING to remove here. The ONLY action for this section is to CONFIRM it stays status=open (untriaged; a defect reaches root-caused only via an investigate pass, never directly from the implement reviewer) and that it sets NO removed status (blocked/abandoned). Do NOT instruct the implementer to hunt for a nonexistent rootCause marker.
    
    NOTE: implement/advance.md is ALSO edited by the M31 N=4->8 bump (T127) and the milestone-sweep predicate task (T128) — this task lands first (M33 precedes M31); those M31 tasks declare dependsOn this task to serialize the shared file.
- acceptance: "grep of llm/commands/implement/advance.md shows (a) the milestone-completion defect-terminal reference at ~:198 reads `resolved`/`wontfix` with NO remaining `abandoned` (nor `blocked`) defect-status reference anywhere in the file; (b) the reviewer-filed-defects section still creates defects with status=open and {headline,description,severity,suggestedFix?} (unchanged), with rootCause used as narrative only and no removed status written. `bun run check` green (markdown-only)."
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]
- resultCommit: f546fe2
- completion: "implement/advance.md:198 defect-terminal ref abandoned→wontfix (per T116 schema); task-status `abandoned` (:199) + blocked/blockedBy dependency refs correctly untouched; reviewer-filed-defects section unchanged (status:open)."

### T122 — planned

- createdAt: 2026-06-03T00:42:35.400Z
- updatedAt: 2026-06-03T00:42:35.400Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: Migrate live open defects to the new status vocabulary (one-shot, data-only; no on-load coercion)
- description: "After the schema lands (T116), perform a one-shot update_item migration of every live NON-terminal defect to the new vocabulary (Q69): for each, read its current status + rootCause marker and set the new status — a defect whose rootCause carried CONFIRMED/GROUNDED → root-caused; UNKNOWN-still-investigating → stays open (or wip if under active investigation); strip the marker token from rootCause leaving only the narrative. Also migrate any defect currently in a REMOVED status: status 'blocked' → open or wip (per its situation); status 'abandoned' (now removed; the terminal rename is abandoned→wontfix) → wontfix. The known live open defects are D13 (TUI nav latency, rootCause 'UNKNOWN' → stays open, marker stripped) and D20 (inspect its current marker). D13/D20 are MIGRATED ONLY, not fixed (explicitly out of scope). Re-query the defects ledger at execution time for the authoritative live set — do not trust this list. Use update_item via the ledger MCP (author/session set); do NOT hand-edit docs/defects.md. No permanent on-load coercion in the store (Q69)."
- acceptance: "Every live non-terminal defect carries a status from the new set [open, wip, root-caused, inconclusive] (or terminal resolved/wontfix); no live defect remains in a removed status (blocked/abandoned); no rootCause field contains a UNKNOWN/CONFIRMED/GROUNDED lifecycle token (narrative text only). Confirm via fts_search/fetch over the defects ledger. D13/D20 unchanged except status/rootCause-marker migration. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T116"]
- ledgerRefs: ["goals:G6"]

## M32

### T123 — done

- createdAt: 2026-06-03T00:42:54.427Z
- updatedAt: 2026-06-03T04:26:01.511Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "@cq/ledger: expose a public reset() on FsLedgerStore wrapping backupAndReinit (+ per-ledger summary return)"
- description: "backupAndReinit is currently a PRIVATE method (packages/ledger/src/store/FsLedgerStore.ts:694) invoked only from init()'s schema-divergence branch. Add a public async reset() method (or make backupAndReinit public) that the --reset CLI wrapper can call on a freshly-constructed (NOT-yet-serving) store: it must perform the same timestamped docs/.backup/<ts>/ snapshot + fresh canonical reinit, and RETURN a small summary the CLI can print (Q64) — e.g. { backupDir: absolute path, ledgers: Array<{ name, itemCount }> } counting items in each active ledger BEFORE the wipe. Reuse backupAndReinit verbatim for the snapshot/reinit (Q65); the reset() wrapper adds only the pre-count + the returned summary. FS-only (InMemory store needs no parallel — Q65). Keep init()'s existing private call-site working (if backupAndReinit stays private, reset() pre-counts then calls it; if made public, init still calls it). Export any new public type from @cq/ledger index.ts as needed."
- acceptance: "FsLedgerStore exposes a public reset() returning { backupDir, ledgers: [{name,itemCount}] }; a unit test creates a store with seeded items, calls reset(), and asserts (a) a docs/.backup/<ts>/ dir exists containing the prior ledgers.yaml + ledger files, (b) the live ledgers are back to the canonical empty set, (c) the summary item counts match what was seeded, (d) the post-reset defects ledger carries the NEW status set (proves CANONICAL_LEDGERS reuse). `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G6"]
- resultCommit: af0d882
- completion: "Public FsLedgerStore.reset() → ResetSummary{backupDir,ledgers:[{name,itemCount}]}: pre-counts, reuses backupAndReinit (now returns backup dir), reloads canonical via init(). Test asserts backup contents + canonical empty + counts + new defect status set."

### T124 — done

- createdAt: 2026-06-03T00:43:10.514Z
- updatedAt: 2026-06-03T04:40:12.621Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "ledger-mcp: add --reset flag (TTY y/N confirm + --yes skip), short-circuit main() to reset then exit"
- description: "Extend packages/ledger-mcp/src/main.ts: (1) parseArgs (line 109) recognises `--reset` (boolean) and `--yes`/`-y` (boolean), threading them into ParsedArgs; `--reset` honours the existing --cwd/$LEDGER_ROOT root resolution. (2) main() short-circuits when reset is set: construct the FsLedgerStore for the resolved cwd, print a per-ledger summary of what will be backed up (counts — obtain by init()+count or via the reset() summary), then CONFIRM per Q64 — if process.stdin.isTTY and NOT --yes, prompt 'Reset ledgers at <cwd>? Backup will be written to docs/.backup/. [y/N] ' and proceed only on y/Y; if --yes, skip the prompt (unattended); if NOT a TTY and NOT --yes, REFUSE with a non-zero exit + a message instructing --yes (a non-interactive run must not wipe silently). On confirm, call store.reset() (T123), print the returned backupDir + summary, and return (NO server started; process exits 0). Do NOT start the watcher/HTTP/stdio server on the reset path. Keep the existing serve paths unchanged when --reset is absent."
- acceptance: parseArgs recognises --reset/--yes (unit test). `ledger-mcp --cwd <tmp> --reset --yes` backs up + reinits the tmp ledger tree and exits 0 without serving (integration-style test invoking main() with --yes on a seeded tmp dir asserts docs/.backup/<ts>/ created, live tree reset, no server bound). A non-TTY invocation WITHOUT --yes exits non-zero and does NOT modify the tree. `bun run check` green.
- suggestedModel: frontier
- dependsOn: ["T123"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 8ac6c29
- completion: "ledger-mcp --reset/--yes: parseArgs + main() short-circuit to exported runReset(cwd,yes,ResetIo) — Q64 confirm (--yes unattended, TTY y/N, non-TTY-no-yes refuses exit2 no-mutation), calls store.reset(), prints backupDir+summary, exits without serving. 23/0 targeted tests."

## M31

### T125 — done

- createdAt: 2026-06-03T00:43:34.683Z
- updatedAt: 2026-06-03T04:26:04.498Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Author llm/commands/advance.md: universal /advance sequencer (investigate→plan→implement, loop to quiescence)"
- description: "Create the new top-level command prompt llm/commands/advance.md (NO namespace) — a thin sequencer run in the MAIN session that dispatches NO subagents of its own (Q58, K12: command-of-commands). Behaviour: evaluate the three ledger-query DETECTION PREDICATES (Q55, adopt as recommended): (investigate) an `open`/`wip`/`inconclusive` defect actionable by /investigate:advance (not blocked solely on an open question; root-caused defects are handled by plan auto-investigate, not re-triaged here); (plan) a goal in a movable planning phase (clarifying with no open question, or planning); (implement) a goal in planned/building with a DAG-ready non-terminal task per implement/advance.md READY-SET. Run the cycle investigate→plan→implement, re-checking investigate after implement (reviewer may file defects) and relying on plan:advance to OWN auto-investigate of goal-linked defects (Q57 — do not double-triage). LOOP the whole sequence to quiescence with NO max-iteration cap (Q56) — stop only when progress is genuinely impossible (every ledger drained OR every actionable item blocked on an unanswered question). End-of-run REPORT taxonomy (Q59): DRAINED (nothing actionable), BLOCKED-ON-QUESTIONS (enumerate the blocking question ids + their owning defect/goal/task, instruct answer-then-rerun), MIXED (progress made + remaining blocked); mirror implement/advance.md's end-of-pass report. /advance introduces NO concurrency cap of its own (inherits each sub-flow's, Q60). Reference the defect STATUS vocabulary from M33 (root-caused/inconclusive) in the predicates. NOTE the milestone auto-close+archive sweep (separate M31 task) plugs into this command's end-of-run."
- acceptance: "llm/commands/advance.md exists and specifies: the 3 ledger-query predicates (Q55), the loop-to-quiescence with no cap + the genuinely-impossible stop condition (Q56), the investigate→plan→implement→re-check-investigate ordering + plan-owns-auto-investigate boundary (Q57), the command-of-commands main-session shape dispatching no subagents (Q58), and the DRAINED/BLOCKED/MIXED report enumerating blocking question ids (Q59). Predicates reference defect statuses from the new vocabulary. `bun run check` green (markdown-only)."
- suggestedModel: frontier
- dependsOn: ["T120"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 010f323
- completion: "Authored llm/commands/advance.md: main-session command-of-commands sequencer (3 ledger-query predicates over new defect statuses, investigate→plan→implement loop-to-quiescence no-cap, plan-owns-auto-investigate, DRAINED/BLOCKED/MIXED report). T126 wires it; T128 fills the sweep placeholder."

### T126 — done

- createdAt: 2026-06-03T00:43:46.828Z
- updatedAt: 2026-06-03T04:40:18.866Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: Wire /advance into scripts/link-prompts.ts LINKS + add committed .codex/prompts/advance.md symlink
- description: "Register the new /advance command for both tool families (Q58). (1) Append to the LINKS array in scripts/link-prompts.ts (line 29-43): { link: '.claude/commands/advance.md', source: 'llm/commands/advance.md' } — note advance has NO namespace subdir (unlike plan/implement/investigate), so the link path is directly under .claude/commands/. (2) Add the COMMITTED .codex/prompts mirror: link-prompts.ts only materialises the gitignored .claude tree; the .codex/prompts/*.md symlinks are committed separately — create .codex/prompts/advance.md as a symlink to the llm/ source matching the existing committed .codex/prompts entries (inspect an existing one for the exact relative target convention). Run `bun run link-prompts` to verify the .claude link materialises and points at llm/commands/advance.md."
- acceptance: scripts/link-prompts.ts LINKS contains the advance.md entry; `bun run link-prompts` materialises .claude/commands/advance.md → llm/commands/advance.md without error; a committed .codex/prompts/advance.md symlink exists pointing at the llm/ source (matching sibling .codex/prompts symlinks). `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T125"]
- ledgerRefs: ["goals:G6"]
- resultCommit: 7b758a2
- completion: "Wired /advance: LINKS entry (.claude/commands/advance.md→../../llm/commands/advance.md, no-namespace) + committed .codex/prompts/advance.md symlink matching sibling convention; link-prompts materialises cleanly."

### T127 — planned

- createdAt: 2026-06-03T00:43:59.882Z
- updatedAt: 2026-06-03T00:51:58.893Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: Bump implement-flow concurrent-worker cap N=4→8 (implement/advance.md + audit other flows)
- description: "Per Q60 (as recommended): change the implement-flow concurrency cap from N=4 to N=8 in llm/commands/implement/advance.md (the 'Concurrency' rule, ~line 36). The live text reads 'at most N = 4 workers ... (configurable — treat 4 as the default ready-batch size)' — you MUST bump BOTH the 'N = 4' AND the parenthetical 'treat 4 as the default ready-batch size' to 8, else a stale 4 survives (R111). Update any RESTATEMENT of that default in llm/commands/implement/start.md. AUDIT investigate/* and plan/* prompts for any explicit concurrency cap (concurrent explorer subagents / concurrent reviewers) and bump those to 8 ONLY IF they exist (grounding: the only confirmed explicit 'N = 4' is in implement/advance.md — verify before editing). /advance introduces no cap of its own. NOTE: edits implement/advance.md which T121 (M33) also edits — dependsOn T121 to serialize that file."
- acceptance: implement/advance.md states the worker cap as N = 8 with NO remaining literal '4' in the Concurrency rule — BOTH 'N = 4' AND the parenthetical 'treat 4 as the default ready-batch size' now read 8; any restatement in implement/start.md updated; a grep across llm/commands/investigate + llm/commands/plan confirms either no other numeric concurrency cap exists or it was bumped to 8 consistently. `bun run check` green (markdown-only).
- suggestedModel: fast
- dependsOn: ["T121"]
- ledgerRefs: ["goals:G6"]

### T128 — planned

- createdAt: 2026-06-03T00:44:15.128Z
- updatedAt: 2026-06-03T00:44:15.128Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Milestone auto-close+archive sweep: factor the predicate once; state it in /advance + implement/advance.md"
- description: "Per Q70/Q71 (as recommended). Define the auto-close+archive sweep as a SINGLE factored predicate stated once and referenced from both prompts: the AUTHORITATIVE sweep lives in the new /advance command (llm/commands/advance.md — it re-derives ledger state each run and is the catch-all for goals the user closed between runs), and the SAME predicate is stated in llm/commands/implement/advance.md's milestone-completion step so an implement run that finishes the last work also closes its work milestones consistently. PREDICATE (Q71): a milestone M is eligible iff (1) EVERY item under M (all ledgers) is terminal, AND (2) if M is a COORDINATION milestone (its items include a goal), that goal is itself terminal (done/abandoned). MECHANISM: update_milestone status=done THEN archive_milestone (archive refuses unless the milestone-item is terminal — observed M21/M30). GUARD: never archive a coordination milestone whose goal is non-terminal (new follow-up scope may add items — cf. M27 while G6 active). Make the goal-vs-milestone ASYMMETRY an explicit one-liner in both prompts: GOALS NEVER auto-close (user-driven only, the G3-B/M16 invariant); MILESTONES ALWAYS may once eligible. WORK milestones have no goal so condition (2) is vacuous. Do NOT add a dependsOn-terminal requirement (Q71). NOTE: edits implement/advance.md (serialized after T127/T121) and advance.md (after T125)."
- acceptance: Both llm/commands/advance.md and llm/commands/implement/advance.md state the identical eligibility predicate (all-items-terminal AND coordination→goal-terminal), the update_milestone-done-then-archive_milestone mechanism, the goal-non-terminal guard, and the explicit goals-never / milestones-always asymmetry one-liner; the predicate is written once and cross-referenced (not divergently duplicated). `bun run check` green (markdown-only).
- suggestedModel: frontier
- dependsOn: ["T125","T127"]
- ledgerRefs: ["goals:G6"]

### T129 — planned

- createdAt: 2026-06-03T00:44:28.395Z
- updatedAt: 2026-06-03T00:44:28.395Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "One-shot backlog cleanup: close+archive already-completed coordination milestones (re-verify eligibility)"
- description: "Per Q72 (as recommended). Run the sweep once over the candidate lingering OPEN coordination milestones from the goal text — M10, M11, M15, M20, M23, M29 — but RE-VERIFY each at execution time (do NOT trust the list): for each candidate, list_milestone_items + check ALL items terminal AND (if it owns a goal) that goal is terminal. For each GENUINELY ELIGIBLE one, update_milestone status=done THEN archive_milestone (via the ledger MCP, author/session set). EXCLUDE M27 (G6 active) and any milestone whose goal is non-terminal or whose items are not all terminal — report each SKIPPED one with the reason. This both validates the new rule end-to-end and clears the observed backlog. Do NOT hand-edit docs/*.md — go through update_milestone/archive_milestone. Depends on the predicate being defined (T128)."
- acceptance: "Each of M10/M11/M15/M20/M23/M29 is either (a) archived (status done + archive_milestone) after verified eligibility, or (b) reported SKIPPED with a concrete reason (non-terminal item id, or non-terminal owning goal). M27 explicitly excluded (G6 active). A short report lists archived vs skipped with reasons. Post-run: fetch_milestone on each archived id shows it done/archived; no milestone with a live item or active goal was archived. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T128"]
- ledgerRefs: ["goals:G6"]
