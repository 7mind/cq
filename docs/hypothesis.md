---
ledger: hypothesis
counters:
  milestone: 0
  item: 26
archives:
  - id: M14
    path: ./archive/hypothesis/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/hypothesis/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M27
    path: ./archive/hypothesis/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M35
    path: ./archive/hypothesis/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
  - id: M43
    path: ./archive/hypothesis/M43.md
    summary: G11 W2 (@cq/ledger-mcp tool surface) — COMPLETE. T144 fetch_ledger compact/offset/limit params (fixes 51.8KB/142.7KB overflow); T145 snapshot tool; T146 reopen_item + unarchive_item; T147 read_log (bounded, root-confined); T148 tool-count reconciliation (14→18 across all refs); T149 query-language doc clarifications. Reviews R148-R153 go-ahead. Out-of-scope defects D25/D26 filed here, both later resolved (G13). Shipped on main.
    title: G11 W2 — @cq/ledger-mcp tool surface
    status: done
  - id: M45
    path: ./archive/hypothesis/M45.md
    summary: G11 W4 (flow-prompt wiring) — COMPLETE. T153 advance.md §Provenance permits the single run-level handoffs write; T154 per-flow handoff writes with contextual /advance suppression; T155 sessionLogs population in each outcome write; T156 snapshot-first /advance bootstrap recipe. Reviews R155/R156/R158/R159 go-ahead (T154 r0 used an env var, fixed r1 → contextual). Out-of-scope defect D27 filed here, later resolved (G13). Docs/prompt-only. Shipped on main.
    title: G11 W4 — flow-prompt wiring (handoff writes + bootstrap recipe + docs)
    status: done
  - id: M48
    path: ./archive/hypothesis/M48.md
    summary: "G13 fix work (D25/D26/D27 G11 follow-up cleanup) — COMPLETE. T158 (D26): readLog symlink-escape hardening (realpath both target+root); T159 (D25): removed stale eslint-disable; T160 (D27): reworded CHAINED handoff trigger + made start/follow-up wrappers the single handoff writer (7 files). Reviews R163/R164/R165 go-ahead (T158/T160 each r0 disapprove→r1 approve). H15/H16/H18 confirmed. Defects D25/D26 resolved (also D28 filed here from T158 review, resolved via G14). Merged 311b8a1."
    title: "G13 fix tasks: D25/D26/D27 code-quality cleanup"
    status: done
  - id: M52
    path: ./archive/hypothesis/M52.md
    summary: "Investigation of D29 (empty-answer-accepted) complete: H19 (backend gap) + H20 (frontend gap) confirmed against source, root cause pinned, fix file-and-deferred to G16 and resolved this run. Q94 pointer withdrawn (fulfilled)."
    title: "Investigate: empty-answer-accepted"
    status: done
  - id: M61
    path: ./archive/hypothesis/M61.md
    summary: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server — COMPLETE. 11 tasks done + merged (T1 get_reviewers/get_config on BOTH ledger-MCP surfaces behind injected ConfigCapability; T2 buildServer wiring + e2e stdio; T3 count 18→20 + drift-guard; T4 delete cq-config-mcp package; T5 flake.nix removal + @cq/config symlink; T6 dev-llm.nix; T7 .mcp.json; T8/T9/T10 repoint reviewers.md/implement-advance/plan-advance to mcp__ledger__*; T11 FOD hash refresh + nix build .#ledger-mcp/.#ledger-tui/.#ledger-web green + .#cq-config-mcp attr-not-found). Reviews R195-R205 go-ahead. Out-of-scope defect D32 (README still referenced the removed server) auto-investigated→root-caused (H23)→defect-seeded G19→planned (K32/R212)→BUILT (T182, R213)→D32 RESOLVED in the same run; Q104 traceability withdrawn. bun run check green 931/0; main tip 418b641. @cq/config PARSER library retained.
    title: G18 PART 1 — Merge cq-config into ledger MCP + remove standalone server
    status: done
  - id: M60
    path: ./archive/hypothesis/M60.md
    summary: "Investigate D31 (web BatchAnswerModal premature-close) — COMPLETE. User-confirmed repro (Q103) flipped the prior 'does not reproduce' conclusion: H22 (suspected T163 regression) WRONG; H24 CONFIRMED — the modal backdrop closed on any click whose common-ancestor was the backdrop with no guard the press STARTED there; a press-and-hold on 'save & mark answered' (timer-fired) advanced to a shorter question, the dialog shrank while still pressed, and the release over the backdrop dismissed it (react-modal #466 class; vacuous test coverage cf. D24/H14). Root-caused → defect-seeded G21 → fixed (T183 RED + T184 shared useBackdropDismiss on all 3 overlays) → D31 RESOLVED. Q103 answered, Q112 (traceability) withdrawn."
    title: "Investigate: batch-answer-modal-premature-close"
    status: done
  - id: M73
    path: ./archive/hypothesis/M73.md
    summary: "D33 investigated → root-caused (H25 confirmed via headless-chromium ground truth: computeDagLayout left layer 0 empty for cyclic graphs, not CSS) → resolved by G24/T199 (e9bf762). Q113 answered (use headless chromium)."
    title: "Investigate: sm-diagram-alignment (blocked on env)"
    status: done
---

# hypothesis

## M11

### H1 — wrong

- createdAt: 2026-06-02T08:37:34.271Z
- updatedAt: 2026-06-02T08:42:08.733Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: ledger-mcp server startup throws when the ledger registry (docs/ledgers.yaml) is absent — no default/auto-init
- description: "ROOT-CAUSE CANDIDATE. The MCP server entrypoint eagerly loads/validates the ledger registry (docs/ledgers.yaml) at startup; if the file is missing it throws and the process exits before completing the MCP handshake, so the client reports 'connection failed'. Would be TRUE if: the server main/serve path reads docs/ledgers.yaml (or CANONICAL_LEDGERS divergence-guards against it) and has no branch that initializes a default registry when absent."
- ledgerRefs: ["defects:D2"]
- evidence: ["[correct] packages/ledger/src/store/FsLedgerStore.ts:254-291 (orchestrator-verified) — init() mkdir's docs/+.locks/+archive/ recursively, catches ENOENT on reading docs/ledgers.yaml and WRITES serializeRegistry(EMPTY_REGISTRY) instead of throwing, then bootstraps every CANONICAL_LEDGERS entry when absent. The ONLY throw is BootstrapViolationError on schema DIVERGENCE of an existing ledger (L283-289), never on a missing file. Rules out 'missing registry throws at startup'.","[correct] packages/ledger-mcp/src/main.ts:337-344 — main() awaits store.init() before building/connecting any transport; since init auto-inits, startup succeeds on an empty cwd.","[correct] REPRODUCTION (orchestrator-run): `bun packages/ledger-mcp/src/main.ts --cwd <fresh empty tmpdir>` printed 'serving stdio MCP on cwd=...', exited 0, and created docs/{ledgers.yaml,milestones,tasks,defects,hypothesis,questions,reviews,decisions,goals}.md + archive/ + .locks/. Decisively rules out H1."]

### H2 — wrong

- createdAt: 2026-06-02T08:37:39.341Z
- updatedAt: 2026-06-02T08:42:11.895Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: FsLedgerStore construction/index build throws on a missing docs/ dir or absent ledger files instead of treating an uninitialized dir as empty
- description: "ROOT-CAUSE CANDIDATE. The store layer (FsLedgerStore) — during construction or initial index build — reads the docs/ directory and per-ledger markdown files; a missing dir/file raises ENOENT (or a parse/validation error) rather than degrading to empty state, propagating up and aborting server bring-up. Would be TRUE if: FsLedgerStore (or its index refresh) does fs reads without an exists-check/auto-create, and no auto-init creates the canonical files. Disjoint from H1 (store layer vs server-entrypoint/registry-load)."
- ledgerRefs: ["defects:D2"]
- evidence: ["[correct] packages/ledger/src/store/FsLedgerStore.ts:254-340 (orchestrator-verified) — init() auto-creates docs/.locks/archive via fs.mkdir({recursive:true}); per-ledger markdown reads swallow ENOENT (L298-303) and seed freshLedger(entry) instead of throwing. A missing docs/ dir or absent ledger files degrade to empty/fresh state, not an error.","[correct] REPRODUCTION (orchestrator-run): running the server against a fresh empty tmpdir created the full docs/ tree (all canonical ledger .md files + ledgers.yaml) and exited 0 — empirical proof the store layer does not throw on an uninitialized directory."]

### H3 — open

- createdAt: 2026-06-02T08:41:56.700Z
- updatedAt: 2026-06-02T08:41:56.700Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "The observed failure is ENVIRONMENTAL, not missing-init: a stale globally-registered (home-manager/Nix) ledger-mcp binary, --cwd, or .mcp.json wiring"
- description: "ROOT-CAUSE CANDIDATE (needs user's environment data to adjudicate). Source auto-init works (H1/H2 refuted by reproduction), so any real 'connection fails' must come from outside the source init path. Leading suspects: (a) VERSION SKEW — the ledger MCP is plugin-registered globally via home-manager/Nix; if that built binary predates the FsLedgerStore.init() auto-create code, it would fail against a fresh dir even though source works (cf. resolved defect D1, also a version-skew 'connection failed'). (b) --cwd resolution to a non-existent/unwritable path. (c) the target directory has no .mcp.json / no ledger server wired at all (then it's 'not configured', not a connection failure). (d) a non-ENOENT fs/permission error under init's mkdir. CANNOT adjudicate without the user's actual error text + how the server is launched — parked on Q37."
- parentHypothesis: ""
- ledgerRefs: ["defects:D2"]

### H4 — confirmed

- createdAt: 2026-06-02T11:26:20.034Z
- updatedAt: 2026-06-02T11:26:20.034Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "CONFIRMED: startup aborts via BootstrapViolationError on schema divergence (FsLedgerStore.ts:283-289), not missing init"
- description: "The specific confirmed mechanism under H3 (environmental). FsLedgerStore.init() bootstraps each CANONICAL_LEDGERS entry; for an EXISTING on-disk ledger whose schema differs from the canonical bootstrap schema it THROWS BootstrapViolationError (packages/ledger/src/store/FsLedgerStore.ts:283-289) — which main() lets crash the process before the MCP handshake, so the client reports connection failure. This is the divergence path H1's evidence identified as 'the only startup throw' (which we incorrectly set aside after the empty-dir repro). Divergence arises from version skew: a stale globally-built ledger-mcp binary vs an evolved on-disk docs/ledgers.yaml (or vice-versa)."
- parentHypothesis: H3
- evidence: ["[correct] USER-OBSERVED runtime error (decisive): `ledger-mcp: fatal: Bootstrap invariant violated: existing goals ledger has a different schema than its canonical bootstrap schema` — the exact BootstrapViolationError message, naming the goals ledger schema divergence.","[correct] packages/ledger/src/store/FsLedgerStore.ts:283-289 (orchestrator-verified earlier): `else if (!schemasEqual(entry.schema, canonical.schema)) { throw new BootstrapViolationError(...) }` — the only startup throw on a non-ENOENT tree; fires on an existing-but-divergent on-disk schema.","[correct] packages/ledger-mcp/src/main.ts:337-344: main() awaits store.init() before serving, so this throw aborts the connection."]
- ledgerRefs: ["defects:D2"]

## M39

### H14 — confirmed

- createdAt: 2026-06-03T15:10:57.119Z
- updatedAt: 2026-06-03T15:14:20.262Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: The 's'-key-inert archived-item test asserts only overlay-INSENSITIVE frame content, so it cannot catch a regression where 's' opens the status overlay on an archived row
- description: "ROOT-CAUSE CANDIDATE (single). packages/ledger-tui/test/app.test.tsx \"the 's' key is inert on an archived item\" asserts only frame.toContain('[archived]') + frame.toContain('archived task'). TRUE if: (a) both asserted strings render OUTSIDE the right-hand content pane (the '[archived]' path-header at app.tsx cursorInArchive ~L937 + the list-pane row), (b) the status/SelectList overlay replaces ONLY the content pane — so the header + list row persist even when the picker IS open — making both assertions pass regardless of whether 's' was wrongly handled, and (c) the sibling 'e'-inert test asserts a content-pane string ('read-only') that the overlay WOULD replace, so it IS regression-sensitive and is the model for the fix (assert the status-picker SelectList marker is absent in the content pane, or the read-only badge present)."
- ledgerRefs: ["defects:D24"]
- evidence: ["[correct] app.test.tsx:982-984 (orchestrator-verified) — the 's'-inert test asserts ONLY `expect(f).toContain('[archived]')` + `expect(f).toContain('archived task')`; both are overlay-insensitive (path header + list row).","[correct] app.test.tsx:1008 (orchestrator-verified) — the sibling 'e'-inert test asserts `expect(f).toContain('read-only')`, a CONTENT-PANE string the overlay would replace → regression-sensitive; the model for the fix.","[correct] app.tsx:1061-1073 (orchestrator-verified) — the list pane ({listEl}, holding 'archived task') is its own Box; the right-hand box renders `overlay !== null ? <Overlays/> : contentEl`, so the status overlay replaces ONLY the content pane. Header '[archived]' + list row persist with the picker open → both 's'-test assertions still pass.","[correct] app.tsx:803 + 838 (orchestrator-verified) — the guarded behavior is `input === 's' && cur && !cursorInArchive && setOverlay({t:'status',row:cur})` (content-focus L803, list-focus L838). Removing `!cursorInArchive` re-introduces exactly the regression the current test cannot catch.","[correct] app.tsx:1291-1296 + 1424 (explorer-cited, consistent with source) — the SelectList cursor marker is '› '; the archived content-pane badge is '[archived · read-only]'. The fix asserts the '› ' picker marker ABSENT / the read-only badge PRESENT in the content pane."]

## M51

### H21 — confirmed

- createdAt: 2026-06-05T18:56:40.776Z
- updatedAt: 2026-06-05T18:59:22.447Z
- author: "opus-4.8[1m]"
- session: 58a3012b-08b8-4f7a-816b-008d6fb1d8d5
- headline: Asset tree was relocated from `llm/` to `nix/pkg/cq-assets/` but scripts/link-prompts.ts + cq-assets/README.md still reference the old `llm/` root, so link-prompts creates dangling symlinks
- description: "TRUE if: (a) scripts/link-prompts.ts LINKS entries set `source:` to `llm/commands/...` / `llm/agents/...`; (b) that `llm/` root does NOT resolve relative to where link-prompts runs (no `nix/pkg/cq-ledgers/llm` dir, or it is a stale/broken symlink) while the real assets live under `nix/pkg/cq-assets/{commands,agents}/`; (c) assets.nix reads `./commands`/`./agents` under cq-assets (confirming the relocation); (d) `symlink()` on a nonexistent target still succeeds, yielding a DANGLING link, so the script can 'run clean' while producing unusable links; (e) README.md tables still cite `llm/...`."
- ledgerRefs: ["defects:D30"]
- evidence: ["[correct] scripts/link-prompts.ts:19 — REPO_ROOT = resolve(dirname(scriptfile), '..') = nix/pkg/cq-ledgers/; sources resolve under it. (re-validated, exact)","[correct] scripts/link-prompts.ts:29-44 — all 14 LINKS entries set source: 'llm/commands/...' / 'llm/agents/...'. (re-validated, exact)","[correct] `ls nix/pkg/cq-ledgers/llm` -> 'No such file or directory' — the llm/ source root the script points at is ABSENT, so every absSource is missing. (re-validated)","[correct] scripts/link-prompts.ts:46-73 — linkExists()/the loop stat only absLink (the LINK), NEVER absSource (the TARGET); symlink(relTarget, absLink) succeeds for a nonexistent target and line 73 logs success -> DANGLING symlinks on a 'clean' run. (re-validated, exact)","[correct] nix/pkg/cq-assets/assets.nix:49-50 — commands = collectMdIn ./commands; agents = collectMdIn ./agents; (relative to cq-assets, no llm/ prefix) confirming relocation. (re-validated, exact)","[correct] real assets present: nix/pkg/cq-assets/agents/plan-reviewer.md + commands/plan/start.md exist (test -e OK) — sources moved here, not deleted. (re-validated)","[correct] nix/pkg/cq-assets/README.md:1,10-11,40-42 — title '# `llm/` — single-source LLM assets' + convention block + Claude-link table still cite 'llm/commands/...' / 'llm/agents/...'. (re-validated, exact)","[correct] package.json:13 — 'link-prompts': 'bun run scripts/link-prompts.ts' runs from nix/pkg/cq-ledgers/, fixing the CWD/REPO_ROOT. (re-validated, exact)"]
- sessionLogs: ["docs/logs/20260605-185840-addf76024a26b2805.md"]

## M79

### H26 — confirmed

- createdAt: 2026-06-06T23:16:52.317Z
- updatedAt: 2026-06-06T23:21:35.675Z
- author: "opus-4.8[1m]"
- session: 059ff637-d28c-4785-8125-9c0d73ddf7a0
- headline: Top-bar progress counts only `answered` in the numerator but ALL non-archived questions (incl. the 1 `withdrawn`) in the denominator, yielding 38/39
- description: "ROOT-CAUSE CANDIDATE. The top-bar progress indicator (ledger-web, possibly also ledger-tui) derives its fraction from the questions ledger: numerator = count of questions with status `answered`; denominator = count of ALL active/non-archived questions regardless of terminal status. Because the ledger holds 38 `answered` + 1 `withdrawn` = 39 active questions, and `withdrawn` is terminal-but-not-`answered`, it is counted in the denominator (39) but never in the numerator (38), so the bar reads 38/39 and never reaches 100%. Would be TRUE if: the progress computation's denominator includes `withdrawn` (or all statuses) while the numerator is restricted to `answered`. The fix is to treat `withdrawn` as a non-counting/terminal-complete question — either exclude it from the denominator or count it as done. Needs the exact numerator/denominator expression + the question status set with file:line citations to confirm."
- ledgerRefs: ["defects:D34"]
- evidence: ["[correct] nix/pkg/cq-ledgers/packages/ledger/src/mcp/ledgerTools.ts:78-79 (orchestrator-validated) — computeCompletedCount: `if (ledgerName === QUESTIONS_LEDGER) return sc[QUESTIONS_ANSWERED_STATUS] ?? 0;` i.e. the questions NUMERATOR counts ONLY `answered`, deliberately excluding the other terminal status `withdrawn` (comment L69-70 confirms intent).","[correct] nix/pkg/cq-ledgers/packages/ledger/src/mcp/ledgerTools.ts:191-200 (orchestrator-validated) — enumerate_ledgers builds itemCount by `total++` for EVERY item in EVERY status group with no terminal-status exclusion, so the DENOMINATOR includes the `withdrawn` question. completedCount is then computeCompletedCount(...).","[correct] nix/pkg/cq-ledgers/packages/ledger/src/constants.ts:205-206 (orchestrator-validated) — QUESTIONS_SCHEMA statusValues=[open,answered,withdrawn], terminalStatuses=[answered,withdrawn]; `withdrawn` is terminal but is NOT `answered`, so it lands in the denominator but never the numerator.","[correct] nix/pkg/cq-ledgers/packages/ledger-web/src/App.tsx:1416-1430 (orchestrator-validated) — LedgerProgressBar sets total=summary.itemCount, done=summary.completedCount and renders `${done}/${total}`; with the questions summary this is 38/39. The three top-bar bars (App.tsx:980) are questions/tasks/defects, all server-classified (no client filtering).","[correct] nix/pkg/cq-ledgers/packages/ledger/test/enumerate-ledgers-summary.test.ts:118-130 (per explorer) — existing coverage encodes the SAME mechanism scaled down: 2 answered + 1 open + 1 withdrawn → itemCount 4, completedCount 2 (withdrawn inflates denominator, not numerator).","[correct] LIVE DATA (orchestrator snapshot, this session) — questions ledger statusCounts: answered=38, withdrawn=1, open=0 → itemCount 39, completedCount 38. Confirms 38/39 arises from the single `withdrawn` question, NOT a residual `open` one (settles the explorer's probeRequest).","[note] CONCLUSION — questions progress fraction = completedCount(answered-only)/itemCount(all active questions). `withdrawn` is terminal (needs no user action) yet excluded from the numerator while included in the denominator, so each withdrawn question keeps the bar one short of 100%; with 38 answered + 1 withdrawn the top bar reads 38/39 though zero questions await answering. The answered-only numerator is intentional (types.ts:154-169); the DEFECT is the non-symmetric denominator (itemCount not excluding `withdrawn`)."]
