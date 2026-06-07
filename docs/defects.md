---
ledger: defects
counters:
  milestone: 0
  item: 35
archives:
  - id: M2
    path: ./archive/defects/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M14
    path: ./archive/defects/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/defects/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M21
    path: ./archive/defects/M21.md
    summary: "G2 follow-up #4 (items 16-19) — COMPLETE. T90 (!isMilestones gate, D7); T91 (ArchivePointer title+status extension, D8, lands status for D5); T92 (retire /investigate:start routing-questions per K13, item 18); T93 (batch-answer modal wider/taller/smaller-font/scrolls, item 19). Defects D7/D8 resolved; out-of-scope D9/D10 surfaced here, resolved via G6/M28 (T105/T106). Reviews R79/R83/R84/R90. Last G2 work milestone."
    title: "G2 follow-up #4: milestones-ledger archived rendering, routing-question retirement, batch-modal sizing"
    status: done
  - id: M28
    path: ./archive/defects/M28.md
    summary: G6 work milestone M28 — COMPLETE (auto-archived by the milestone-completion rule). Tasks T105 (D9), T106 (D10), T107 (D11), T108+T109 (D12) done; defects D9/D10/D11/D12 + the out-of-scope D14/D15/D16/D17 all resolved (via G7/M30); reviews R98-R102. Decisions K17/K18. Integration green.
    title: "G6 fixes: D9 test flake, D10 store parity, D11 sticky toolbar"
    status: done
  - id: M10
    path: ./archive/defects/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/defects/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M32
    path: ./archive/defects/M32.md
    summary: "G6 #3 work milestone — COMPLETE. ledger-mcp --reset (backup-first whole-tree reset) shipped; tasks T123/T131 done; defect D21 (reset ignored non-canonical ledgers) resolved; reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #3 — ledger-mcp --reset command (backup-first whole-tree reset)"
    status: done
  - id: M35
    path: ./archive/defects/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
  - id: M43
    path: ./archive/defects/M43.md
    summary: G11 W2 (@cq/ledger-mcp tool surface) — COMPLETE. T144 fetch_ledger compact/offset/limit params (fixes 51.8KB/142.7KB overflow); T145 snapshot tool; T146 reopen_item + unarchive_item; T147 read_log (bounded, root-confined); T148 tool-count reconciliation (14→18 across all refs); T149 query-language doc clarifications. Reviews R148-R153 go-ahead. Out-of-scope defects D25/D26 filed here, both later resolved (G13). Shipped on main.
    title: G11 W2 — @cq/ledger-mcp tool surface
    status: done
  - id: M45
    path: ./archive/defects/M45.md
    summary: G11 W4 (flow-prompt wiring) — COMPLETE. T153 advance.md §Provenance permits the single run-level handoffs write; T154 per-flow handoff writes with contextual /advance suppression; T155 sessionLogs population in each outcome write; T156 snapshot-first /advance bootstrap recipe. Reviews R155/R156/R158/R159 go-ahead (T154 r0 used an env var, fixed r1 → contextual). Out-of-scope defect D27 filed here, later resolved (G13). Docs/prompt-only. Shipped on main.
    title: G11 W4 — flow-prompt wiring (handoff writes + bootstrap recipe + docs)
    status: done
  - id: M48
    path: ./archive/defects/M48.md
    summary: "G13 fix work (D25/D26/D27 G11 follow-up cleanup) — COMPLETE. T158 (D26): readLog symlink-escape hardening (realpath both target+root); T159 (D25): removed stale eslint-disable; T160 (D27): reworded CHAINED handoff trigger + made start/follow-up wrappers the single handoff writer (7 files). Reviews R163/R164/R165 go-ahead (T158/T160 each r0 disapprove→r1 approve). H15/H16/H18 confirmed. Defects D25/D26 resolved (also D28 filed here from T158 review, resolved via G14). Merged 311b8a1."
    title: "G13 fix tasks: D25/D26/D27 code-quality cleanup"
    status: done
  - id: M52
    path: ./archive/defects/M52.md
    summary: "Investigation of D29 (empty-answer-accepted) complete: H19 (backend gap) + H20 (frontend gap) confirmed against source, root cause pinned, fix file-and-deferred to G16 and resolved this run. Q94 pointer withdrawn (fulfilled)."
    title: "Investigate: empty-answer-accepted"
    status: done
  - id: M61
    path: ./archive/defects/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M60
    path: ./archive/defects/M60.md
    summary: "Investigate D31 (web BatchAnswerModal premature-close) — COMPLETE. User-confirmed repro (Q103) flipped the prior 'does not reproduce' conclusion: H22 (suspected T163 regression) WRONG; H24 CONFIRMED — the modal backdrop closed on any click whose common-ancestor was the backdrop with no guard the press STARTED there; a press-and-hold on 'save & mark answered' (timer-fired) advanced to a shorter question, the dialog shrank while still pressed, and the release over the backdrop dismissed it (react-modal #466 class; vacuous test coverage cf. D24/H14). Root-caused → defect-seeded G21 → fixed (T183 RED + T184 shared useBackdropDismiss on all 3 overlays) → D31 RESOLVED. Q103 answered, Q112 (traceability) withdrawn."
    title: "Investigate: batch-answer-modal-premature-close"
    status: done
  - id: M73
    path: ./archive/defects/M73.md
    summary: "D33 investigated → root-caused (H25 confirmed via headless-chromium ground truth: computeDagLayout left layer 0 empty for cyclic graphs, not CSS) → resolved by G24/T199 (e9bf762). Q113 answered (use headless chromium)."
    title: "Investigate: sm-diagram-alignment (blocked on env)"
    status: done
  - id: M79
    path: ./archive/defects/M79.md
    summary: "Investigate D34 (top-bar progress 38/39) complete: root cause confirmed (H26 — denominator itemCount counts the terminal `withdrawn` question while numerator counts answered-only), file-and-deferred to G27, fix landed (T207-T209) and D34 resolved. HO15 handoff recorded."
    title: "Investigate: topbar-progress-undercount"
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

