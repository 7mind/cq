---
ledger: tasks
counters:
  milestone: 0
  item: 115
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
