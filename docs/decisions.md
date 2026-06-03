---
ledger: decisions
counters:
  milestone: 0
  item: 24
archives:
  - id: M2
    path: ./archive/decisions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: TUI + web UI improvements
    status: done
  - id: M3
    path: ./archive/decisions/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: Build /implement:* command family
    status: done
  - id: M4
    path: ./archive/decisions/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: Plan-flow maintenance and improvements
    status: done
  - id: M15
    path: ./archive/decisions/M15.md
    summary: "G3 coordination — COMPLETE (auto-archived by the new milestone-sweep rule, T129). Goal G3 (plan/implement flow-behavior changes: auto-investigate + never-auto-close-goals) done; work milestones M16/M17 archived; decisions K10/K12 (K12 supersedes K8 pt3); questions Q42-Q47 answered; reviews R31/R32."
    title: "Plan: plan/implement flow-behavior changes (auto-investigate + never auto-close goals)"
    status: done
  - id: M20
    path: ./archive/decisions/M20.md
    summary: G4 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G4 (D2 backup-and-reinit on schema divergence) done; work milestone M22 archived; decision K15; reviews R75/R76. D2 resolved.
    title: "Plan: fix D2 — graceful backup-and-reinit on ledger schema divergence"
    status: done
  - id: M23
    path: ./archive/decisions/M23.md
    summary: G5 coordination — COMPLETE (auto-archived by the milestone-sweep rule, T129). Goal G5 (@cq/ledger packaging + UI-eligibility defects D3-D6) done; work milestones M24/M25/M26 archived; decision K16; reviews R77/R78. D3-D6 resolved.
    title: "Plan: @cq/ledger packaging + UI-eligibility defect cleanup (D3-D6)"
    status: done
  - id: M1
    path: ./archive/decisions/M1.md
    summary: G1 coordination — COMPLETE. Goal G1 (build the /implement:* command family) done; work milestones M3/M6/M7/M8/M9 archived; clarifying questions answered, reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: /implement:* command family"
    status: done
  - id: M10
    path: ./archive/decisions/M10.md
    summary: "G2 coordination — COMPLETE. Goal G2 (ledger-suite UI/schema enhancements: columns, batch-answer, colors, titles + follow-ups) done; work milestones M12/M13/M14/M18/M19/M21 archived; defects D18/D19/D20 resolved; reviews + approval decision terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: ledger-suite UI/schema enhancements (columns, batch-answer, colors)"
    status: done
  - id: M27
    path: ./archive/decisions/M27.md
    summary: "G6 coordination — COMPLETE. Goal G6 (low-severity cleanup + follow-ups: #2 universal /advance command + N=4→8, #3 ledger-mcp --reset, #4 formal defect-lifecycle states + milestone auto-archive) done; work milestones M28/M31/M32/M33 archived; defects D9/D10/D11/D12/D13 resolved (D13's investigation hypotheses H9/H10 confirmed, H11/H12 refuted); reviews + decisions terminal. Auto-archived by the /advance whole-ledger sweep."
    title: "Plan: low-severity cleanup — D9 test flake, D10 store parity, D11 sticky filter bar"
    status: done
  - id: M29
    path: ./archive/decisions/M29.md
    summary: G7 coordination — COMPLETE. Goal G7 (fix confirmed dogfood UI/store defects D14-D19) done; work milestone M30 archived; defects D14-D19 resolved; reviews + approval decision (K19) terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix confirmed dogfood UI/store defects (D14-D19)"
    status: done
  - id: M35
    path: ./archive/decisions/M35.md
    summary: G8 coordination — COMPLETE. Goal G8 (fix remaining buildable defects D20/D21) done; work milestone M36 archived; defects D20/D21 resolved, residuals D22/D23 resolved (D23 fixed via G10/T134; D22 user-resolved); D23 investigation hypothesis H13 confirmed; reviews R125/R126 + decision K21 terminal. Auto-archived by the /advance whole-ledger sweep.
    title: "Plan: fix remaining buildable defects (D20 tui-test flakiness, D21 reset non-canonical)"
    status: done
---

# decisions

## M37

### K22 — locked

- createdAt: 2026-06-03T10:47:32.788Z
- updatedAt: 2026-06-03T10:47:32.788Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (ref review R131): revised G10 fix plan (M38: T132/T133 D13 memo+layout incremental-render with text-keyed parse cache and instrumented-count regression guard; T134 D23 advance() poll-until-condition + generous per-test timeout; T135 D13 UX defer-detail file-and-defer) is fine-grained, sequenced, testable, and fully grounded — all citations verified against source. Both R130 feasibility corrections (ink 7.0.5 lacks incrementalRendering; instrumented render-count gate not wall-clock) resolved."
- ledgerRefs: ["goals:G10"]

## M39

### K23 — locked

- createdAt: 2026-06-03T15:22:11.639Z
- updatedAt: 2026-06-03T15:22:11.639Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (ref review R136): T136 (revised) resolves R135 — PRIMARY assertion is '[archived · read-only]' badge PRESENT (regression-sensitive, overlay swaps the content-pane Box removing the badge); any '› '-absence assertion is content-pane-scoped; whole-frame '› '-absent is forbidden. Test-only fix to packages/ledger-tui/test/app.test.tsx, red/green + bun run check."
- ledgerRefs: ["goals:G12"]

## M40

### K24 — locked

- createdAt: 2026-06-03T15:48:52.034Z
- updatedAt: 2026-06-03T15:48:52.034Z
- author: "opus-4.8[1m]"
- session: ea0ee283-9e2d-4088-a61a-86fac464e29b
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead on R140 (4th pass) — 0 criticisms, 0 new questions. Approved plan: 5 work milestones M42-M46, 21 tasks T137-T157 implementing the four G11 features (state-overview snapshot + fetch_ledger projection/pagination, doc/description improvements + FTS-anomaly repro, terminal-reopen + un-archive store ops, web click-and-hold HoldButton protection, handoffs ledger + sessionLogs link fields + read-log tool/log-viewer). Task DAG verified acyclic and totally ordered across shared-file task pairs (ledgerTools.ts chain T144->T145->T146->T147->T149); faithful to clarifying answers Q74-Q87."
- ledgerRefs: ["goals:G11"]
