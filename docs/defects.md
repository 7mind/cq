---
ledger: defects
counters:
  milestone: 0
  item: 10
archives:
  - id: M2
    path: ./archive/defects/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
---

# defects

## M11

### D2 — wip

- createdAt: 2026-06-02T08:37:01.114Z
- updatedAt: 2026-06-02T16:31:40.556Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: ledger-mcp fails to connect in a directory with no initialized ledger (should auto-init)
- severity: major
- description: "MCP connection fails when an agent (Claude Code / Codex) starts in a directory that has NO initialized ledger — i.e. no docs/ ledger state / no docs/ledgers.yaml present. The `@cq/ledger-mcp` server fails to connect/serve instead of degrading gracefully, so the session has no ledger tools. Desired behavior: instead of failing, automatically initialize the canonical ledger set (init the ledgers) on startup so the MCP connection succeeds in a fresh directory. Investigate the root cause — where/why the server errors on missing ledger state, what \"initialized\" means (which files/dirs are required), whether `--cwd` resolution or a missing docs/ledgers.yaml is the trigger, and where an auto-init hook should live (server startup vs store construction) — then seed fix tasks. Severity: major (blocks using the tool in any uninitialized repo; workaround = manually init the ledger files)."
- rootCause: "ledger-mcp aborts at startup with BootstrapViolationError ('existing <ledger> ledger has a different schema than its canonical bootstrap schema') thrown by FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:283-289) when an EXISTING on-disk ledger's schema diverges from its CANONICAL_LEDGERS bootstrap schema. main() (packages/ledger-mcp/src/main.ts:337-344) awaits store.init() BEFORE serving, so the throw crashes the process before the MCP handshake → client sees 'connection failed'. NOT a missing-init problem (the empty-dir auto-init path works). The divergence is a version-skew artifact (stale built/global binary vs evolved docs/ledgers.yaml, or vice-versa). Confirmed by the user's verbatim runtime error (hypothesis H4, parent H3)."
- suggestedFix: "Replace the fatal throw with a graceful BACKUP-AND-REINIT: when FsLedgerStore.init() detects a schema divergence for an existing ledger (the schemasEqual==false branch), instead of throwing BootstrapViolationError, (a) move/copy the divergent on-disk ledger file(s) (and docs/ledgers.yaml) into a timestamped backup location (e.g. docs/.backup/<ISO-timestamp>/), then (b) write fresh canonical ledger(s) + registry from CANONICAL_LEDGERS and continue startup. Surface a loud WARNING (stderr) naming the backup path so no data is silently lost. Consider a guard/opt-out flag if a non-destructive abort is ever wanted, but default to backup-and-reinit per the user. Add tests: a seeded divergent on-disk schema → init() backs up + reinitializes + serves (no throw); backup dir contains the prior files."
- dependsOn: ["T94","T95","T96","T97"]

## M14

### D3 — wip

