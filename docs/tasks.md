---
ledger: tasks
counters:
  milestone: 0
  item: 104
archives:
  - id: M5
    path: ./archive/tasks/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
  - id: M2
    path: ./archive/tasks/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
  - id: M3
    path: ./archive/tasks/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
  - id: M4
    path: ./archive/tasks/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
  - id: M6
    path: ./archive/tasks/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
  - id: M7
    path: ./archive/tasks/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
  - id: M8
    path: ./archive/tasks/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
  - id: M9
    path: ./archive/tasks/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
  - id: M12
    path: ./archive/tasks/M12.md
    summary: G2-W1 shared status→color foundation — COMPLETE. 'warning' StatusBucket + WARNING={revise} (T50, mirror both status.ts); TUI warning=magenta (T51); web canonical BUCKET_HEX single source as --lw-status-* vars, warning=#e0a341 (T52); DagView nodes via shared BUCKET_HEX[statusBucket(status,schema)] (T53). Tasks T50-T53; reviews R34/R40/R43/R44.
  - id: M13
    path: ./archive/tasks/M13.md
    summary: G2-W2 Questions UX — COMPLETE. parseFieldValue string[] on ;/newline, id[] keeps comma (T54); normalizeSuggestions helper+script idempotent (T55, live data-run DEFERRED — run with MCP quiesced + restart); web (T56)+TUI (T57) suggestions bulleted list; web (T58)+TUI (T59) question field order milestone,status,by,question,context,suggestions,recommendation,answer. Tasks T54-T59; reviews R35/R39/R46/R50/R51/R53.
  - id: M16
    path: ./archive/tasks/M16.md
    summary: G3-B never auto-close goals — COMPLETE. implement/advance.md hard rule 'never auto-transition goal building→done' + ready-to-close report, milestone auto-archive preserved (T69); authoritative invariant once in plan-advance.md, building→done stays legal user-driven (T70); verify gate green (T71). Tasks T69-T71; reviews R36/R45/R55.
  - id: M17
    path: ./archive/tasks/M17.md
    summary: G3-A auto-investigate from plan:* — COMPLETE. K12 supersedes K8 pt3 (pins pts1/2/4/5; plan:* commands auto-launch /investigate:advance inline) (T72); plan-advance.md file-only defects (T73); plan/advance.md auto-investigate phase + enumerated convergent stop predicates replacing 4-iter cap (T74); plan/start+follow-up conditional auto-investigate (T75); implement/advance.md 8-round ceiling removed (T76); cross-flow wording reconciled (T77); verify gate (T78). Tasks T72-T78; reviews R37/R38/R48/R49/R52/R56.
  - id: M19
    path: ./archive/tasks/M19.md
    summary: "G2 follow-up #14-#15 — COMPLETE. Web per-suggestion 'pick' button (T86); TUI keys 1-9 pick Nth suggestion (T87); web disable as-recommended+pick on non-whitespace answer, detail+batch (T88); TUI r/1-9 inert + batch Ctrl+R when persisted answer non-empty (T89). Tasks T86-T89; reviews R69-R72. Integration 623 pass."
---

# tasks

## M14

### T60 — done

- createdAt: 2026-06-02T08:47:57.646Z
- updatedAt: 2026-06-02T11:01:59.159Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Column model: eligible-fields rule + per-ledger default columns constant"
- description: "Item #1 (foundation, both UIs). Per Q29/Q30: define a FIELD-LEVEL eligibility rule (NOT the per-value isShortField) for which schema fields can be shown as columns. Rule: eligible = every schema field name EXCEPT a small denylist of known long/narrative fields (description, rationale, criticism, context, alternatives, evidence, completion, and similar) AND excluding id/status/summary which are ALWAYS shown. Add a per-ledger DEFAULT columns constant: tasks defaults to showing `suggestedModel`; other ledgers default to none-extra. Place these as exported pure helpers (e.g. eligibleColumnFields(schema): string[] and defaultColumns(ledgerName): string[]) so both frontends and their tests share one definition — a sensible home is @cq/ledger (constants) or a small shared module; if cross-package import is awkward, mirror the same pure helper in both frontends (matching the status.ts duplication convention). No schema change."
- acceptance: "Unit test: eligibleColumnFields(TASKS_SCHEMA) includes 'suggestedModel' and excludes 'description'/'id'/'status'; defaultColumns('tasks') === ['suggestedModel']; defaultColumns('goals') === []. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: 48fa2c6
- completion: "@cq/ledger columns.ts: pure eligibleColumnFields(schema) (field-level, minus long/narrative denylist + always-shown id/status/summary) + defaultColumns(ledgerName) (tasks→['suggestedModel']); index-exported, no Node deps (browser-safe for T61); 6 unit tests. Reviewer approve 0/0 (noted acceptance/planDoc/grounding eligible — T61/T62 may refine). Merged 48fa2c6."

### T61 — done

- createdAt: 2026-06-02T08:48:07.769Z
- updatedAt: 2026-06-02T12:31:07.554Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: column selector (triple-dot menu) + extra columns, per-ledger localStorage"
- description: Item #1 (web). Add a triple-dot (⋮) button at the right end of the filters/toolbar row (the lw-toolbar at App.tsx L886) that opens a column-selector popup listing eligibleColumnFields(schema) (from T60) as checkboxes; checked fields render as extra <td>/<th> columns in ItemTable (both the flat milestones table and the per-milestone subsection tables), in addition to the always-shown id/status/summary. Persist the chosen set PER LEDGER in localStorage (new key namespace, mirroring PANEL_KEY/VIEW_KEY style at L57/L84); on first open of a ledger with no saved set, seed from defaultColumns(ledgerName) so the tasks view shows suggestedModel by default. Extra-column cell values render via the existing fieldToString (arrays joined) — a column is a compact scalar by the eligibility rule. No new MCP surface.
- acceptance: "happy-dom tests: (1) opening tasks shows a 'suggestedModel' column by default; (2) the ⋮ menu lists eligible fields; toggling one on adds its column header + cells, toggling off removes them; (3) the selection persists across a remount (localStorage) and is independent per ledger. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T60"]
- ledgerRefs: ["goals:G2"]
- resultCommit: "5786674"
- completion: "Web ⋮ column-selector (eligibleColumnFields checkboxes), extra columns in flat + subsection tables, per-ledger localStorage seeded from defaultColumns (tasks→suggestedModel). Round-0 criticism fixed in round 1: added @cq/ledger/columns→../ledger/src/columns.ts to ledger-web/tsconfig.json paths (mirroring relationships) so the dist-less browser bundle resolves it from source (verified via Bun.build repro); ./columns export points at real dist/src/columns.js. Reviewer approve (round 1). Merged 5786674; integration 555 pass."

### T62 — done

- createdAt: 2026-06-02T08:48:14.367Z
- updatedAt: 2026-06-02T12:18:11.304Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: column selector overlay + extra columns, per-ledger in-memory"
- description: "Item #1 (TUI). Add a column-selector affordance to the TUI: a new Overlay variant (extend the Overlay union at app.tsx L170-179, e.g. { t: 'pickColumns'; ledger }) opened by a keybinding (document it in the key hints), listing eligibleColumnFields(schema) (from T60) as a toggle list (reuse SelectList-style multi-select or a checkbox list). Selected fields render as extra columns in the item list rows alongside id/status/summary. Persist the per-ledger selection IN MEMORY for the session (per Q29 — no server/config persistence for the TUI); seed from defaultColumns(ledgerName) so the tasks view shows suggestedModel by default. Keep row layout readable within the pane width."
- acceptance: "ink-testing-library tests: (1) opening the tasks ledger shows a suggestedModel column by default; (2) the column overlay toggles a field on/off and the list rows gain/lose that column; (3) selection persists while navigating away and back within the session. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T60"]
- ledgerRefs: ["goals:G2"]
- resultCommit: a7d66b3
- completion: TUI column-selector Overlay (pickColumns, key 'c', documented) over eligibleColumnFields; extra columns render after id|status before summary (T31 alignment preserved); per-ledger in-memory (Q29), seeded from defaultColumns (tasks→suggestedModel); 3 ink tests. Reviewer approve 0/0. Merged a7d66b3 (recovered onto main after a stray verify-worker left the checkout on implement/T78); integration 552 pass.

### T63 — done