## M39

### D24 — resolved

- createdAt: 2026-06-03T11:34:20.890Z
- updatedAt: 2026-06-03T16:11:32.817Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "'s'-key-inert archived-item test is vacuous against an overlay-open regression (app.test.tsx) [restores D22]"
- severity: low
- description: "RESTORES D22 (re-filed open after it was erroneously set `resolved` by the user and then swept into the M35 archive by the /advance auto-archive sweep; the ledger has no un-archive/reopen-terminal path, hence the new id). Original finding (T130 reviewer, still valid): packages/ledger-tui/test/app.test.tsx (\"the 's' key is inert on an archived item\") asserts only frame.toContain('[archived]') + frame.toContain('archived task'). Per src/app.tsx, the path-header '[archived]' (cursorInArchive ~L937) and the list-pane row persist regardless of overlay state — the status overlay replaces only the right-hand content pane. So if 's' WERE wrongly handled on an archived row and opened the status picker, BOTH assertions would still pass — the test would not catch the regression. PRE-EXISTING (byte-identical to base); the sibling 'e'-inert test IS regression-sensitive (asserts 'read-only' which the overlay would replace)."
- suggestedFix: "Mirror the 'e'-inert test's content-pane sensitivity: after pressing 's', assert the status-picker is ABSENT — no SelectList '› ' cursor marker (app.tsx:1291-1296) in the frame/content pane — AND that the read-only badge '[archived · read-only]' (app.tsx:1424) is still PRESENT (a content-pane string the overlay would replace). The test file already has listSide(frame) (~L1264) for the list pane; add a complementary content-pane assertion (or assert '› ' absent from the whole frame, since the archived read-only content pane shows no SelectList). Keep the existing waitForFrame settle. Scope: packages/ledger-tui/test/app.test.tsx ONLY. bun run check."
- ledgerRefs: ["tasks:T130","goals:G2","goals:G12"]
- rootCause: "CONFIRMED (H14). The \"'s' key is inert on an archived item\" test (packages/ledger-tui/test/app.test.tsx:959-986) asserts ONLY f.toContain('[archived]') (:982) and f.toContain('archived task') (:984). Both are overlay-INSENSITIVE: '[archived]' is the path-HEADER string (app.tsx:934-939, top-level header Box) and 'archived task' is the LIST-pane row (app.tsx:1069, a separate Box); both persist regardless of overlay state. The status overlay replaces ONLY the right-hand content-pane Box (app.tsx:1071-1073: `overlay !== null ? <Overlays/> : contentEl`). So if the 's' handler's `!cursorInArchive` guard (app.tsx:803 content-focus / :838 list-focus) were removed, pressing 's' on an archived row would open the status SelectList in the content pane, yet BOTH asserted strings would still be present → the test passes, failing to catch the regression. Contrast the sibling 'e'-inert test (:988-1010) which asserts f.toContain('read-only') (:1008) — a content-pane badge ('[archived · read-only]', app.tsx:1424) the overlay WOULD replace → it IS regression-sensitive."
- dependsOn: ["T136"]
- fix: "T136 (merged b8df1c6): the \"'s' key is inert on an archived item\" test now asserts the content-pane '[archived · read-only]' badge is present (+ an optional content-pane-scoped check that the SelectList '› ' picker marker is absent), mirroring the regression-sensitive 'e'-inert test — so it FAILS if the !cursorInArchive guard regresses and 's' opens the status overlay on an archived row. Verified red-for-right-reason via scratch guard removal; app.tsx untouched; integration check green 783/0. Sole fix task T136 done."

