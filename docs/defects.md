---
ledger: defects
counters:
  milestone: 0
  item: 15
archives:
  - id: M2
    path: ./archive/defects/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: ""
    status: ""
  - id: M14
    path: ./archive/defects/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: ""
    status: ""
  - id: M18
    path: ./archive/defects/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: ""
    status: ""
  - id: M21
    path: ./archive/defects/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
---

# defects

## M11

### D2 — resolved

- createdAt: 2026-06-02T08:37:01.114Z
- updatedAt: 2026-06-02T19:13:37.020Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: ledger-mcp fails to connect in a directory with no initialized ledger (should auto-init)
- severity: major
- description: "MCP connection fails when an agent (Claude Code / Codex) starts in a directory that has NO initialized ledger — i.e. no docs/ ledger state / no docs/ledgers.yaml present. The `@cq/ledger-mcp` server fails to connect/serve instead of degrading gracefully, so the session has no ledger tools. Desired behavior: instead of failing, automatically initialize the canonical ledger set (init the ledgers) on startup so the MCP connection succeeds in a fresh directory. Investigate the root cause — where/why the server errors on missing ledger state, what \"initialized\" means (which files/dirs are required), whether `--cwd` resolution or a missing docs/ledgers.yaml is the trigger, and where an auto-init hook should live (server startup vs store construction) — then seed fix tasks. Severity: major (blocks using the tool in any uninitialized repo; workaround = manually init the ledger files)."
- rootCause: "ledger-mcp aborts at startup with BootstrapViolationError ('existing <ledger> ledger has a different schema than its canonical bootstrap schema') thrown by FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:283-289) when an EXISTING on-disk ledger's schema diverges from its CANONICAL_LEDGERS bootstrap schema. main() (packages/ledger-mcp/src/main.ts:337-344) awaits store.init() BEFORE serving, so the throw crashes the process before the MCP handshake → client sees 'connection failed'. NOT a missing-init problem (the empty-dir auto-init path works). The divergence is a version-skew artifact (stale built/global binary vs evolved docs/ledgers.yaml, or vice-versa). Confirmed by the user's verbatim runtime error (hypothesis H4, parent H3)."
- suggestedFix: "Replace the fatal throw with a graceful BACKUP-AND-REINIT: when FsLedgerStore.init() detects a schema divergence for an existing ledger (the schemasEqual==false branch), instead of throwing BootstrapViolationError, (a) move/copy the divergent on-disk ledger file(s) (and docs/ledgers.yaml) into a timestamped backup location (e.g. docs/.backup/<ISO-timestamp>/), then (b) write fresh canonical ledger(s) + registry from CANONICAL_LEDGERS and continue startup. Surface a loud WARNING (stderr) naming the backup path so no data is silently lost. Consider a guard/opt-out flag if a non-destructive abort is ever wanted, but default to backup-and-reinit per the user. Add tests: a seeded divergent on-disk schema → init() backs up + reinitializes + serves (no throw); backup dir contains the prior files."
- dependsOn: ["T94","T95","T96","T97"]
- fix: "Backup-and-reinit on schema divergence (replaces the fatal BootstrapViolationError): T94 (0d66e33) backupAndReinit helper (timestamped docs/.backup/, ENOENT-tolerant copy of prior files, fresh canonical + stderr WARNING); T95 (a26104b) rewired FsLedgerStore.init() !schemasEqual branch to backup-and-reinit BY DEFAULT (collects the divergent set, mutates this.registry in place to canonical) + onSchemaDivergence:'abort' opt-out preserving the throw; T96 (844d240) tests (divergence→backup+reinit / abort / no-divergence / empty-dir) + migrated the 6 divergence-guard cases to the abort opt-out; T97 repo-gate green. ledger-mcp no longer crashes the MCP handshake on a stale/divergent on-disk schema — it backs up + reinitializes and serves. NOTE: a stale already-running GLOBAL binary still needs a rebuild (out of scope, captured in G4). Integration check 659 green."

## M27

### D11 — resolved