- createdAt: 2026-06-02T08:48:27.429Z
- updatedAt: 2026-06-02T12:48:15.974Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: batch-answer modal stepping open questions (sidebar button, larger font, prev/next + kbd nav)"
- description: "Item #5 (web). Per Q33: add a button at the BOTTOM of the left sidebar (lw-sidebar, App.tsx L838) that opens a large modal/popup (reuse the HelpOverlay backdrop pattern) which steps through all UNANSWERED (open) answerable items one at a time in a focused, LARGER-FONT layout. Each step shows the question fields (question, context, suggestions list, highlighted recommendation) and the same actions as the existing answerBox: 'save & mark answered' and 'as recommended' (canned AS_RECOMMENDED_ANSWER), advancing to the next open question after a save. Add explicit LEFT/RIGHT navigation buttons in the popup AND keyboard navigation via ctrl/cmd+[ (prev) and ctrl/cmd+] (next) (Q33 addendum). Scope: ANY answerable ledger via canAnswer (status.ts), DEFAULTING to the questions ledger. The set of 'open questions' = items where canAnswer(schema,status) is true and the item is not yet answered; fetch the questions ledger (default) for its open items. Esc closes. Uncontrolled answer textarea (refs) for happy-dom."
- acceptance: "happy-dom tests: (1) the sidebar-bottom button opens the batch modal; (2) it shows the first open question with a larger-font class and the suggestions as a list; (3) prev/next buttons and ctrl+]/ctrl+[ move between open questions; (4) 'save & mark answered' writes the answer + answered status and advances; 'as recommended' writes AS_RECOMMENDED_ANSWER; (5) Esc closes. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T56"]
- ledgerRefs: ["goals:G2"]
- resultCommit: e677b77
- completion: "Web batch-answer modal: sidebar-bottom button opens a larger-font HelpOverlay-style modal stepping all open answerable questions (canAnswer + not-answered, from questions ledger); save&mark-answered + as-recommended over client.updateItem; prev/next buttons + ctrl/cmd+[ /] kbd nav; Esc closes. 5 happy-dom tests. Reviewer approve 0/0."

### T64 — done

