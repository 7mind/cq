---
ledger: milestones
counters:
  milestone: 0
  item: 9
archives:
  - id: M5
    path: ./archive/milestones/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
  - id: M2
    path: ./archive/milestones/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
  - id: M3
    path: ./archive/milestones/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
  - id: M4
    path: ./archive/milestones/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
---

# milestones

## active

### M-AMBIENT — open

- createdAt: 2026-06-01T19:15:33.341Z
- updatedAt: 2026-06-01T19:15:33.341Z
- title: ambient

### M1 — open

- createdAt: 2026-06-01T19:24:22.101Z
- updatedAt: 2026-06-01T19:24:22.101Z
- title: "Plan: /implement:* command family"
- description: "Coordination milestone for the goal of building the /implement:* command family (start/advance) that executes the planned roadmap: DAG-ordered task pickup, per-task worktree + implementor subagent, reviewer subagent gate, autonomous criticism loop, and user-answered questions. Groups the goal, its clarifying questions, reviews, and final approval decision. Work tasks live under separate work milestones recorded on the goal's fields.milestones."

### M6 — open

- createdAt: 2026-06-01T23:17:53.320Z
- updatedAt: 2026-06-01T23:17:53.320Z
- title: "UI/schema follow-up: archives, milestone grouping, TUI table, reviews summary"
- description: "Follow-up scope on G1 (2026-06-02). Five user requests: (1) view archived items in both UIs; (2) per-milestone filter in web; (3) milestone subsections in ledger views; (4) column-aligned TUI item table; (5) reviews `summary` field + UI wrapping fix + reviewer prompt updates. Decisions pinned by answered questions Q11-Q18."
- dependsOn: ["M3"]

### M7 — open

- createdAt: 2026-06-01T23:35:52.617Z
- updatedAt: 2026-06-01T23:35:52.617Z
- title: "investigate:* flow — research-loop-style defect investigation assets"
- description: "Follow-up #2 (G1). New investigate:* command family modeled on the research-loop skill: commands/investigate/{start,advance}.md + agents/investigate-explorer.md, wired into scripts/link-prompts.ts LINKS. The hypothesis ledger is the durable tree (Q24); /investigate:advance is the orchestrator/adjudicator; investigate-explorer is read-only evidence-gatherer (Q27). On confirmed root cause, hands off to plan-flow to produce reviewed fix tasks (Q25)."

### M8 — open

- createdAt: 2026-06-01T23:35:57.677Z
- updatedAt: 2026-06-01T23:43:48.012Z
- title: "defect-awareness in plan:* and implement:* prompts"
- description: "Follow-up #2 (G1). Edit existing plan/implement prompts so they operate on BOTH defects and tasks: user-reported defects land in the defects ledger (Q21), reviewers file out-of-scope defects via a defects[] bucket (Q22), defect<->task linkage via dependsOn/ledgerRefs (Q20), implement orchestrator closes a defect when all linked fix-tasks are done, and discovered defects route to investigate:* file-and-defer (Q26). Depends on M7 (the investigate:* assets the routing references) AND M6 (T28 threads the `summary` field into plan-reviewer.md and implement-reviewer.md's JSON contract; M8/T40+T42 edit the SAME prompts/JSON block to add defects[], so T28 must land first to avoid a same-file conflict and the false 'currently has summary' premise — R5 criticism #3)."
- dependsOn: ["M7","M6"]

### M9 — open

- createdAt: 2026-06-01T23:36:02.408Z
- updatedAt: 2026-06-01T23:36:02.408Z
- title: defect/hypothesis relationship views in TUI + web (Full scope, Q28)
- description: "Follow-up #2 (G1). Per Q28 'Full' answer: surface defect↔fix-task linkage (dependsOn/ledgerRefs) and the hypothesis tree (parentHypothesis ancestry) as relationship views in BOTH the TUI and web clients. No @cq/ledger schema change is required for the link (dependsOn/ledgerRefs already exist on both schemas); a schema tweak is only added if the UI work proves the existing fields insufficient. Independent of M7/M8 (pure client work)."
