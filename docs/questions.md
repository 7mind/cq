---
ledger: questions
counters:
  milestone: 0
  item: 73
archives:
  - id: M2
    path: ./archive/questions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M14
    path: ./archive/questions/M14.md
    summary: G2-W3 column selector + batch-answer + project title — COMPLETE. T60-T68 (eligibleColumnFields/defaultColumns, web+TUI column selectors, web batch-answer modal + TUI overlay, displayName + web/TUI titles). Out-of-scope defects D3 (exports map) + D4 (column eligibility) RESOLVED via G5; Q52 withdrawn (K13). Reviews R54/R57-R61. Shipped on main.
    title: "G2-W3: Column selector, batch-answer mode, project title"
    status: done
  - id: M18
    path: ./archive/questions/M18.md
    summary: "G2 follow-up #9-13 — COMPLETE. T79 archived-subsection unification, T80/T81 milestone-status badge (web)/color (TUI), T82 colgroup column proportions, T83/T84 goals flat-list, T85 TUI nav-perf memoization. Out-of-scope D5 (archived-head badge) + D6 (browser-safe constants) RESOLVED via G5; Q53 withdrawn (K13). Reviews R62-R68. Shipped on main."
    title: "G2 follow-up: web milestone-section rendering + column-width + goals flat-list + TUI nav-perf (#9-#13)"
    status: done
  - id: M15
    path: ./archive/questions/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M1
    path: ./archive/questions/M1.md
    summary: G1 coordination — COMPLETE. Goal G1 (build the /implement:* command family) done; work milestones M3/M6/M7/M8/M9 archived; clarifying questions answered, reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: /implement:* command family"
    status: done
  - id: M10
    path: ./archive/questions/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/questions/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M33
    path: ./archive/questions/M33.md
    summary: "G6 #4A work milestone — COMPLETE. Formal defect-lifecycle states (open/wip/root-caused/inconclusive/resolved/wontfix) landed in @cq/ledger CANONICAL_LEDGERS + investigate/plan/implement flow prompts; live open-defect migration done; tasks + reviews terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "G6 #4A — formal defect-lifecycle states (root-caused/inconclusive) across schema + flow prompts"
    status: done
---

# questions

## M11

### Q37 — answered

- createdAt: 2026-06-02T08:42:37.390Z
- updatedAt: 2026-06-02T11:26:11.572Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- question: "D2 does NOT reproduce from source — the requested auto-init already exists and works. To find the real root cause, what did you actually observe? Please provide: (a) the exact client error / how 'MCP connection fails' surfaced; (b) HOW the ledger MCP server was launched in that directory — from source (`bun … main.ts`), the Nix-built product (`nix build .#ledger-mcp`), or the globally plugin-registered (home-manager) binary [version skew is the prime suspect — see H3 / cf. D1]; (c) whether that directory even had a `.mcp.json` / plugin wiring the ledger server (no wiring = 'not configured', not a connection failure); (d) was it THIS repo or a different/empty project, and was the dir writable?"
- context: "Round 1 of investigation. H1 (server-startup registry-load throws) and H2 (FsLedgerStore construction/index-build throws) both adjudicated WRONG by orchestrator-verified citations + a live reproduction: FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:254-340), called by main() (packages/ledger-mcp/src/main.ts:337-344) BEFORE serving, mkdir's docs/ recursively, swallows ENOENT on the registry and each ledger file, writes EMPTY_REGISTRY, and bootstraps CANONICAL_LEDGERS. Reproduction: `bun packages/ledger-mcp/src/main.ts --cwd <fresh empty tmpdir>` printed 'serving stdio MCP', exited 0, and auto-created docs/ledgers.yaml + all canonical ledger files. So the source already does exactly what D2 requests. Remaining live hypothesis H3 (environmental: stale globally-registered/Nix binary version-skew like D1, or --cwd/.mcp.json wiring) needs your environment data to adjudicate. After answering, re-run /investigate:advance D2."
- suggestions: ["Most likely: the globally plugin-registered (home-manager/Nix) ledger-mcp binary is older than the source that has the auto-init — rebuild/refresh it (version skew, cf. D1) and retest","The directory had no .mcp.json wiring the ledger server (so it was never configured, not a 'connection failure')","A --cwd resolved to a non-existent or unwritable path","Something else — paste the actual error"]
- recommendation: Capture the exact failure + launch method; if it's the globally-registered binary, rebuild it and retest before we plan any code fix (source already auto-inits, so a code change may be unnecessary).
- ledgerRefs: ["defects:D2","hypothesis:H3"]
- answer: "User-provided actual error: `ledger-mcp: fatal: Bootstrap invariant violated: existing goals ledger has a different schema than its canonical bootstrap schema`. So the failure is NOT missing-init (the empty-dir auto-init works) — it is the BootstrapViolationError thrown by FsLedgerStore.init() (packages/ledger/src/store/FsLedgerStore.ts:283-289) when an EXISTING on-disk ledger's schema diverges from its CANONICAL_LEDGERS bootstrap schema (e.g. a stale/version-skewed binary vs an evolved docs/ledgers.yaml). Confirms the H3 environmental direction. Desired fix (user): on such a divergence, automatically BACK UP the old/divergent ledger files and set up fresh canonical ledgers, instead of aborting with a fatal error."