- createdAt: 2026-06-02T08:48:33.730Z
- updatedAt: 2026-06-02T12:48:18.835Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: batch-answer full-screen overlay stepping open questions (keybinding, prev/next nav)"
- description: "Item #5 (TUI). Per Q33: add a dedicated full-screen Overlay variant (extend the Overlay union at app.tsx L170-179, e.g. { t: 'batchAnswer'; rows; idx }) entered by a keybinding (document it in the key hints), that steps through all UNANSWERED (open) answerable items one at a time using the existing answer prompt (TextPrompt) plus the 'as recommended' shortcut (AS_RECOMMENDED_ANSWER when the item hasRecommendation). After each save (mark answered), auto-advance to the next open item. Provide prev/next navigation within the overlay (e.g. left/right arrows or a documented key pair). Scope to ANY answerable ledger via canAnswer, defaulting to the questions ledger (fetch it for open items if not already on it). Esc exits the overlay. Reuse the existing answer overlay's write path (status→answered + answer field)."
- acceptance: "ink-testing-library tests: (1) the keybinding opens the batch overlay showing the first open question; (2) submitting an answer marks it answered and advances to the next open question; (3) the 'as recommended' shortcut writes AS_RECOMMENDED_ANSWER; (4) prev/next moves between open questions; (5) Esc exits. `bun run check` green."
- suggestedModel: frontier
- dependsOn: ["T57"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 8bfd320
- completion: "TUI batch-answer full-screen Overlay ('b'): steps open answerable items (canAnswer + not-answered, default questions ledger); Enter saves+advances, Ctrl+R as-recommended (gated on hasRecommendation), Left/Right prev-next (clamped), Esc exits; write path at parity with single-item applyAnswer. 5 ink tests. Reviewer approve 0/0."

### T65 — done

- createdAt: 2026-06-02T08:48:43.847Z
- updatedAt: 2026-06-02T11:14:42.891Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "MCP server: expose project displayName (basename of --cwd) via serverInfo/instructions"
- description: |
    Item #7 (server side). Per Q35: the frontends are pure MCP clients and never read the cwd, so the project directory name must come from the server. GROUNDED against packages/ledger-mcp/src/main.ts (the planner's referenced `server.ts` does NOT exist — main.ts is the wiring):
    
    - The MCP server is constructed in `buildServer(store)` (main.ts L183-190) as `new McpServer(SERVER_INFO, { capabilities, instructions: SERVER_INSTRUCTIONS })`, where `SERVER_INFO = { name: 'ledger-mcp', version: '0.0.1' }` is a module constant (L49). `buildServer` today takes ONLY `store`, NOT cwd — so the cwd basename must be threaded through.
    - The resolved `--cwd` (absolute per CLAUDE.md) already flows to `createEmbeddedStore(cwd)` (L198-202). Compute `displayName = path.basename(cwd)`.
    
    THREADING (required): change `buildServer` to accept the display name (or the cwd) in addition to `store` — e.g. `buildServer(store, displayName)`. Update ALL call sites: the standalone stdio/HTTP binary path, `attachMcpHttp`/the co-hosted HTTP host, the embedded TUI in-memory-transport host, and the embedded web co-hosted `/mcp` host — every site that calls `buildServer` must pass the basename derived from the same resolved cwd used for the store.
    
    NAMED CARRIER (decide here, do NOT defer): the MCP `Implementation`/serverInfo type carries `{ name, version, title }`. Convey the project display name on `serverInfo.title` (set `SERVER_INFO`'s per-instance `title` to the basename, keeping `name`/`version` stable) — the spec-blessed human-readable carrier the SDK exposes via the client's `getServerVersion()` Implementation object. (If a runtime SDK version omits `title` on Implementation, fall back to embedding it on `instructions` as a stable leading line the client parses — but title is the primary carrier.) Keep it absolute-cwd safe and stable across reconnects (the per-session McpServer must report the same title every time).
- acceptance: A test (against the in-process/embedded server or the McpServer init result) asserts that when `buildServer` is given a cwd whose basename is e.g. 'cq1', the server's connect-time `serverInfo.title` (the named carrier — title primary, instructions fallback) equals 'cq1', and that `name`/`version` are unchanged. All `buildServer` call sites (standalone, HTTP, embedded TUI, embedded web) compile with the threaded cwd/displayName. `bun run check` green.
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: 8b553a8
- completion: "buildServer(store, displayName) threads basename(--cwd) to serverInfo.title (per-instance; name/version stable) + instructions fallback line; all call sites updated (standalone stdio/HTTP, attachMcpHttp/serveHttp, embedded TUI, embedded web). Test: getServerVersion().title==='cq1'. Reviewer approve 0/0. Merged 8b553a8; integration 522 pass."

### T66 — done

- createdAt: 2026-06-02T08:48:51.917Z
- updatedAt: 2026-06-02T11:32:40.171Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "LedgerClient: expose serverInfo()/displayName accessor (both impls + test fakes)"
- description: |
    Item #7 (client interface). Add a method to the LedgerClient interface (packages/ledger-web/src/types.ts L59-70; and the TUI's equivalent types) to read the server's project display name surfaced in T65 — e.g. `displayName(): string` (or `serverInfo(): { displayName: string }`), captured at connect.
    
    Real client (McpLedgerClient): read the display name from the SAME named carrier T65 writes — the MCP `Implementation.title` returned by the SDK client's `getServerVersion()` (the serverInfo captured at initialize). If T65 used the `instructions` fallback, read it via the client's `getInstructions()` and parse the agreed leading line; the carrier read here MUST match the carrier T65 wrote (title primary). Capture/cache it at connect time so the accessor is synchronous for the title-rendering tasks.
    
    Fakes: implement the same accessor in BOTH in-memory test fakes (web + TUI), returning a configurable display name (default e.g. 'cq1').
- acceptance: Typecheck passes with the new interface method implemented by McpLedgerClient and the in-memory fakes (web + TUI). A unit test drives the fake and reads back the configured displayName. A test asserts McpLedgerClient surfaces the basename from the REAL carrier T65 wrote (serverInfo.title via getServerVersion(), or instructions via getInstructions() if that fallback was used) — not merely the fake. `bun run check` green.
- suggestedModel: standard
- dependsOn: ["T65"]
- ledgerRefs: ["goals:G2"]
- resultCommit: d30a148
- completion: "displayName() added to LedgerClient interface (web+TUI) + all impls/fakes; McpLedgerClient reads T65's serverInfo.title (getServerVersion) primary + 'Project:' instructions fallback, cached at connect; fake+real-carrier tests. Reviewer approve 0/0. Merged d30a148 (auto-merged cleanly with T57's TUI test edits); integration 530 pass."

### T67 — done

- createdAt: 2026-06-02T08:48:59.249Z
- updatedAt: 2026-06-02T12:56:55.865Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: render '[<dir>] LLM ledgers' as document.title + header"
- description: "Item #7 (web render). Using the displayName from T66, set the browser document.title to '[<dir>] LLM ledgers' (e.g. '[cq1] LLM ledgers') once connected (replacing the hardcoded <title>ledger-web</title> in index.html — set it dynamically on connect), and replace the in-app header span text 'ledger-web' (App.tsx L758) with the same '[<dir>] LLM ledgers' string. Fall back gracefully (e.g. just 'LLM ledgers' or the prior text) if displayName is unavailable before connect."
- acceptance: "happy-dom test: after connecting with a fake whose displayName is 'cq1', document.title === '[cq1] LLM ledgers' and the header shows the same text. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T66"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 66dddd4
- completion: "Web: appTitle = '[<dir>] LLM ledgers' from client.displayName() (fallback 'LLM ledgers' pre-connect); useEffect sets document.title; header span renders it; index.html default updated. happy-dom test asserts both document.title + header. Reviewer approve 0/0."

### T68 — done

- createdAt: 2026-06-02T08:49:03.471Z
- updatedAt: 2026-06-02T12:56:58.657Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI: render '[<dir>] LLM ledgers' as the header"
- description: "Item #7 (TUI render). Using the displayName from T66, replace the TUI header text 'ledger-tui' with '[<dir>] LLM ledgers' (e.g. '[cq1] LLM ledgers'). Fetch/read the displayName at connect time and store it in app state; fall back to a neutral label if unavailable. Keep the header layout (conn status, live indicator, hints) intact."
- acceptance: "ink-testing-library test: with a fake whose displayName is 'cq1', the rendered header frame contains '[cq1] LLM ledgers'. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T66"]
- ledgerRefs: ["goals:G2"]
- resultCommit: be4287b
- completion: "TUI: header renders '[<dir>] LLM ledgers' from client.displayName() (fallback 'ledger-tui'); header layout (conn status, LiveBadge, hints) intact. ink test asserts frame contains '[cq1] LLM ledgers'. Reviewer approve 0/0."

## M18

### T79 — done

- createdAt: 2026-06-02T10:35:48.260Z
- updatedAt: 2026-06-02T13:26:36.679Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web #9: unify archived milestone-groups into the active subsection renderer + 'archived' badge"
- description: |
    Item #9 (WEB-ONLY per Q38/Q39). Today active non-milestones items render as per-milestone collapsible <section> subsections via ItemTable (packages/ledger-web/src/App.tsx L1283-1353: header button with id+title+[status], then the id/status/summary table), while ARCHIVED milestones render via a SEPARATE component ArchiveSection (App.tsx L1404-1484) as a flat row of lw-archive-pointer <button>s where clicking ONE pointer fetches and shows only that group's items below — exactly the reported 'they look like buttons / only one is visible'.
    
    FIX (per Q38 chosen recommendation): render each archived milestone-group through the SAME subsection renderer as active groups — each archived group becomes its own collapsible <section> with the same id/title + id/status/summary table — listed AFTER the active sections, ALL present at once (not click-to-reveal). The ONLY visual difference is an 'archived' badge in each section head (reuse the existing .lw-archived-badge class, styles.css L644). Archived sections DEFAULT COLLAPSED and LAZY-FETCH their items (fetch_ledger_archive per pointer) on first expand (parity with the current per-pointer fetch; avoids fetching every archive up front). Remove/retire the lw-archive-pointer button path. Keep the active-section rendering unchanged.
    
    NOTE: this is the same subsection renderer touched by #10 (milestone-status badge) and #12 (goals flat-list); coordinate so the unified renderer still honors the goals-specific flat-list override (T-goals-flat) and the milestone-status badge (T-ms-badge-web).
- acceptance: "happy-dom test: with >=2 archived milestone-groups, ALL of them render as collapsible <section> elements (same structure/class as active subsections), each carrying an 'archived' badge in the head; none renders as an lw-archive-pointer button. An archived section is collapsed by default and fetches its items (via the archive fetch) only on first expand. Active sections are unaffected. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: 0cddb64
- completion: "Archived milestone-groups unified into the active collapsible <section> subsection renderer (shared SubsectionItemTable + MilestoneSubsection), each with an 'archived' badge, listed after active sections, all present at once; default collapsed; single lazy-fetch via fetchLedgerArchive on first expand (cached). lw-archive-pointer path + dead state/CSS retired. Round 1: restored error handling (.catch→setFlash, retryable error placeholder, re-expand retries) with a reproduced rejection test. Reviewer approve round 1."

### T80 — done

- createdAt: 2026-06-02T10:35:55.985Z
- updatedAt: 2026-06-02T13:39:09.463Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web #10: render milestone-section status as a badge from the shared M12 palette"
- description: |
    Item #10 (web half; DEPENDS ON M12 T50/T52 — the 'warning' bucket + canonical bucket->color palette/CSS vars). Today the milestone status in a web subsection header is plain text inside the label: ItemTable builds headerLabel = '<id>: <title> [<status>]' rendered in a single <span class=lw-ms-label> (packages/ledger-web/src/App.tsx L1293-1295).
    
    FIX: render the milestone status using the SAME status badge as item rows (<span class='lw-status lw-status-<bucket>'>, App.tsx L1337) driven by the shared M12 source. Compute the bucket via statusBucket(milestone.status, MILESTONES_SCHEMA) — the milestones schema must be threaded into the header so terminal classification (open/done/postponed/blocked) is correct. Remove the inline '[<status>]' text from the label and render the badge element instead. Applies to both the active subsection heads and (after #9) the archived subsection heads.
- acceptance: "happy-dom test: a milestone subsection head renders the status as a <span class='lw-status lw-status-<bucket>'> (NOT bare '[status]' text), with the bucket derived via statusBucket against the milestones schema (e.g. an 'open' milestone -> the start/progress bucket class, a 'done' milestone -> the done bucket class). `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T52"]
- ledgerRefs: ["goals:G2"]
- resultCommit: a2736d0
- completion: "Web active milestone subsection head renders status as <span class='lw-status lw-status-<bucket>'> via statusBucket (local MILESTONE_STATUS_SCHEMA mirrors canonical, avoids @cq/ledger main index in browser bundle); bare [status] removed from headerLabel. 2 happy-dom tests (badge+bucket class, absence of bare [status]). Archived heads omitted (no reachable status — filed D5, out of scope). Reviewer approve 0/0."

### T81 — done

- createdAt: 2026-06-02T10:36:07.803Z
- updatedAt: 2026-06-02T13:26:40.832Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI #10: color milestone-section header status via statusColor (shared bucket source)"
- description: |
    Item #10 (TUI half; DEPENDS ON M12 T50/T51 — the 'warning' bucket + TUI BUCKET_COLOR). Today buildItemEntries builds the milestone subsection header label '<id> <title> [<status>]' as a plain STRING rendered as a non-selectable header line (packages/ledger-tui/src/app.tsx L137-145, L141). Ink has no bordered-badge primitive, so the parity for #10 is a color-coded status token.
    
    FIX (per Q40 recommendation): change the header ListEntry so it carries a RENDERED element (not just a plain string) for milestone subsection heads — render the id/title text plus the status token colored via statusColor(milestone.status, MILESTONES_SCHEMA) from the shared TUI bucket source. Thread the milestones schema into the header build so terminal classification (open/done/postponed/blocked) is correct. Keep non-milestone-header entries unchanged. COORDINATE with #13 (T-tui-navperf): the header build feeds buildItemEntries which #13 memoizes — the memo keys must remain valid after this change.
- acceptance: "ink-testing-library test: a milestone subsection header renders the status token in the statusColor for its bucket (e.g. assert the Text color prop / frame for an 'open' vs 'done' milestone differs and matches statusColor against the milestones schema), rather than uncolored '[status]' text. Non-milestone rows unchanged. `bun run check` green."
- suggestedModel: standard
- dependsOn: ["T51"]
- ledgerRefs: ["goals:G2"]
- resultCommit: c00006b
- completion: "TUI milestone subsection header renders the status token colored via statusColor(status, MILESTONES_SCHEMA) (open→cyan, done→green); ListEntry gained optional node?:ReactNode (label preserved for T85 memo stability), ScrollList renders node||label. Round 1: replaced whole-frame ANSI assertions with buildItemEntries node-prop unit tests (reproduction verified: 3/4 fail without source coloring). Merge resolved a test-file conflict (kept main's T62 block + T81 block). Reviewer approve round 1."

### T82 — done

- createdAt: 2026-06-02T10:36:15.468Z
- updatedAt: 2026-06-02T14:09:55.680Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web #11: CSS column proportions — id/status hug content, summary takes remainder (all web tables)"
- description: |
    Item #11 (WEB-ONLY per Q41; TUI already content-sizes via padEnd and is untouched). The web .lw-table is width:100% with border-collapse:collapse and NO table-layout/colgroup, so the browser's automatic table layout distributes width by content and over-allocates id/status (the reported ~1/5 id, ~2/5 status, ~2/5 summary). .lw-summary-cell already uses max-width:0 + ellipsis (styles.css L306-311).
    
    FIX (CSS-level): size id/status columns to their content via a <colgroup> with width:1% + white-space:nowrap, and let the summary column take the remaining width. Apply to ALL web table variants that share .lw-table: the active per-milestone subsection tables, the flat milestones-ledger table, and the archive table (after #9 unifies it). Define the sizing as a REUSABLE rule — 'narrow scalar columns hug content, the long/summary column flexes' — so the column-selector work (M14 T60-T62) can inherit the same rule for arbitrary dynamic columns. Standalone CSS change on TODAY's fixed id/status/summary tables; does NOT depend on T60-T62 (per Q41 chosen recommendation), but note the relationship.
- acceptance: "happy-dom test (or computed-style assertion) on each web table variant: the id and status columns are sized to content (colgroup width:1% + white-space:nowrap applied) and the summary column receives the remaining width; the over-allocation is gone. The sizing rule is expressed once and reused across the three table variants. `bun run check` green."
- suggestedModel: standard
- ledgerRefs: ["goals:G2"]
- resultCommit: 4b2eb9e
- completion: "Web .lw-col-narrow rule (width:1% + white-space:nowrap) defined once + <colgroup> in all 3 table variants (SubsectionItemTable active+archive, ItemTable flat milestones, dynamic extra columns); summary <col> unsized takes remainder. col/cell counts derive from same extraColumns array (can't drift). 4 happy-dom tests per variant. Reviewer approve 0/0."

### T83 — done

- createdAt: 2026-06-02T10:36:28.534Z
- updatedAt: 2026-06-02T14:22:12.026Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web #12: GOALS ledger as a flat list (no coordination subsections) showing fields.milestones"
- description: |
    Item #12 (web half; USER-DEVIATED answer Q48 — follow the user's literal instruction, NOT the planner's recommendation). User answer: 'Do not show milestones in Goals ledger items view - it should be a FLAT LIST without subsections - as milestones list.'
    
    Today non-milestones ledgers (incl. goals) render as per-milestone collapsible subsections keyed on the coordination group id g.id (packages/ledger-web/src/App.tsx L1284-1297), and DetailPanel appends a trailing single 'milestone: <coordinationId>' row (App.tsx L1839-1840). goals.fields.milestones (the work-milestone id[], e.g. G2->[M12,M13,M14,M18,M19]) is never displayed.
    
    FIX (GOALS ledger ONLY, isGoals(schema)): (a) render the goals LIST as a FLAT table — do NOT group goals into coordination-milestone subsections (suppress the per-milestone <section> grouping for goals); (b) in the goals DETAIL panel, REPLACE the single coordination-milestone row with a `milestones` list rendered from fields.milestones (the work-milestone ids), and suppress any single 'milestone' column for goals. Leave all OTHER ledgers' subsection grouping and detail rendering unchanged. Coordinate with #9/#10 (subsection renderer) and the column work (T60/T61) so the goals override composes cleanly.
- acceptance: "happy-dom test on the GOALS ledger: the list renders as a single flat table with NO per-coordination-milestone <section> subsections; the detail panel for a goal shows a `milestones` list containing the work-milestone ids from fields.milestones (e.g. M12, M13, M14) and does NOT show a single coordination 'milestone' row/column. Non-goal ledgers still render their per-milestone subsections and single milestone row unchanged. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: c272f78
- completion: Web goals ledger renders flat (ItemTable isGoals branch — no coordination-milestone subsections, no milestone column); goal DetailPanel renders fields.milestones (M12/M13/M14) as a `milestones` list replacing the single coordination `milestone` row; milestones lifted from generic field map (no double-render). Non-goal ledgers unchanged. Mirrors TUI T84; composes with T79/T80. Reviewer approve 0/0 (reproduction confirmed).

### T84 — done

- createdAt: 2026-06-02T10:36:35.467Z
- updatedAt: 2026-06-02T13:39:12.713Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI #12: GOALS ledger as a flat list (no subsection headers) showing fields.milestones"
- description: |
    Item #12 (TUI half; USER-DEVIATED answer Q48). Mirror of the web fix for the TUI. Today buildItemEntries groups rows under per-coordination-milestone subsection headers (packages/ledger-tui/src/app.tsx L137-145) and ContentPane shows a single 'milestone <coordinationId>' line (app.tsx L1082); goals.fields.milestones is never shown.
    
    FIX (GOALS ledger ONLY): (a) for the goals view, build a FLAT entry list with NO per-milestone subsection headers (skip the coordination-milestone grouping in buildItemEntries when the active ledger is goals); (b) in ContentPane for a goal, REPLACE the single 'milestone <id>' line with a `milestones` list rendered from fields.milestones (the work-milestone ids). Leave other ledgers' subsection grouping and the 'milestone <id>' line unchanged. COORDINATE with #13 (memoized buildItemEntries) and #10 (TUI header element) so the goals branch composes with those changes.
- acceptance: "ink-testing-library test on the GOALS ledger: the list frame shows goals as a flat list with NO milestone subsection header lines; the content pane for a goal shows a `milestones` list of the work-milestone ids from fields.milestones (e.g. M12, M13, M14) and not a single coordination 'milestone <id>' line. Other ledgers' grouping/content unchanged. `bun run check` green."
- suggestedModel: frontier
- ledgerRefs: ["goals:G2"]
- resultCommit: 999af06
- completion: TUI goals ledger renders flat (buildItemEntries isMilestones→generalized `flat`; call site flat for milestones+goals); goal ContentPane lifts fields.milestones into a leading `milestones` list and suppresses the single 'milestone <coordinationId>' line; milestones field filtered from generic iteration (no double-render); T81 coloring + other ledgers unchanged. 3 ink tests. Reviewer approve 0/0.

### T85 — done

- createdAt: 2026-06-02T10:36:52.987Z
- updatedAt: 2026-06-02T14:09:57.469Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "TUI #13: memoize the per-keystroke O(N) list derivations (nav latency fix)"
- description: |
    Item #13 (TUI; FIX task — cause localized to the render path, NO /investigate needed per Q49). Symptom: TUI navigation latency GROWS with item count — the pause when moving the cursor up/down scales O(N) in the ledger size.
    
    ROOT CAUSE (grounded in packages/ledger-tui/src/app.tsx): every cursor move does patchTop({cursor}) -> setStack -> a FULL re-render of App; the items-frame render body (L644-714) is NOT memoized, so on EVERY keystroke it (i) re-filters all rows via visibleRows (L644; visibleRows is a useCallback but is CALLED fresh each render), (ii) recomputes maxIdW by reducing over ALL rows (L672) and maxStatusW over all status values (L673), and (iii) rebuilds the ENTIRE ListEntry array via buildItemEntries (L125-147, L676). The draw itself is already windowed (ScrollList maps only the visible slice `win`, L941-971), so the O(N) cost is the per-keystroke RECOMPUTE, not the row paint.
    
    FIX (per Q49 chosen recommendation): wrap the three derivations — visibleRows result, maxIdW/maxStatusW, and the buildItemEntries entries — in useMemo keyed on (view, filter, showArchive, archiveRows) so a pure cursor move does NO O(N) work. The memo keys MUST also include whatever the other render-path tasks add: the column selection from T62 (#1 TUI columns) and the rendered-header-element change from T81 (#10 TUI badge) / T84 (#12 goals flat branch). Defer the React.memo list-extraction unless the memoization alone proves insufficient.
    
    REPRODUCTION-FIRST (repo policy): write a documented keystroke-latency repro / a 'heavy builders invoked once per data-change, not per keystroke' assertion at large N (≈500/1000 items) that FAILS before the fix (builders run per keystroke) and PASSES after.
- acceptance: A test asserts the heavy derivations (visibleRows/maxIdW/maxStatusW/buildItemEntries) execute ONCE per data-change (view/filter/showArchive/archiveRows change) and NOT on a pure cursor move — e.g. instrument call counts and move the cursor N times with zero additional builder invocations. The repro demonstrably failed before the memoization (builders ran per keystroke). Navigation behavior (selection, scrolling) is unchanged. `bun run check` green.
- suggestedModel: frontier
- dependsOn: ["T62","T81","T84"]
- ledgerRefs: ["goals:G2"]
- resultCommit: 84a9196
- completion: "TUI nav-perf: 3 O(N) derivations (filterVisibleRows, computeColumnLayout, buildItemEntries) hoisted to module scope + one useMemo (ItemsDerived) keyed on view/ledger/filter/showArchive/archiveRows/columnsKey — NOT cursor; input handler + render body both read the bundle. Pure cursor move = zero O(N) work; reproduction verified (top.cursor in deps → 40 builds). Round 1: replaced NUL memo-key separator with '|'. Orchestrator integration fix: navMemo test reset counters before measure + waitQuiescent (module-global counters cross-file polluted). full check 584/0."

## M21

### T90 — done

- createdAt: 2026-06-02T16:17:46.146Z
- updatedAt: 2026-06-02T18:25:13.017Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: do not render archived subsections for the MILESTONES ledger (fix D7 / item 16)"
- description: Fixes D7 (G2 follow-up #4 item 16). In packages/ledger-web/src/App.tsx, gate the `<ArchiveSubsections .../>` render (currently at ~L1193-1205, conditioned only on `showArchive && view.archivePointers.length > 0 && client !== null && ledger !== null`) on `!isMilestones`, so the milestones ledger view does NOT render archived per-milestone subsections (each archived milestone is already its own row in the flat ItemTable isMilestones branch; rendering it again duplicates it). `isMilestones` is already computed/in scope in App. Do NOT change the non-milestones path — those ledgers must still show their archived coordination-milestone subsections. Surgical change.
- acceptance: "happy-dom test: with the MILESTONES ledger selected and showArchive enabled, no `data-testid=archive-section` (and no archived `ms-section-*` duplicating an already-listed milestone row) is rendered; with a NON-milestones ledger selected and showArchive enabled, the archive subsections still render. `bun run check` (bun test + tsc -b + eslint) passes."
- suggestedModel: standard
- ledgerRefs: ["defects:D7","goals:G2"]
- resultCommit: 208b446
- completion: Added `&& !isMilestones` to the ArchiveSubsections JSX gate (App.tsx ~L1193) so the MILESTONES ledger no longer renders archived per-milestone subsections (already shown as flat rows); non-milestones unchanged. fakeClient milestones-archive entry + 2 happy-dom tests (repro fails pre-fix). Reviewer approve 0/0.

### T91 — done

- createdAt: 2026-06-02T16:17:55.978Z
- updatedAt: 2026-06-02T18:48:58.607Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: archived milestone section heads show milestone title, not description (fix D8 / item 17)"
- description: |
    Fixes D8 (G2 follow-up #4 item 17). In packages/ledger-web/src/App.tsx the ArchiveSubsections component builds the head label from the archive pointer `summary` (~L2000: `p.summary.length > 0 ? `${p.id}: ${p.summary}` : p.id`), which carries the milestone DESCRIPTION, not its TITLE. Active milestone sections show the title. Render the milestone `title` in archived heads for parity.
    
    MECHANISM IS NOT IMPLEMENTER'S CHOICE (R73 revision): archived sections default COLLAPSED and lazy-fetch their group content on first expand (ArchiveSubsections ~L1939-1981; app.test.tsx L724-754). Deriving the title from the lazily-fetched ArchiveContent group payload (c.milestone.title) only populates AFTER expand, so a COLLAPSED head built that way would show p.id / p.summary (description) — NOT the title. Therefore the title MUST come from EXTENDING the ArchivePointer payload at the MCP/server boundary: add a `title` field to the ArchivePointer shape in packages/ledger/src/types.ts (ArchivePointer ~L155) AND populate it wherever the server builds archive pointers (the `archivePointers[]` returned by fetch_ledger), then use `p.title` for the archived head label. This is a small `@cq/ledger` + server change. No back-compat constraint (dogfood only).
    
    COORDINATE WITH D5 (R73 non-blocking note): open defect D5 proposes the SAME ArchivePointer-payload extension to carry the milestone terminal `status` (for the #10 archived-head status badge). Do the payload extension ONCE: add BOTH `title` and `status` to the ArchivePointer shape + server build in this task, so D5 does not require a second boundary edit. This task closes the `title` half (its own acceptance) and lands the `status` field too; note that on D5 (D5 stays open for its consuming badge-render work, but its payload-extension prerequisite is satisfied here). Reference defects:D5.
    
    Coordinate with T90: both edit the App.tsx archive render path — sequence after T90 to avoid merge contention. Keep the change surgical.
- acceptance: "happy-dom test: a COLLAPSED (un-expanded) archived milestone section head displays the milestone `title` (NOT its long `description`) — this is satisfiable only via the ArchivePointer-payload `title`, which the test thereby exercises. A unit/type assertion covers the extended ArchivePointer shape (new `title` field, and `status` landed for D5), and the server populates both. `bun run check` (bun test + tsc -b + eslint) passes."
- suggestedModel: standard
- dependsOn: ["T90"]
- ledgerRefs: ["defects:D8","defects:D5","goals:G2"]
- resultCommit: 98e50c6
- completion: "Extended ArchivePointer with title+status, populated at archive time in both FsLedgerStore + InMemoryLedgerStore; frontmatter parser backward-compat defaults; archived head label p.summary→p.title. happy-dom collapsed-head title test (repro-verified). Lands status field for D5/T104. Reviewer approve 0/0 (filed out-of-scope D10: InMemory partial-mutation parity). Resolves D8."

### T92 — done

- createdAt: 2026-06-02T16:18:12.738Z
- updatedAt: 2026-06-02T18:49:01.916Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Retire routing-questions from the flow prompts per K13 (item 18): file-the-defect only, no `/investigate:start` pointer question"
- description: |
    Implements locked decision K13 (G2 follow-up #4 item 18), which REFINES K8/Q26 file-and-defer: the 'defer' half must NOT manifest as a `questions` item. Edit the prompt suite so orchestrators file the `open` defect (triage note in the defect's OWN fields) ONLY and never create a 'run /investigate:start <D>' routing question.
    
    WHERE THE REAL EDIT IS (R73 confirmation — do not hunt for non-existent text):
    1. llm/commands/implement/advance.md §3 — the ONLY file that actually contains a `/investigate:start <D>` routing-question step (the reviewer defects[] file-and-defer, ~L103-108). REAL DELETION: remove the step that creates the 'run /investigate:start <D>' open question; KEEP filing the open defect with the triage note in its fields.
    2. llm/commands/plan/advance.md — ALREADY CONFORMS to K13: its auto-investigate worklist is derived by LEDGER QUERY (~L87-98) and it contains NO routing-question creation. This is a VERIFY / guard step: confirm the LEDGER-QUERY framing still holds and that no routing-question text exists; expect a verify-no-op (no edit, or at most a one-line clarifying touch). Do NOT invent a deletion here.
    3. llm/agents/plan-reviewer.md — ALREADY CONFORMS: its defects[] bucket is report-only (~L62-78), no routing question. VERIFY-no-op / light touch only; confirm the report-only framing, do not invent a deletion.
    
    Preserve file-and-defer's NON-blocking property in all three (defects still do not block the in-scope task; still gate milestone archival until terminal). Rationale to embed in the edited prose: /investigate:start already accepts a BARE defect id (^D\d+$ intake-resume path), and an open defect linked via ledgerRefs is discoverable by ledger query — no pointer-question needed.
    
    NOTE — the one-time ledger-data cleanup half of item 18 is ALREADY DONE (this planning run): routing questions Q52 (D3/D4) and Q53 (D5/D6) were set status=withdrawn, and their triage notes were verified already present on the D3/D4/D5/D6 defect records (description + suggestedFix), so no fold was needed. This task is therefore the PROMPT EDITS only (effectively the single deletion in implement/advance.md §3 plus the two verify-confirmations); as a guard, assert no remaining `open` routing-question items exist.
- acceptance: "llm/commands/implement/advance.md §3 no longer instructs creating a `run /investigate:start <D>` routing question (it files the open defect with triage note only); llm/commands/plan/advance.md and llm/agents/plan-reviewer.md are confirmed already conforming (LEDGER-QUERY worklist / report-only defects[] bucket respectively — verify-no-op, no routing-question text present). All three explicitly preserve non-blocking file-and-defer. No `open` questions item remains whose sole purpose is an /investigate:start pointer (Q52/Q53 already withdrawn). `bun run check` passes (markdown-only edits should not regress it; run it to confirm)."
- suggestedModel: standard
- ledgerRefs: ["decisions:K13","goals:G2"]
- resultCommit: a858b51
- completion: "implement/advance.md §3: removed the create_item('questions',...) routing step (K13), kept open-defect filing + embedded bare-defect-id/ledger-query rationale; non-blocking property preserved. plan/advance.md + plan-reviewer.md verified no-op (already conform). Reviewer approve 0/0."

### T93 — planned

- createdAt: 2026-06-02T16:18:24.658Z
- updatedAt: 2026-06-02T16:25:31.317Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Web: make the batch-answer modal wider and taller with a slightly reduced font (item 19)"
- description: |
    G2 follow-up #4 item 19 (FEATURE/POLISH). The batch answer-questions modal (item #5 / T63, done @ commit e677b77, the `.lw-batch` dialog rendered by BatchAnswerModal in packages/ledger-web/src/App.tsx) is currently sized larger-font but cramped.
    
    RE-GROUNDED (R73 revision): packages/ledger-web/src/styles.css (full ~763-line file) contains NO `.lw-batch`, `.lw-batch-body`, or `.lw-batch-nav` rule today. The batch modal reused the HelpOverlay backdrop pattern; `.lw-batch` exists only as a MARKER class on the dialog element (queried in app.test.tsx L1039 as q('.lw-batch')) with no backing CSS rule, and `.lw-batch-body`/`.lw-batch-nav` are unconfirmed anywhere. So the work is to ADD/DEFINE new modal-sizing CSS rules, NOT to tune pre-existing ones.
    
    Work: FIRST confirm against the actual BatchAnswerModal JSX which element(s) carry the box / body / nav classes the rules must target. THEN in packages/ledger-web/src/styles.css ADD a rule for the batch dialog (`.lw-batch`) giving it an explicit WIDER + TALLER box (explicit width/height — larger than the current backdrop-default sizing — via viewport-relative caps like max-width/max-height with vw/vh) and a slightly REDUCED font-size, plus a body rule so long questions SCROLL inside the body (overflow handling) rather than overflowing the dialog. Keep it within the viewport. CSS-only change — no App.tsx logic edits, so this is disjoint from T90/T91 and can proceed in parallel. Match surrounding styles.css conventions.
- acceptance: "happy-dom assertion on the modal: the `.lw-batch` dialog renders carrying the expected sizing class/dimensions — assert its width/height (or max-width/max-height) and font-size resolve to the new larger-box / smaller-font values (via computed style or the literal newly-added CSS rule the test reads). Modal content scrolls within the body for long questions rather than overflowing. `bun run check` passes."
- suggestedModel: fast
- ledgerRefs: ["goals:G2"]

## M22

### T94 — done

- createdAt: 2026-06-02T16:31:03.192Z
- updatedAt: 2026-06-02T18:25:16.651Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Add backupAndReinit helper to FsLedgerStore
- description: "Add a private async helper on FsLedgerStore (packages/ledger/src/store/FsLedgerStore.ts) that backs up the divergent on-disk ledger state and reinitializes canonical files. Steps: (a) compute a timestamped backup dir under docs/.backup/<ISO-timestamp>/ using this.now() (sanitize the ISO string for filesystem safety, e.g. replace ':' so it is a valid dir name on all platforms); mkdir it recursively. (b) Copy/move the divergent on-disk ledger file(s) (this.ledgerPath(name) for the affected canonical ledgers) AND docs/ledgers.yaml (this.registryPath) into that backup dir, preserving filenames; tolerate ENOENT on any source (a registry/file may legitimately be absent). (c) Write fresh canonical registry + ledger(s) from CANONICAL_LEDGERS via the existing serializeRegistry/writeRegistry + freshLedger/writeLedgerFile primitives, seeding the milestones bootstrap group / ambient milestone exactly as the empty-dir path does. (d) Emit a single loud WARNING to process.stderr naming the absolute backup path. Keep the helper self-contained so init() just calls it on the divergence branch. Reuse existing fields: this.docsDir, this.registryPath, this.ledgerPath, this.now, freshLedger, serializeRegistry, writeRegistry, writeLedgerFile, seedBootstrapGroup/applyEnsureAmbientMilestone, CANONICAL_LEDGERS."
- acceptance: A private backup-and-reinit helper exists on FsLedgerStore that, given the set of divergent canonical ledgers, (1) creates docs/.backup/<sanitized-ISO-ts>/, (2) copies the prior ledger file(s) + docs/ledgers.yaml into it (ENOENT-tolerant), (3) rewrites fresh canonical registry + ledger files (milestones seeded), and (4) writes one stderr WARNING with the backup path. Verified by the tests in the dual-tests task. tsc clean (bun run typecheck).
- suggestedModel: standard
- ledgerRefs: ["defects:D2","goals:G4"]
- resultCommit: 0d66e33
- completion: "Private async backupAndReinit() on FsLedgerStore: docs/.backup/<sanitized-ISO-ts>/, copies CANONICAL_LEDGERS files + ledgers.yaml (ENOENT-tolerant, backup-before-reinit), rewrites fresh canonical (milestones+M-AMBIENT seeded), one stderr WARNING. 7 unit tests. init() NOT yet rewired (T95). Reviewer approve 0/0."

### T95 — done

- createdAt: 2026-06-02T16:31:16.074Z
- updatedAt: 2026-06-02T18:49:05.643Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Replace fatal throw at FsLedgerStore.init() divergence branch with backup-and-reinit (default) + opt-out flag
- description: |
    Rewire the !schemasEqual branch in FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:283-289). Currently it throws BootstrapViolationError. Change it so that, by DEFAULT, it collects the set of divergent canonical ledgers across the bootstrap loop and invokes the backupAndReinit helper (from T94) ONCE for that set, then continues startup normally. Add an opt-out: a constructor option on FsLedgerStoreOptions (the opts object destructured at ~line 150), e.g. `onSchemaDivergence?: 'backup-reinit' | 'abort'` (default 'backup-reinit'), stored as a private field; when set to 'abort', preserve the existing hard throw of BootstrapViolationError. Keep BootstrapViolationError defined and exported (packages/ledger/src/types.ts) for the opt-out path. Ensure the no-divergence (entry schema equal) and empty-dir (entry undefined → push canonical) paths are UNCHANGED.
    
    RE-LOAD MECHANISM — PINNED (no executor choice): T94's helper writes fresh canonical files via writeRegistry (which serializes this.registry) + writeLedgerFile. The helper MUST authoritatively update the in-memory this.registry IN PLACE to the fresh canonical state as part of its work — i.e. set this.registry.ledgers to the CANONICAL_LEDGERS schema entries (the same value it serialized to disk) so this.registry is the single source of truth. this.registry is exactly what the existing load loop at FsLedgerStore.ts:294-334 iterates; after backup-and-reinit completes, that load loop MUST iterate the FRESH canonical registry (not the stale divergent entries). Do NOT leave the alternative of re-deriving from the file vs in-place as an open choice — pin it to: helper mutates this.registry in place to canonical, load loop then reads the canonical in-memory registry and loads the fresh canonical ledger files. The end state: this.registry.ledgers schemas equal CANONICAL_LEDGERS schemas, and the in-memory ledgers loaded by the loop reflect the fresh canonical files, NOT the divergent prior state.
    
    Wire the flag through from main()/server construction only if trivially in scope; otherwise leave the default and note the wiring is unneeded for the fix.
- acceptance: "With default options, seeding a divergent on-disk ledger schema and calling init() does NOT throw: it backs up + reinitializes and completes init. Operationally verifiable post-reinit IN-MEMORY state: after a divergence-triggered init() with default options, this.registry.ledgers schemas equal the CANONICAL_LEDGERS schemas (NOT the divergent prior schema), and the in-memory loaded ledger for the affected name is fresh-canonical (canonical schema, no divergent prior items). With onSchemaDivergence:'abort', init() still throws BootstrapViolationError on divergence. No-divergence and empty-dir init paths behave exactly as before. tsc + lint clean."
- suggestedModel: frontier
- dependsOn: ["T94"]
- ledgerRefs: ["defects:D2","goals:G4"]
- resultCommit: a26104b
- completion: "init() !schemasEqual branch rewired: collects the divergent set, calls backupAndReinit ONCE by default (helper mutates this.registry in place to canonical → load loop reads fresh); FsLedgerStoreOpts.onSchemaDivergence ('backup-reinit'|'abort', default backup-reinit), 'abort' preserves the throw; no-divergence + empty-dir unchanged. Migrated the 6 canonical-ledgers divergence-guard cases to 'abort'. Reviewer approve 0/0. (D2 partial — T96/T97 remain.)"

### T96 — planned

- createdAt: 2026-06-02T16:31:28.465Z
- updatedAt: 2026-06-02T16:36:11.150Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Tests: schema-divergence backup-and-reinit (and abort opt-out) for FsLedgerStore.init() + MIGRATE existing divergence-guard suite"
- description: |
    Add tests in the FsLedgerStore test suite (alongside the existing init/bootstrap tests for packages/ledger, dual-tests pattern over a seeded tmpdir + injected now()), AND migrate the existing divergence-guard suite that T95's default flip will invert.
    
    MANDATORY MIGRATION (do not skip): packages/ledger/test/canonical-ledgers.test.ts:332-356 contains a parameterized suite `divergence guard fires for a hand-edited <name> schema` that runs for SIX canonical ledgers (defects, tasks, hypothesis, questions, decisions, goals). Each case seeds docs/ledgers.yaml with a divergent (superset statusValues) schema for one ledger and asserts `await store.init()` REJECTS with /different schema/ under DEFAULT options (`new FsLedgerStore({ root: dir })`). After T95 flips the default to backup-and-reinit (no throw on divergence), all six of those assertions INVERT and will FAIL. MIGRATE this suite to the new semantics: re-target each of the six cases to construct the store with the abort opt-out — `new FsLedgerStore({ root: dir, onSchemaDivergence: 'abort' })` — preserving the existing `rejects.toThrow(/different schema/)` assertion, thereby repurposing this suite as the abort-opt-out coverage for all six canonical ledgers. (Equivalently, the case may assert the new default backup-and-reinit behavior; the abort re-target is preferred because it keeps the per-ledger /different schema/ coverage.) Note: this existing suite seeds ONLY ledgers.yaml (no on-disk .md ledger file present), which is exactly why T94's ENOENT-tolerance on the per-ledger ledger file is load-bearing — keep the migration and T94 consistent on that (the backup step must tolerate the absent .md file).
    
    NEW CASES (default backup-and-reinit + regressions): (1) DIVERGENCE → BACKUP+REINIT (default): seed a tmpdir docs/ with a ledgers.yaml whose registry records a canonical ledger (e.g. goals) under a DIVERGENT schema plus its on-disk ledger file containing some prior items; construct FsLedgerStore with default options and an injected deterministic now(); call init(). Assert: init() resolves with NO throw; docs/.backup/<sanitized-ts>/ exists and contains the prior ledgers.yaml AND the prior divergent ledger file (byte-for-byte the seeded content); the live on-disk + in-memory ledger for that ledger is fresh-canonical (canonical schema, zero/seeded items); the milestones bootstrap group + ambient milestone are present. (2) ABORT opt-out (single representative case, separate from the migrated parameterized suite): same seed, construct with onSchemaDivergence:'abort'; assert init() rejects with BootstrapViolationError and the on-disk files are untouched (no backup dir created). (3) REGRESSION — no-divergence: seed a valid canonical docs/ with items; init() leaves files + items unchanged and creates NO backup dir. (4) REGRESSION — empty dir: empty tmpdir; init() auto-creates canonical set as before and creates NO backup dir. Capture stderr (or stub the warn path) to assert exactly one WARNING naming the backup path in case (1).
- acceptance: "The existing parameterized suite `divergence guard fires for a hand-edited <name> schema` in packages/ledger/test/canonical-ledgers.test.ts:332-356 is MIGRATED so its six cases construct the store with onSchemaDivergence:'abort' (still asserting rejects-with /different schema/), and NO test asserts that the DEFAULT init() throws on divergence. New tests cover divergence→backup+reinit (default, no throw), abort opt-out (throws, files untouched), no-divergence regression (unchanged, no backup), and empty-dir regression (unchanged, no backup). `bun test` passes for the new tests AND the migrated canonical-ledgers.test.ts suite with no inverted/failing assertions; the divergence test asserts the backup dir holds the prior file(s) and the live ledger is fresh-canonical."
- suggestedModel: standard
- dependsOn: ["T95"]
- ledgerRefs: ["defects:D2","goals:G4"]

### T97 — planned

- createdAt: 2026-06-02T16:31:36.255Z
- updatedAt: 2026-06-02T16:31:36.255Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Repo gate: bun run check green for the D2 fix"
- description: "Run the full repo gate from the root after T94/T95/T96 land: `bun run check` (bun test + bun run typecheck + bun run lint). Resolve any failures introduced by the change (type errors, lint, regressions in other packages that depend on FsLedgerStore or BootstrapViolationError). No new failures may be attributable to this change."
- acceptance: "`bun run check` exits 0 from the repo root with the D2 fix in place; no test/type/lint regressions."
- suggestedModel: fast
- dependsOn: ["T96"]
- ledgerRefs: ["defects:D2","goals:G4"]

## M24

### T98 — done

- createdAt: 2026-06-02T17:38:11.599Z
- updatedAt: 2026-06-02T18:25:19.503Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Realign @cq/ledger package.json exports/main to ./dist/src/* (D3)
- description: "packages/ledger/package.json declares main=./dist/index.js, exports['.']=./dist/index.js, exports['./relationships']=./dist/relationships.js, but tsc (tsconfig outDir ./dist, include [src,test], NO rootDir) emits under ./dist/src/ — those targets do not exist on disk. exports['./columns']=./dist/src/columns.js is the only correct entry (internal inconsistency). COMMITTED FIX (R77): realign main and EVERY exports entry to ./dist/src/* — main + exports['.'] → ./dist/src/index.js, exports['./relationships'] → ./dist/src/relationships.js, and leave exports['./columns'] = ./dist/src/columns.js as-is (already correct). Update each entry's .d.ts target to the matching ./dist/src/*.d.ts. This matches the already-correct ./columns entry, requires NO tsconfig change and NO test-layout restructuring. DO NOT set rootDir:'src': R77 verified that branch trips TS6059 ('File is not under rootDir') for every test/ file because tsconfig include is ['src','test'] (packages/ledger/tsconfig.json:10) and tsconfig.base sets no rootDir — so the flat-layout alternative is rejected. The web/mcp tsconfig paths→source entries mask this in-repo, so verification is on-disk after tsc, not via in-repo import."
- acceptance: "After `bun run build`/`tsc -b` of @cq/ledger, every file referenced by package.json main and each exports['.'|'./relationships'|'./columns'|'./constants'] target EXISTS on disk under ./dist/src/; all entries use the consistent ./dist/src/*.js layout; tsconfig.json is unchanged (no rootDir added); `bun run check` passes."
- suggestedModel: standard
- ledgerRefs: ["defects:D3","goals:G5"]
- resultCommit: b1878e7
- completion: "package.json main+types+exports['.']+['./relationships'] realigned ./dist/*.js → ./dist/src/*.js (./columns already correct); all targets confirmed present after tsc -b; tsconfig unchanged (no rootDir). Reviewer approve 0/0. (D3 partial — T99/T101 remain.)"

### T99 — done

- createdAt: 2026-06-02T17:38:20.429Z
- updatedAt: 2026-06-02T18:49:08.924Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Add browser-safe @cq/ledger ./constants subpath export + web tsconfig paths entry (D6)
- description: "Add a `./constants` entry to packages/ledger/package.json exports, pointing at ./dist/src/constants.js (with its matching ./dist/src/constants.d.ts) — the ./dist/src/* layout pinned by T98 — mirroring the existing ./relationships and ./columns entries. constants.ts (L25-27) has only a type-only import, so it is browser-safe in isolation (does NOT pull in FsLedgerStore / node:fs/node:path the way the '.' barrel does via index.ts:50). Add a `@cq/ledger/constants` paths→source entry to packages/ledger-web/tsconfig.json mirroring the existing ./relationships and ./columns paths entries. This task is sequenced AFTER T98 because it edits the same package.json exports block and must use the same (./dist/src/*) dist layout T98 settled."
- acceptance: "package.json exports['./constants'] resolves to ./dist/src/constants.js (existing after tsc); ledger-web/tsconfig.json has a @cq/ledger/constants paths→source entry; importing MILESTONES_SCHEMA from @cq/ledger/constants type-checks in ledger-web; `bun run check` passes."
- suggestedModel: standard
- dependsOn: ["T98"]
- ledgerRefs: ["defects:D6","defects:D3","goals:G5"]
- resultCommit: 81a370a
- completion: Added @cq/ledger ./constants subpath export (./dist/src/constants.js + .d.ts) + @cq/ledger/constants paths→source entry in ledger-web/tsconfig.json; MILESTONES_SCHEMA imports + type-checks from ledger-web (browser-safe; constants.ts type-only import). Reviewer approve 0/0. (D6 partial — T100 remains; D3 partial — T101 remains.)

### T100 — planned

- createdAt: 2026-06-02T17:38:28.719Z
- updatedAt: 2026-06-02T17:38:28.719Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Consume @cq/ledger/constants in ledger-web App.tsx; delete duplicated MILESTONE_STATUS_SCHEMA (D6)
- description: "In packages/ledger-web/src/App.tsx, replace the hand-maintained MILESTONE_STATUS_SCHEMA const (App.tsx:69-82, whose comment documents the duplication reason) with an import of MILESTONES_SCHEMA from @cq/ledger/constants (the subpath added in T99), and delete the duplicated literal. Update all references that used MILESTONE_STATUS_SCHEMA to use the imported MILESTONES_SCHEMA. Preserve the pure-MCP-client invariant — @cq/ledger/constants is data-only (schema constants), not a ledger-file reader, so this does not violate it. Sequenced after T99 (needs the export to exist)."
- acceptance: App.tsx no longer declares MILESTONE_STATUS_SCHEMA; it imports MILESTONES_SCHEMA from @cq/ledger/constants; status-badge / milestone-status rendering behaves identically; existing web happy-dom tests still pass; `bun run check` passes.
- suggestedModel: standard
- dependsOn: ["T99"]
- ledgerRefs: ["defects:D6","goals:G5"]

### T101 — planned

- createdAt: 2026-06-02T17:38:36.643Z
- updatedAt: 2026-06-02T17:38:36.643Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Add @cq/ledger test asserting every package.json export/main target exists after build (D3)
- description: "Add a bun:test in packages/ledger (e.g. packages/ledger/test/package-exports.test.ts) that reads packages/ledger/package.json, collects main + every exports['<subpath>'] target path (including the new ./constants), and asserts each referenced file EXISTS on disk after `tsc -b`. This guards against the D3 regression where declared export targets drift from the real tsc output layout. The test must run after a build (or build within the test setup) so dist exists. Sequenced after T98+T99 (the exports must be in their final corrected form, including ./constants)."
- acceptance: "New bun:test exists, fails against the pre-fix package.json (stale ./dist/index.js etc.), and passes against the corrected layout; `bun test` (ledger) and `bun run check` pass."
- suggestedModel: standard
- dependsOn: ["T98","T99"]
- ledgerRefs: ["defects:D3","goals:G5"]

## M25

### T102 — done

- createdAt: 2026-06-02T17:38:46.836Z
- updatedAt: 2026-06-02T18:25:22.326Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "Exclude summary-source fields {headline,title,question} from eligibleColumnFields + add columns unit test (D4)"
- description: "In packages/ledger/src/columns.ts, eligibleColumnFields (L55-72) currently excludes only LONG_FIELD_DENYLIST (L35-47) plus ALWAYS_SHOWN_COLUMNS {id,status,summary}; headline/title/question fall through and are offered as toggleable columns. Because summarize() (tui app.tsx:82-86, web App.tsx:181-185) picks headline ?? title ?? question ?? summary, selecting one of those columns renders the same text twice per row (extra column cell + summary cell). FIX: add a SUMMARY_SOURCE_FIELDS exclusion set {headline,title,question} to eligibleColumnFields so summary-source fields are never offered as redundant columns. (Dropping only the single field summarize() would pick per-schema is also acceptable, but a static {headline,title,question} exclusion is simpler and matches the suggestedFix.) Add packages/ledger/test/columns.test.ts (none exists today) asserting eligibleColumnFields on a schema containing headline OMITS headline (and title/question)."
- acceptance: eligibleColumnFields no longer returns headline/title/question; new packages/ledger/test/columns.test.ts asserts this and fails pre-fix, passes post-fix; the column picker no longer offers a redundant summary-duplicating column; `bun test` (ledger) and `bun run check` pass.
- suggestedModel: fast
- ledgerRefs: ["defects:D4","goals:G5"]
- resultCommit: 5cf4883
- completion: "Added SUMMARY_SOURCE_FIELDS {headline,title,question} excluded from eligibleColumnFields (grounded in summarize() precedence); suggestedModel still eligible. New ledger columns.test.ts (fails pre-fix) + tightened web columns.test.tsx. Reviewer approve 0/0."

## M26

### T103 — done

- createdAt: 2026-06-02T17:38:57.670Z
- updatedAt: 2026-06-02T17:44:19.190Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "WITHDRAWN (R77): no @cq/shared wire mirror exists — no wire half to extend (D5)"
- description: "WITHDRAWN by plan review R77 as misgrounded — NO WORK TO DO. R77 verified against source that there is NO @cq/shared package and NO Zod wire mirror of fetch_ledger's archivePointers[]. The server tool serialises store.fetch() via plain JSON.stringify with NO output schema (packages/ledger/src/mcp/ledgerTools.ts:158-163); the web client does `JSON.parse(text) as FetchedLedger` with NO runtime validation, and its ArchivePointer is a type-only re-export from @cq/ledger (packages/ledger-web/src/mcpClient.ts:116-119, types.ts:7-18). Therefore once T91 (G2/M21) adds `status` to the ArchivePointer interface (packages/ledger/src/types.ts:155-162) the field ALREADY flows over the wire into the web client — there is no separate 'wire half'. This corrects the H7 investigate finding (the goal's 'un-covered wire half' was factually wrong). D5 reduces to the single render task T104, which now dependsOn T91 directly. No code change associated with this task."
- acceptance: N/A — task withdrawn as redundant per R77; no deliverable. D5 is satisfied by T104 (render after T91) alone.
- suggestedModel: frontier
- blockedBy: []
- dependsOn: []
- ledgerRefs: ["goals:G5"]

### T104 — planned

- createdAt: 2026-06-02T17:39:05.288Z
- updatedAt: 2026-06-02T17:44:25.834Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Render archived MilestoneSubsection status badge from archived pointer status + happy-dom assertion (D5)
- description: "With T91 (G2/M21) extending ArchivePointer with title+status at the @cq/ledger types + server-build boundary, the archived pointer's `status` ALREADY flows over the wire to the web client (R77 confirmed there is NO separate wire schema — fetch_ledger serialises via plain JSON.stringify and the web client JSON.parses with no runtime validation; ArchivePointer is a type-only re-export). So this is the SOLE remaining D5 fix: pass the archived pointer's `status` as `milestoneStatus` to the archived MilestoneSubsection render (packages/ledger-web/src/App.tsx:2002-2008), mirroring the active head path (App.tsx:1853). The T80 badge is gated on milestoneStatus!==undefined (App.tsx:1659); once the archived path passes status, the badge renders for archived heads too. Add a happy-dom test asserting an archived milestone head renders its status badge (uncontrolled inputs / refs per the repo testing convention; selects may be controlled). dependsOn T91 directly (its true and only prerequisite — the ArchivePointer types extension). T103 was withdrawn by R77 as misgrounded."
- acceptance: Archived MilestoneSubsection heads render the status badge when status is present; new/extended happy-dom test asserts the archived-head badge appears and fails pre-fix; existing web tests still pass; `bun run check` passes.
- suggestedModel: standard
- dependsOn: ["T91"]
- blockedBy: ["T91"]
- ledgerRefs: ["defects:D5","goals:G5"]
