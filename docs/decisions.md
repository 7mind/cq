---
ledger: decisions
counters:
  milestone: 0
  item: 7
archives:
  - id: M2
    path: ./archive/decisions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
  - id: M3
    path: ./archive/decisions/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
  - id: M4
    path: ./archive/decisions/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
---

# decisions

## M1

### K3 — locked

- createdAt: 2026-06-01T20:20:17.613Z
- updatedAt: 2026-06-01T20:20:17.613Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (ref review R1) with empty new_questions; criticism folded into tasks T4/T5/T6/T9. Plan for /implement:* command family is approved."
- ledgerRefs: ["goals:G1"]

### K6 — locked

- createdAt: 2026-06-01T23:24:31.385Z
- updatedAt: 2026-06-01T23:24:31.385Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan review: approved"
- rationale: Reviewer go-ahead (ref review R4) with 0 criticisms and 0 new questions for the follow-up plan (work milestone M6, tasks T26-T34). R3 revise criticism on T26/T27/T34 was folded into the tasks; R4 confirms clean.
- ledgerRefs: ["goals:G1"]

### K7 — locked

- createdAt: 2026-06-01T23:46:42.519Z
- updatedAt: 2026-06-01T23:46:42.519Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (review R6): 0 criticisms, 0 new questions for the #2-follow-up plan (work milestones M7/M8/M9, tasks T35-T49). Plan approved; goal advances to planned."
- ledgerRefs: ["goals:G1"]