## M51

### D30 — resolved

- createdAt: 2026-06-05T18:55:07.600Z
- updatedAt: 2026-06-05T20:10:50.648Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: link-prompts.ts + cq-assets/README.md still reference the relocated 'llm/' single-source tree — bun run link-prompts likely creates dangling symlinks
- severity: medium
- rootCause: "Confirmed (H21, all 8 citations re-validated against source via Bash). The LLM asset tree was relocated to `nix/pkg/cq-assets/{commands,agents}/` and `assets.nix` updated (`collectMdIn ./commands`/`./agents`, assets.nix:49-50), but `scripts/link-prompts.ts` was NOT: its 14 LINKS entries still set `source: 'llm/commands/...' / 'llm/agents/...'` (link-prompts.ts:29-44), resolved against `REPO_ROOT = dirname(script)/.. = nix/pkg/cq-ledgers/` (link-prompts.ts:19; run via package.json:13). That `llm/` root no longer exists (`ls nix/pkg/cq-ledgers/llm` -> No such file or directory). The creation loop only stats the LINK path (`linkExists`/`lstat absLink`), never the TARGET (`absSource`); `symlink(2)` succeeds on a nonexistent target, and line 73 logs success (link-prompts.ts:46-73) — so `bun run link-prompts` SILENTLY produces 14 DANGLING symlinks under `.claude/` that Claude cannot load. Separately, `nix/pkg/cq-assets/README.md` (title + convention block + Claude-link table, README.md:1,10-11,40-42) still documents the old `llm/` root."
- suggestedFix: |
    Two parts:
    1. Repoint `scripts/link-prompts.ts` LINKS `source:` paths from the vanished `llm/` root onto the real asset tree. Since assets now live at `nix/pkg/cq-assets/{commands,agents}/` (sibling of `nix/pkg/cq-ledgers/`), either (a) change each `source` to a path that resolves from REPO_ROOT to `../cq-assets/commands/...` / `../cq-assets/agents/...`, or (b) restore a `nix/pkg/cq-ledgers/llm -> ../cq-assets` symlink so the existing `llm/...` sources resolve. Prefer (a) (explicit, no hidden symlink).
    2. HARDEN the loop: assert each `absSource` exists (e.g. `test -e`/`lstat absSource`) BEFORE `symlink`, throwing loud on a missing target so a future relocation fails fast instead of silently dangling. Add a reproduce-first test (or a `--check` mode) asserting every produced link resolves (`test -e` the link target).
    3. Update `nix/pkg/cq-assets/README.md` (title, convention block, Three-consumers / Claude-link tables) to the `nix/pkg/cq-assets/...` layout.
    Acceptance: after the fix, `bun run link-prompts` produces only NON-dangling symlinks (every `.claude/**` link target satisfies `test -e`); `bun run check` green.