- createdAt: 2026-06-02T12:19:08.216Z
- updatedAt: 2026-06-02T17:39:10.607Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Stale @cq/ledger exports map: '.', './relationships', 'main' point at non-existent ./dist/*.js (real layout is ./dist/src/*.js)"
- severity: major
- description: "Out-of-scope defect surfaced by the T61 reviewer (pre-existing, not introduced by T61). packages/ledger/package.json declares main=./dist/index.js, exports['.']=./dist/index.js, exports['./relationships']=./dist/relationships.js, but the tsc build (tsconfig include:[src,test] + outDir:./dist) emits everything under dist/src/ — the real files are dist/src/index.js, dist/src/relationships.js. ./dist/index.js etc. do NOT exist. Masked today because all in-repo consumers resolve @cq/ledger* via tsconfig `paths` to SOURCE, so the exports-map dist paths are never exercised in-repo. But a published consumer, or the nix ledger-web/ledger-mcp products that bundle without a prior `tsc` and rely on the exports map (dist gitignored), would fail to resolve @cq/ledger / @cq/ledger/relationships in a clean checkout. suggestedFix: realign every exports/main entry to the real output layout (./dist/src/index.js, ./dist/src/relationships.js, ./dist/src/columns.js, etc.), OR set the ledger tsconfig rootDir:src so the build emits ./dist/*.js matching the declared paths. (T61's own @cq/ledger/columns gap is fixed separately as in-scope criticism via a web-tsconfig paths→source entry.)"
- suggestedFix: "Realign main + exports['.'] + ['./relationships'] (+ any others) to the real ./dist/src/* layout (matching the already-correct ./columns entry), OR set the ledger tsconfig rootDir:'src' so dist emits flat ./dist/*.js matching the declared paths (then ./columns must drop its src/ prefix). Prefer the rootDir:'src' approach for a flat, conventional layout — but it must be consistent across ALL export entries. Add a test asserting every declared export/main target file exists after `tsc -b`."
- ledgerRefs: ["tasks:T61","goals:G2"]
- rootCause: "CONFIRMED (H5). packages/ledger/package.json declares main + exports['.']=./dist/index.js and ['./relationships']=./dist/relationships.js, but tsc (tsconfig outDir ./dist, include [src,test], NO rootDir → roots at packages/ledger/) emits under ./dist/src/. Validated on disk: dist/index.js + dist/relationships.js are MISSING; dist/src/index.js + dist/src/relationships.js exist. Internal inconsistency: ['./columns'] ALREADY correctly points at ./dist/src/columns.js. Masked in-repo by tsconfig paths→source (ledger-web/tsconfig.json:11-16, ledger-mcp tsconfig); a published / nix clean-checkout consumer relying on the exports map would fail to resolve @cq/ledger or @cq/ledger/relationships."
- dependsOn: ["T98","T99","T101"]

### D4 — resolved

- createdAt: 2026-06-02T12:19:14.330Z
- updatedAt: 2026-06-02T18:25:37.852Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "`headline` is column-eligible — column picker can show a redundant headline/summary column"
- severity: low
- description: "Out-of-scope defect surfaced by the T62 reviewer (property of the T60 helper, not the T62 diff). In packages/ledger/src/columns.ts, eligibleColumnFields excludes only LONG_FIELD_DENYLIST plus id/status/summary; `headline` is in neither set, so the column picker (T61 web / T62 TUI) offers `headline` as a toggleable extra column. Selecting it renders the headline text BOTH as an extra column cell AND as the trailing summary (summarize() picks headline first), duplicating it in each row. Affects no acceptance clause; cosmetic. suggestedFix: add `headline` (and likely `title`/`question`) to the always-shown/denylist set in columns.ts so summary-source fields are never offered as redundant extra columns."
- suggestedFix: "In packages/ledger/src/columns.ts exclude the summary-source fields {headline, title, question} from eligibleColumnFields (add a SUMMARY_SOURCE_FIELDS set to the exclusion, or compute the field summarize() would pick and drop it). Add a unit test (none exists today) asserting eligibleColumnFields(<schema with headline>) omits headline."
- ledgerRefs: ["tasks:T62","goals:G2"]
- rootCause: "CONFIRMED (H6). packages/ledger/src/columns.ts: eligibleColumnFields (L55-72) = schema fields minus LONG_FIELD_DENYLIST (L35-47, which lists description/rationale/criticism/context/etc.) minus ALWAYS_SHOWN_COLUMNS {id,status,summary}. headline/title/question are in NEITHER set → returned as eligible. summarize() (tui app.tsx:82-86, web App.tsx:181-185) picks headline ?? title ?? question ?? summary first, so selecting the headline (or title/question) column renders that text BOTH as an extra column cell (app.tsx:1200-1210) AND as the trailing summary cell — duplicated per row. Cosmetic."
- dependsOn: ["T102"]
- fix: "T102 (5cf4883): added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields so the column picker never offers a field that duplicates the summary cell; suggestedModel and other genuine fields still eligible. New ledger columns.test.ts (fails pre-fix); integration check 634 green."

## M18

### D5 — wip

- createdAt: 2026-06-02T13:39:23.597Z
- updatedAt: 2026-06-02T17:44:56.607Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Archived milestone subsection heads cannot render a status badge — ArchivePointer/Milestone carry no status
- description: "ArchiveSubsections (packages/ledger-web/src/App.tsx) renders archived heads from ArchivePointer ({id,path,summary}) and lazily-fetched ArchiveContent whose 'group' variant carries a Milestone (packages/ledger/src/types.ts L97-104) — neither has a `status` field; only ResolvedMilestone (L116-121) does. So an archived head omits the T80 status badge. T80's acceptance only requires an active milestone head; the description gated archived coverage on item #9 (T79), which did not thread status through. Closing this requires adding the milestone's terminal status to ArchivePointer or the archive group payload over MCP, then passing it as milestoneStatus to the archived MilestoneSubsection."
- severity: low
- suggestedFix: "CORRECTED by plan review R77: H7's claimed 'wire-schema half' does NOT exist. There is NO @cq/shared package and NO Zod mirror of fetch_ledger's archivePointers[] — the server serialises via plain JSON.stringify with no output schema (packages/ledger/src/mcp/ledgerTools.ts:158-163) and the web client JSON.parses with no runtime validation (mcpClient.ts:116-119; ArchivePointer is a type-only re-export, types.ts:7-18). So once T91 (G2/M21) extends the ArchivePointer interface with status (packages/ledger/src/types.ts:155-162), the value ALREADY flows over the wire. D5 therefore reduces to a SINGLE render task, T104: pass the archived pointer's status as milestoneStatus to the archived MilestoneSubsection (App.tsx:2002-2008) so the T80 badge renders, with a happy-dom assertion. T104 dependsOn T91 directly. The former wire task T103 was withdrawn as misgrounded."
- ledgerRefs: ["tasks:T80","goals:G2"]
- rootCause: "CONFIRMED (H7). ArchivePointer (types.ts:155-162) = {id,path,summary} and the ArchiveContent group payload carries Milestone (types.ts:97-104, statusless); only ResolvedMilestone (types.ts:116-121) has status. The archived web head (App.tsx:2002-2008) passes NO milestoneStatus, and the T80 badge is gated on milestoneStatus!==undefined (App.tsx:1659) — so archived heads never badge. Planned task T91 (M21) already extends ArchivePointer with title+status at the @cq/ledger types + server-build boundary, which supplies the DATA D5 needs."
- dependsOn: ["T104"]

### D6 — wip

- createdAt: 2026-06-02T13:39:28.419Z
- updatedAt: 2026-06-02T17:39:15.295Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: MILESTONE_STATUS_SCHEMA duplicates canonical MILESTONES_SCHEMA in the web bundle (no browser-safe constants export)
- description: packages/ledger-web/src/App.tsx (T80) adds a hand-maintained MILESTONE_STATUS_SCHEMA const that must stay in sync with MILESTONES_SCHEMA (packages/ledger/src/constants.ts). The duplication exists because @cq/ledger exposes no browser-safe subpath export for its constants — only `.`, `./relationships`, `./columns`, and the `.` index pulls Node-builtin-laden store/parser code into the browser bundle. The copy can drift silently. Related to D3 (stale @cq/ledger exports map).
- severity: low
- suggestedFix: Add a browser-safe `./constants` subpath export to packages/ledger/package.json (pointing at the real dist layout per D3's resolution) + a `@cq/ledger/constants` tsconfig paths→source entry in ledger-web/tsconfig.json (mirroring ./relationships and ./columns), then import MILESTONES_SCHEMA from @cq/ledger/constants in App.tsx and DELETE the duplicated MILESTONE_STATUS_SCHEMA. Fold into D3's exports-map cleanup (same package.json edit). Add a test that the web bundle does not pull Node builtins.
- ledgerRefs: ["tasks:T80","goals:G2","defects:D3"]
- rootCause: "CONFIRMED (H8). packages/ledger/package.json exports only ., ./relationships, ./columns (no ./constants). The '.' barrel (index.ts:50) re-exports FsLedgerStore, which imports node:fs + node:path (FsLedgerStore.ts:29-30), so importing MILESTONES_SCHEMA via '@cq/ledger' drags Node builtins into the browser bundle. constants.ts (L25-27) has only a type-only import → it is browser-safe in isolation. Hence T80 hand-duplicated MILESTONE_STATUS_SCHEMA in App.tsx:69-82 (comment documents the reason). Same family as D3."
- dependsOn: ["T99","T100"]

## M21

### D7 — resolved

- createdAt: 2026-06-02T16:17:17.745Z
- updatedAt: 2026-06-02T18:25:35.516Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "MILESTONES ledger renders archived milestones twice: once as their own row, again as an archived per-milestone subsection (ArchiveSubsections not scoped to exclude the milestones ledger)"
- severity: medium
- description: "G2 follow-up #4 item 16. In packages/ledger-web/src/App.tsx the ArchiveSubsections component (defined ~L1924) is rendered unconditionally whenever `showArchive && view.archivePointers.length > 0 && client !== null && ledger !== null` (App.tsx ~L1193-1205) — it does NOT consult `isMilestones`. The T79 unification (render each archived milestone-group through the SAME collapsible MilestoneSubsection renderer as active groups) is CORRECT for NON-milestones ledgers, where tasks/defects/etc. are grouped by their coordination milestone. But for the MILESTONES ledger itself, each milestone is already its OWN row in the flat table (ItemTable isMilestones branch, App.tsx ~L1757-1763); rendering it again as an archived 'section' duplicates it (shown twice). EXPECTED: for the milestones ledger, do NOT render archived subsections at all (the milestone row is sufficient)."
- rootCause: ArchiveSubsections render site (App.tsx ~L1193) is gated only on showArchive + archivePointers presence, not on the ledger kind; the milestones ledger's own rows already represent each (archived) milestone.
- suggestedFix: Gate the ArchiveSubsections render on `!isMilestones` (the flag is already in scope at App.tsx ~L1232/L1246/L1258). Add a happy-dom assertion that the milestones ledger view, with showArchive on, renders NO archive-section subsections (data-testid `archive-section` absent / no `ms-section-*` duplicate for an already-listed milestone row), while a non-milestones ledger still renders them.
- ledgerRefs: ["goals:G2"]
- dependsOn: ["T90"]
- fix: "T90 (208b446): gated the ArchiveSubsections render on `!isMilestones` so the MILESTONES ledger no longer duplicates an archived milestone as both a flat row and an archived subsection. happy-dom repro + non-milestones regression guard; integration check 634 green."

### D8 — resolved

- createdAt: 2026-06-02T16:17:29.755Z
- updatedAt: 2026-06-02T18:49:22.608Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Archived milestone subsection TITLES render the milestone `description` instead of its `title`
- severity: medium
- description: "G2 follow-up #4 item 17. In packages/ledger-web/src/App.tsx the ArchiveSubsections component builds each archived section's header from the archive pointer: `const headerLabel = p.summary.length > 0 ? `${p.id}: ${p.summary}` : p.id;` (App.tsx ~L2000), where `p` is an archive pointer ({id, path, summary}). The pointer `summary` carries the milestone `description` (a long field), not its `title`, so archived section heads show the long description rather than the short title — unlike active milestone sections, which show the title (active headerLabel built from the resolved milestone, App.tsx ~L1850-1852 / ms.title). EXPECTED: archived section heads show the milestone `title` (matching active sections). The implementer must thread the milestone `title` to the archived head: either add `title` to the ArchivePointer shape over MCP (packages/ledger/src/types.ts + the server's archivePointer build) and use it, or read it from the lazily-fetched ArchiveContent group payload (which carries the Milestone) and replace the header once content loads. NOTE: with item 16 (D7) fixed, this no longer affects the MILESTONES ledger (no archived subsections there), but it STILL affects non-milestones ledgers whose archived coordination-milestone groups render via ArchiveSubsections."
- rootCause: ArchivePointer.summary is sourced from the milestone description; ArchiveSubsections uses it verbatim as the header label, whereas active sections use the milestone title.
- suggestedFix: Thread the milestone `title` to the archived MilestoneSubsection head and render it (parity with active sections). Prefer adding `title` to the ArchivePointer payload at the MCP/server boundary so the head shows the title on first paint without waiting for lazy content. Add a happy-dom assertion that an archived section head shows the milestone title, not its description.
- ledgerRefs: ["goals:G2"]
- dependsOn: ["T91"]
- fix: "T91 (98e50c6): extended ArchivePointer with `title` (and `status`), populated at archive time in both stores; switched the archived section head label from p.summary (description) to p.title. happy-dom test asserts a COLLAPSED archived head shows the milestone title (repro-verified). Integration check 635 green."

### D9 — open

- createdAt: 2026-06-02T18:25:44.398Z
- updatedAt: 2026-06-02T18:25:44.398Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Flaky ledger-tui HTTP-client tests under full-suite concurrency (ConnectionRefused / 'Unable to connect')
- severity: low
- description: "Surfaced (out-of-scope) during T90 review. Under one `bun run check` invocation, ~3-4 tests in packages/ledger-tui/test/{mcpClient,displayName}.test.ts failed with 'Unable to connect. Is the computer able to access the url?' (McpLedgerClient over HTTP — update status / surface validation errors; displayName HTTP — serverInfo.title). They PASS on isolated re-run (6/0) and in the full suite on re-run, indicating a connection-setup / port-binding race under concurrent test execution — NOT a product defect, a test-harness flakiness. Independent of any G2/G4/G5 task diff."
- suggestedFix: "In the HTTP McpLedgerClient test harness, allocate an ephemeral port and WAIT for the server to confirm listening (readiness probe) before the client connects, so concurrent test execution cannot race the bind. Or serialize those HTTP tests. Triage via /investigate:start D9 when chosen."
- ledgerRefs: ["tasks:T90","goals:G2"]

### D10 — open

- createdAt: 2026-06-02T18:49:30.407Z
- updatedAt: 2026-06-02T18:49:30.407Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: InMemoryLedgerStore.performArchive lacked a pre-mutation terminal guard (partial-mutation divergence from FsLedgerStore)
- severity: low
- description: Surfaced (out-of-scope) during T91 review. Before T91, InMemoryLedgerStore.performArchive relied solely on Phase 3's applyDetachMilestoneItem to reject a non-terminal milestone-item; because Phase 2 (detach+archive of every non-milestones group) runs first, a non-terminal milestone-item left Phase-2 in-memory state mutated before the Phase-3 throw — a partial archive, diverging from FsLedgerStore's pre-existing Phase 1b gate. T91 added the Phase 1b terminal-guard to InMemoryLedgerStore (correct + harmless, restores dual-store parity) as a side effect of needing the milestone-item lookup for title/status. The latent inconsistency it remediates was pre-existing/out-of-scope; it warrants its own tracking item plus a dual-store abstract assertion that post-rejection state is unchanged in BOTH adapters (the current non-terminal test asserts only the throw, not the absence of partial mutation).
- suggestedFix: "Add an abstract store-suite assertion that after a non-terminal archiveMilestone rejection, the non-milestones ledger groups remain attached (no partial archive) in BOTH FsLedgerStore and InMemoryLedgerStore. The Phase 1b guard T91 added already prevents the InMemory partial mutation; this is a test-hardening + tracking item. Triage via /investigate:start D10 when chosen."
- ledgerRefs: ["tasks:T91","goals:G2"]