- createdAt: 2026-06-02T19:51:24.026Z
- updatedAt: 2026-06-02T21:31:42.951Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Web: ledger filter/toolbar bar scrolls away with items — should stay pinned (sticky) at the top during scroll"
- severity: low
- description: "User-reported (G2 area). In the web client the filter/toolbar row (.lw-toolbar, styles.css:305 — the status filter + milestone filter + column-selector menu) lives INSIDE the scrolling content container .lw-main (styles.css:274, `overflow: auto`). So scrolling the items list scrolls the toolbar out of view. EXPECTED: the filter bar stays pinned at the top of the items pane while the items scroll beneath it."
- rootCause: "GROUNDED: .lw-main (styles.css:274-280) is the scroll container (overflow:auto, padding 8px 12px); .lw-toolbar (styles.css:305-310) is a normal-flow flex row inside it with no sticky/fixed positioning, so it scrolls with the content."
- suggestedFix: "Make .lw-toolbar `position: sticky; top: 0;` with an opaque background (var(--bg)/--panel) and a z-index BELOW the column-selector popup (which is z-index:10, styles.css:316-320) so the popup still layers above it. Because .lw-main has padding-top:8px, offset the sticky top (e.g. top:0 with a small negative margin / matching padding, or move the padding) so items don't peek above the bar; ensure the bar's background spans the .lw-main horizontal padding (e.g. negative side margins + matching padding) so scrolled content doesn't show in the gutters. Add a happy-dom assertion that the .lw-toolbar rule carries position:sticky (computed scroll behavior isn't observable under happy-dom; assert the rule). TUI is unaffected (no scroll-detached toolbar)."
- ledgerRefs: ["goals:G2"]
- dependsOn: ["T107"]
- fix: "T107 (commit e266ca4) — made .lw-toolbar position:sticky;top:-8px at the top of the .lw-main scroll container, opaque background, z-index:5 below the column-popup (10), gutter-spanning via -12px margins + matching padding; happy-dom test asserts the rule."

### D12 — resolved

- createdAt: 2026-06-02T20:02:05.647Z
- updatedAt: 2026-06-02T22:05:01.219Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "Web milestones ledger: 'show archived' shows NO archived milestones (and no titles) — D7/T90 over-corrected by suppressing them entirely"
- severity: medium
- description: "User-reported (issues 1+2, related). After D7/T90 added `&& !isMilestones` to the ArchiveSubsections render gate (App.tsx ~L1193) — correctly stopping the milestones ledger from showing an archived milestone TWICE (row + duplicate section) — it went too far: the MILESTONES ledger now shows archived milestones NOT AT ALL. The flat ItemTable isMilestones branch renders only the LIVE (active) milestones; archived milestones live in view.archivePointers and were previously surfaced only by ArchiveSubsections, which is now suppressed for the milestones ledger. So toggling 'show archived' in the milestones view adds nothing (issue 2), and the archived milestones' titles never appear (issue 1). EXPECTED: with 'show archived' on, the milestones ledger lists each archived milestone ONCE — as a ROW (not a duplicating section), showing its title (+ an archived badge), distinct from active rows."
- rootCause: D7/T90 suppressed ArchiveSubsections for the milestones ledger (the right call to stop duplication) but added no replacement, so archived milestones (which exist only as view.archivePointers for the milestones ledger, not as live items) are now unrendered there. The flat ItemTable isMilestones branch iterates only the active milestone groups.
- suggestedFix: "In the web milestones-ledger view, when showArchive is on, append the archived milestones as ROWS in the flat ItemTable (one per view.archivePointers entry), using the ArchivePointer `title` (+ `status` for the badge) that T91 added — marked with an archived badge (reuse .lw-archived-badge / the archived styling), and ideally clicking a row opens the archived detail (lazy fetch_ledger_archive). Do NOT reintroduce the duplicate per-milestone SECTION (keep D7's !isMilestones gate on ArchiveSubsections); the rows ARE the milestones-ledger representation. happy-dom test: milestones ledger + showArchive renders an archived milestone as a single row with its title + archived badge (no duplicate section). Relates to D7 (T90) + T91 (ArchivePointer title/status)."
- ledgerRefs: ["defects:D7","tasks:T90","tasks:T91","goals:G2","goals:G6"]
- dependsOn: ["T108","T109"]
- fix: "Two-part fix, both merged: T109 (commit 8dfc415) backfills title+status onto legacy (pre-T91) ArchivePointers at FsLedgerStore.init() so the synchronous fetch('milestones') emits populated pointers; T108 (commit 9d3c068) extends the web ItemTable to render each archived milestone as a single titled row (status + .lw-archived-badge, click opens archive detail) when show-archived is on, preserving D7's !isMilestones gate (no duplicate section). Resolves issues 1 (titles never appeared) and 2 (archived milestones not shown at all)."

### D13 — open