- description: "Filed from plan review R169 as an OUT-OF-SCOPE / pre-existing fault (file-and-defer; reviewer's explicit recommendation). It does NOT block the G15 plan — G15's own new link entries (T168/T178) were revised to verify the correct source root independently. This defect covers the PRE-EXISTING stale entries + README references. The /plan:* orchestrator re-derives the auto-investigate worklist by ledger query and may auto-launch /investigate:advance on this open defect per K12, separately from the G15 plan."
- ledgerRefs: ["goals:G15","goals:G17"]
- sessionLogs: ["docs/logs/20260605-185840-addf76024a26b2805.md"]
- dependsOn: ["T179","T180","T181"]
- fix: "Resolved across T179/T180/T181 (merged to main 24c1d51). T179: made link-prompts.ts import-safe (export LINKS+checkLinks, creation loop behind import.meta.main), added --check mode + reproduce-first test. T180: repointed all 14 LINKS sources llm/ -> ../cq-assets/{commands,agents}/ (all resolve) and hardened the loop to throw loud on a missing source (reuses checkLinks), flipped repro test to checkLinks(LINKS) toEqual([]). T181: de-staled cq-assets/README.md to the new layout. `bun run link-prompts` now produces 14 non-dangling symlinks; integrated bun run check green."

## M82

### D35 — resolved

- createdAt: 2026-06-07T09:25:18.899Z
- updatedAt: 2026-06-07T09:25:27.027Z
- author: "opus-4.8[1m]"
- session: 059ff637-d28c-4785-8125-9c0d73ddf7a0
- headline: "D34 fix incomplete: McpLedgerClient.enumerateLedgers dropped progressTotal, so the top bar still showed the itemCount denominator (46/47 post-deploy)"
- severity: low
- description: "User report after redeploying the D34 fix: the top-bar questions indicator still shows Q: 46/47 (with 46 answered + 1 withdrawn + 0 open, the correct display is 46/46). The D34 fix was incomplete across the wire boundary: the server emits progressTotal on each LedgerSummary (T207) and LedgerProgressBar uses summary.progressTotal as the denominator (T208), BUT the web client's McpLedgerClient.enumerateLedgers() (nix/pkg/cq-ledgers/packages/ledger-web/src/mcpClient.ts:106-131) parsed the enumerate_ledgers response WITHOUT progressTotal — its typed response shape omitted the field and the summary construction copied statusCounts + completedCount but never progressTotal. So summary.progressTotal was always undefined on the client and LedgerProgressBar fell back to itemCount (47, which includes the terminal withdrawn question) → 46/47. NOT version skew. The gap escaped review because T208's worker/reviewer inspected only App.tsx and T209's regression test exercised the @cq/ledger server summary, not the ledger-web client parse."
- rootCause: McpLedgerClient.enumerateLedgers (mcpClient.ts) did not read/copy the server-provided progressTotal field onto the LedgerSummary, so the field never reached LedgerProgressBar; the component's `summary?.progressTotal ?? summary?.itemCount` fallback then used itemCount as the denominator.
- suggestedFix: "Add progressTotal?: number to the enumerate_ledgers typed response shape and copy it (`if (extra?.progressTotal !== undefined) summary.progressTotal = extra.progressTotal;`) in mcpClient.ts enumerateLedgers, mirroring the completedCount passthrough. Add a focused regression test that stubs the SDK client and asserts enumerateLedgers passes progressTotal through."
- ledgerRefs: ["goals:G27","defects:D34"]
- fix: "Wired progressTotal through McpLedgerClient.enumerateLedgers (mcpClient.ts): added progressTotal?:number to the enumerate_ledgers typed response and copy it onto the LedgerSummary, mirroring the completedCount passthrough. Added regression test test/mcpClientProgressTotal.test.ts (stubs the SDK client; asserts progressTotal passes through, and stays undefined for an older server peer). Reproduced failing first (progressTotal undefined → 46/47), green after. bun run check: 1020 pass / 1 skip / 0 fail. Commit 1be968c. The top-bar questions bar will read 46/46 after redeploy."
