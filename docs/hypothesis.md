---
ledger: hypothesis
counters:
  milestone: 0
  item: 18
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