- createdAt: 2026-06-02T20:02:18.249Z
- updatedAt: 2026-06-02T20:02:18.249Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4683-83a1-a45870023493
- headline: TUI navigation still ~500ms per cursor move despite T85 memoization — residual per-keystroke cost is elsewhere
- severity: medium
- description: "User-reported (issue 3): switching between two items in the TUI takes ~0.5s. T85 (#13) memoized the three O(N) items-frame derivations (filterVisibleRows/computeColumnLayout/buildItemEntries) keyed off non-cursor inputs, and the navMemo test proves those builders no longer run per cursor move — yet the user still observes ~500ms latency. So the residual cost is NOT those builders; it lies elsewhere on the per-keystroke path and needs profiling, NOT a blind fix. Candidate hypotheses to investigate: (a) every cursor move does patchTop({cursor})→setStack→a FULL App re-render, and ink reconciles/diffs the entire output tree each render (even though ScrollList windows the visible slice, the surrounding App subtree + ContentPane re-render); (b) the ContentPane (detail of the selected item) re-renders and re-parses markdown / re-computes layout on every cursor move; (c) an un-memoized O(N) cost remains in the render path that T85 didn't cover (e.g. a parent-level map, the milestones-schema threading, or a measureElement/stdout write cost); (d) ink's full-screen redraw cost at large terminal sizes. Needs an /investigate pass to localize the real cost (instrument render counts / timings, large-N repro) before fixing."
- rootCause: UNKNOWN (T85's memoization addressed the O(N) builder recompute but did not eliminate the ~500ms per-nav latency — the dominant cost is elsewhere on the cursor-move render path). To be confirmed via investigation.
- suggestedFix: "Investigate (/investigate:start D13): instrument the TUI per-cursor-move path — render counts (App / ContentPane / ScrollList), wall-clock per keystroke at large N — to localize the dominant cost (full re-render + ink reconciliation vs ContentPane markdown re-parse vs a residual O(N) vs ink redraw). Then fix (e.g. React.memo the list/detail subtrees, memoize ContentPane markdown parse, decouple cursor state from the heavy subtree, or virtualize the draw). Treat as a real investigation, not a localized fix — T85 already tried the obvious memoization."
- ledgerRefs: ["tasks:T85","goals:G2"]

## M28

### D14 — open

- createdAt: 2026-06-02T21:27:23.426Z
- updatedAt: 2026-06-02T21:27:23.426Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: freePort() retains a bind-then-close TOCTOU window (shared test helper, inherited from pty.e2e.test.ts)
- severity: low
- description: "Filed out-of-scope by the T105 reviewer (round 1). test/portHelpers.ts freePort() binds :0 on loopback, reads the OS-assigned port, then close()s the listener before returning it — a classic bind-then-close pattern with a theoretical TOCTOU window (the worker's own docstring acknowledges this). The window is far narrower than the original fixed-port collision (D9) and 3/3 consecutive full-suite runs were deterministically green, so it does NOT reintroduce the observed race. This pattern is pre-existing in pty.e2e.test.ts and was extracted verbatim per T105's explicit 'reuse pty's freePort()' instruction; eliminating it is harness-hardening out of scope for T105's de-flake. Does not block T105 (approved)."
- suggestedFix: Harden the shared freePort() to avoid the close-then-rebind gap — either retry server spawn on EADDRINUSE, or pass the open listener's fd to the child — and update both pty.e2e and the HTTP tests to the hardened allocator.
- ledgerRefs: ["tasks:T105","goals:G6"]

### D15 — open

- createdAt: 2026-06-02T21:27:30.297Z
- updatedAt: 2026-06-02T21:27:30.297Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: ledger-tui live-badge test fails/flakes on a pushed WS change (app.test.tsx ~593-612)
- severity: medium
- description: Filed out-of-scope independently by BOTH the T106 and T107 reviewers (round 1) — same underlying fault, deduped here. packages/ledger-tui/test/app.test.tsx ('live updates > shows a live badge and refetches the current frame on a pushed change') asserts the frame contains 'pushed-tui' after a FakeWS push + await tick(60), but the new item does not render. The T106 reviewer observed it fail deterministically (3/3) in isolation and reproduce identically on the base commit (9d6da3e / f67e5ee); the T107 reviewer observed it ~1/4 in the full suite. Either way it is PRE-EXISTING (present at base), in a package neither task touches, and makes `bun run check` non-deterministic on this tree. Conservatively rated medium given the T106 reviewer's deterministic-in-isolation finding. Did not block T106 or T107 (both approved); GATES M28 archival until terminal.
- suggestedFix: "Replace the fixed `await tick(60)` with a bounded poll/wait-for predicate that re-checks r.lastFrame() until it contains 'pushed-tui', so the assertion does not depend on a single fixed delay matching refetch+render latency; or verify FakeWS.instances[0].push still triggers the live-refetch path."
- ledgerRefs: ["tasks:T106","tasks:T107","goals:G6"]
