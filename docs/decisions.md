---
ledger: decisions
counters:
  milestone: 0
  item: 20
archives:
  - id: M2
    path: ./archive/decisions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
    title: ""
    status: ""
  - id: M3
    path: ./archive/decisions/M3.md
    summary: Build /implement:* command family (goal G1) — complete. Decision K4 (model tiers + dual worktree strategy); implement-worker/-reviewer/-conflict-resolver agents (T5–T7); /implement:start + /implement:advance (T8/T9); plan-advance sets suggestedModel (T11); cross-flow session-log convention (T15); wiring (T10); end-to-end dogfood (T12, defect D2 resolved). Shipped on main (commit 4f430b3).
    title: ""
    status: ""
  - id: M4
    path: ./archive/decisions/M4.md
    summary: Plan-flow maintenance — complete. Subagent MCP tool access made server-name-independent via denylist (T13); /plan:follow-up command + goal re-open transitions, decision K5 (T25); /plan:advance with no argument advances all unlocked goals (T14). Shipped on main (commits 4f430b3, 67727e9).
    title: ""
    status: ""
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

### K8 — locked

- createdAt: 2026-06-02T06:06:47.366Z
- updatedAt: 2026-06-02T06:06:47.366Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "investigate:* architecture lock (T35) — hypothesis-ledger tree, command-owned loop, file-and-defer handoff, defect-seeded clarify-skip"
- rationale: |
    Design lock the M7 prompt tasks (T36-T39) and the T41 planner edit cite. Five points:
    
    (1) THE TREE = the `hypothesis` ledger. Each node is a hypothesis item; `parentHypothesis` encodes ancestry; `evidence[]` holds validated citations, each prefixed `[correct]`/`[incorrect]` (research-loop E-item convention); `status` is open|uncertain|confirmed|wrong; each node `ledgerRefs` its defect `defects:<D>`.
    
    (2) LOOP OWNER = the `/investigate:advance` COMMAND body (subagents cannot spawn subagents). `investigate-explorer` is a READ-ONLY evidence-gatherer (no ledger writes, no adjudication). No separate reviewer subagent — the command adjudicates.
    
    (3) HANDOFF = FILE-AND-DEFER, never an inline plan loop (resolves R5 #1). On a confirmed root cause, /investigate:advance: (a) writes `defects.rootCause` + `suggestedFix`; (b) creates OR extends a plan-flow goal SEEDED from the defect — the goal description embeds the confirmed root cause + suggestedFix and a `ledgerRefs:[defects:<D>]` link; (c) files an `open` question / report line telling the user to run `/plan:advance <G>`, and STOPS. It MUST NOT re-implement or invoke the planner<->plan-reviewer loop (a command cannot run another command's loop; inline duplication contradicts the file-and-defer principle, Q26).
    
    (4) DEFECT-SEEDED CLARIFY-SKIP (resolves R5 #2). /plan:start and /plan:follow-up normally re-open a goal to `clarifying`. A defect-seeded goal (carries a `defects:<D>` ledgerRef + an embedded confirmed root cause) proceeds STRAIGHT to planning: the seeding writes the confirmed root cause + suggestedFix so plan-advance has nothing left to clarify, and the planner prompt (T41) explicitly permits skipping the clarifying round when a goal is defect-seeded. `defect-seeded` is the grep-able token.
    
    (5) EXPLORER CONCURRENCY = parallel ONLY when seeding disjoint top-level hypotheses; serial while drilling a single branch (Q27).
- alternatives: "Inline plan loop inside /investigate:advance (rejected: a command cannot run another command's loop; duplicates plan-flow; contradicts file-and-defer). Re-clarifying the defect-seeded goal (rejected: root cause already confirmed; wastes a round — R5 #2). A dedicated investigate-reviewer subagent (rejected: the command adjudicates citations itself, mirroring how plan/implement keep the loop in the command)."
- ledgerRefs: ["goals:G1"]
- tags: ["investigate-flow","design-lock","follow-up-2"]

## M10

### K9 — locked

- createdAt: 2026-06-02T08:57:27.196Z
- updatedAt: 2026-06-02T08:57:27.196Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (ref review R30): plan T50-T68 across work milestones M12/M13/M14 covers all 8 in-scope items, is fine-grained, correctly sequenced, testable, and grounded against source; all three R29 under-specifications resolved; no new defects."
- ledgerRefs: ["goals:G2"]

### K11 — locked

- createdAt: 2026-06-02T10:40:40.861Z
- updatedAt: 2026-06-02T10:40:40.861Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan review: approved"
- rationale: Reviewer go-ahead on the G2 follow-up plan (M18/M19 tasks T79-T89), 0 criticisms / 0 new questions / no out-of-scope defects; ref review R33 (original M12/M13/M14 scope already approved under R30/K9).
- ledgerRefs: ["goals:G2"]

### K13 — locked

- createdAt: 2026-06-02T14:58:01.261Z
- updatedAt: 2026-06-02T14:58:01.261Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: Questions ledger reserved for genuine user-interaction questions; defect triage stays on the defect (no routing-questions)
- rationale: |
    User decision (G2 follow-up #4, item 18 / answers Q54). REFINES K8/Q26 file-and-defer: the 'defer' half must NOT manifest as a `questions` item.
    
    Rule:
    1. The `questions` ledger is RESERVED for genuine questions requiring human interaction (clarifying/decision questions). Orchestrators must NOT create 'routing' questions whose only purpose is to tell the user to run /investigate:start <D>.
    2. /investigate:start already accepts a BARE defect id (intake resume path, ^D\d+$), so it works WITHOUT any question. An `open` defect linked via ledgerRefs is already discoverable by ledger query — no pointer-question needed.
    3. The triage/deferral note (severity rationale, suggestedFix, 'out-of-scope, triage later') lives ON the defect record itself (its description/suggestedFix fields), NOT in a separate question.
    
    Flow changes (item 18 fix tasks):
    - llm/commands/implement/advance.md §3 (reviewer defects[] file-and-defer): file the `open` defect (with the triage note in its fields) ONLY; DELETE the step that creates a 'run /investigate:start <D>' open question.
    - llm/commands/plan/advance.md auto-investigate routing + llm/agents/plan-reviewer.md: same — file the defect, never a routing question.
    - Keep file-and-defer's NON-blocking property (defects still don't block the in-scope task; still gate milestone archival until terminal).
    - One-time cleanup: retire existing routing questions Q52/Q53 (fold their D3/D4/D5/D6 triage notes into those defect records).
    
    K8 points 1,2,4,5 unaffected; K12 (auto-investigate from plan:*) unaffected — it already derives its worklist by LEDGER QUERY (open defects linked goals:<G>), not from questions, so dropping routing-questions does not break auto-investigate discovery.
- supersedes: ["K8"]
- ledgerRefs: ["goals:G2","decisions:K8","decisions:K12","questions:Q54"]

### K14 — locked

- createdAt: 2026-06-02T16:29:22.449Z
- updatedAt: 2026-06-02T16:29:22.449Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan review: approved (follow-up #4)"
- rationale: "Reviewer go-ahead (ref review R74, round 2): follow-up #4 plan is fine-grained, sequenced, testable, grounded, complete for items 16-19; 0 criticisms, 0 new questions, no out-of-scope defects. Work milestone M21 (tasks T90-T93, defects D7/D8) covers items 16-19."
- ledgerRefs: ["goals:G2"]

## M27

### K17 — locked

- createdAt: 2026-06-02T20:00:56.252Z
- updatedAt: 2026-06-02T20:00:56.252Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead R94 (round 2, 0 criticisms / 0 new_questions; both R93 grounding/acceptance gaps on T106 and T105 resolved). Plan locked: work milestone M28 carries fix tasks T105 (D9 ledger-tui HTTP test de-flake), T106 (D10 dual-store no-partial-mutation assertion), T107 (D11 sticky web .lw-toolbar) — file-disjoint, parallel-safe; gate `bun run check`."
- ledgerRefs: ["goals:G6","defects:D9","defects:D10","defects:D11"]

### K18 — locked

- createdAt: 2026-06-02T20:53:37.607Z
- updatedAt: 2026-06-02T20:53:37.607Z
- author: "opus-4.8[1m]"
- session: $CLAUDE_CODE_SESSION_ID
- headline: "plan review: approved (D12 follow-up)"
- rationale: "Reviewer go-ahead R97 (0 criticisms / 0 new_questions; R95+R96 grounding/locus gaps resolved — T109 relocates the legacy ArchivePointer title/status backfill to async FsLedgerStore.init() (FS-only), forbids touching materialiseFetchedLedger/InMemory to preserve D10/T106 parity, with a reproduction-first FS-fixture acceptance). Extends the locked plan (prior decision K17 locked round-1 fix tasks T105/T106/T107 for D9/D10/D11 under M28) to cover the D12 follow-up: T109 (ledger FsLedgerStore.init() legacy-pointer title/status backfill) sequenced before T108 (web App.tsx archived-milestone rows in the milestones-ledger view). Gate `bun run check`."
- ledgerRefs: ["goals:G6","defects:D12","tasks:T108","tasks:T109"]

### K20 — locked

- createdAt: 2026-06-03T00:56:16.161Z
- updatedAt: 2026-06-03T00:56:16.161Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "plan review: approved (follow-up #2/#3/#4 scope)"
- rationale: "Reviewer go-ahead R112 (0 criticisms, 0 new questions) approves the follow-up plan T116-T129 across work milestones M33/M32/M31 (M31 dependsOn M33): formal defect-lifecycle states (root-caused/inconclusive; drop blocked; rename abandoned->wontfix), universal /advance command, N=4->8 concurrency bump, ledger-reset tooling, and coordination-milestone auto-close+archive. Distinct from prior locks K17 (D9/D10/D11) and K18 (D12) which covered the original defect-seeded cleanup."
- ledgerRefs: ["goals:G6"]

## M29

### K19 — locked

- createdAt: 2026-06-02T23:00:09.765Z
- updatedAt: 2026-06-02T23:00:09.765Z
- author: "opus-4.8[1m]"
- session: fe0aaf85-56b3-45ce-a7fc-718ab19c37e1
- headline: "plan review: approved"
- rationale: "Reviewer go-ahead (ref review R104): all R103 criticisms resolved; fix tasks T110-T115 for defects D14-D19 under work milestone M30 are fine-grained, sequenced (App.tsx chain T113->T114->T115), testable, and grounded."
- ledgerRefs: ["goals:G7"]
