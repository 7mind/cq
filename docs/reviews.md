---
ledger: reviews
counters:
  milestone: 0
  item: 28
archives:
  - id: M5
    path: ./archive/reviews/M5.md
    summary: "Dogfood complete: T24 driven to done through the real implement-flow loop (manual worktree (K4 Codex path) -> implement-worker created+committed the marker -> bun run check green in worktree (379 pass) -> implement-reviewer approved 0/0 -> ff merge-back into throwaway dogfood/base). Throwaway branches deleted; nothing landed on main. Two setup findings recorded as defects under goals:G1."
  - id: M6
    path: ./archive/reviews/M6.md
    summary: UI/schema follow-up (G1) — COMPLETE. reviews `summary` field (T26); summarize() legacy fallback + badge/cell nowrap-ellipsis both UIs (T27); summary threaded through reviewer prompts + implement:advance recorder (T28); fetchLedgerArchive client web+TUI (T29); web subsections + milestone dropdown (T30); TUI column table + subsections (T31); web (T32) + TUI (T33) read-only archive views; integration gate + cross-cutting regression (T34). Tasks T26-T34; reviews R7/R8/R11/R12/R14/R15/R16/R17/R22. Shipped on main; final check 483 pass.
  - id: M7
    path: ./archive/reviews/M7.md
    summary: "investigate:* flow assets (G1 #2) — COMPLETE. Design lock K8 (T35); investigate-explorer read-only evidence-gatherer (T36); /investigate:advance DFS/adjudication loop with file-and-defer handoff + defect-seeded clarify-skip (T37); /investigate:start intake + inline advance (T38, round-1 fixed phantom-subagent); LINKS wiring (T39). Tasks T35-T39; reviews R9/R13/R18/R19. Shipped on main; all investigate:* symlinks resolve; final check 483 pass."
  - id: M8
    path: ./archive/reviews/M8.md
    summary: "defect-awareness in plan:*/implement:* prompts (G1 #2) — COMPLETE. plan-reviewer defects[] bucket (T40); implement-reviewer defects[] JSON (T42); plan-flow defect-aware planning + bidirectional linkage + reviewer-defects file-and-defer + defect-seeded clarify-skip (T41); implement/advance files reviewer defects + orchestrator-owned closure on merge-back (T43); cross-prompt 6-grep-invariant audit (T44). Tasks T40-T44; reviews R23/R24/R25/R26/R27. Shipped on main. Closed loop defect->investigate->plan->implement->resolve confirmed."
  - id: M9
    path: ./archive/reviews/M9.md
    summary: "defect/hypothesis relationship views (G1 #2, Q28 Full) — COMPLETE. Schema-sufficiency spike, no @cq/ledger change (T45); pure shared helpers defectFixTaskIds + hypothesisRelationships (T46); web detail-panel relationship views via ./relationships subpath (T47); TUI content-pane views (T48); cross-UI single-source regression + full-suite gate (T49). Tasks T45-T49; reviews R10/R20/R21/R28. Shipped on main; final check 483 pass."
---

# reviews

## M1

### R1 — go-ahead

- createdAt: 2026-06-01T19:54:45.270Z
- updatedAt: 2026-06-01T19:54:45.270Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- criticism: ["Q5 'no cap' needs concrete ill-loop signals + a high absolute safety ceiling, else infinite spend if detection misfires — folded into T9 acceptance.","suggestedModel values are Claude-only aliases; portability requires a tier vocabulary mapped per-host — made the foundational T4 decision.","Codex has no native subagent worktree isolation; advance command must branch (Claude native / Codex manual) — folded into T4 + T9.","/implement:advance must be idempotent/resumable and flip blocked->planned when a blocking question is answered — folded into T9.","Fresh worktrees may lack node_modules; worker must ensure deps before `bun run check` — folded into T5.","Per-round reviews would flood the ledger; orchestrator records one terminal review per task — folded into T6."]
- new_questions: []
- ledgerRefs: ["goals:G1"]

### R3 — revise

- createdAt: 2026-06-01T23:21:22.478Z
- updatedAt: 2026-06-01T23:21:22.478Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["T27 mis-grounds summarize() as a shared util: it is duplicated VERBATIM in packages/ledger-tui/src/app.tsx:63 and packages/ledger-web/src/App.tsx:110 (both bodies: f[\"headline\"] ?? f[\"title\"] ?? f[\"question\"] ?? f[\"summary\"] ?? Object.values(f)[0]). T27's description assumes one shared location and its acceptance only names happy-dom WEB tests. The TUI copy ALSO falls through to the long criticism string[] for legacy reviews and needs the same truncate-first-criticism fallback. Fix: scope BOTH summarize() copies in T27 (or split a TUI-summarize subtask), and add an ink-testing-library assertion that a legacy review with no summary renders a truncated single line in the TUI, not the full joined criticism. As written, Req5 is only half-delivered for the TUI.","T34 bundles an objective automated gate (bun run check) with five manual observed-vs-expected smoke checks into one mega-task; the manual halves are not independently verifiable. Where feasible, fold each request's verification into the per-task acceptance tests it already owns (T30/T31/T32/T33/T27 each name happy-dom or ink tests) and reduce T34 to the green-check gate plus any cross-cutting regression assertion, rather than a manual five-point sweep.","T26 acceptance overstates the canonical-ledgers test: that test (packages/ledger/test/canonical-ledgers.test.ts) does NOT assert an exact reviews field-SET — it exercises specific fields plus a schema-divergence guard across docs/ledgers.yaml + examples/sample-ledger + the lib constant. Adding optional summary keeps it green but is not 'verified' by it. Either add an explicit assertion that REVIEWS_SCHEMA.fields.summary exists (type string, required:false) and that all three registry copies declare it, or reword T26's acceptance to claim only divergence-guard parity, not field-set assertion."]
- ledgerRefs: ["goals:G1"]

### R4 — go-ahead

- createdAt: 2026-06-01T23:23:52.315Z
- updatedAt: 2026-06-01T23:23:52.315Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G1"]

### R5 — revise

- createdAt: 2026-06-01T23:41:46.802Z
- updatedAt: 2026-06-01T23:41:46.802Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: ["T37 (and the T35 decision lock) under-specify the investigation->planning handoff and conflate two incompatible mechanisms. T37 acceptance says on a confirmed root cause /investigate:advance should 'HAND OFF to plan-flow ... then the standard plan-advance<->plan-reviewer cycle produces reviewed fix tasks'. But /plan:advance (llm/commands/plan/advance.md) IS itself a command whose body runs the planner<->reviewer loop by spawning plan-advance/plan-reviewer subagents; a command cannot invoke another command's loop. So 'run the cycle' resolves to EITHER (a) /investigate:advance re-implements the plan loop inline (duplicates the loop that already lives in /plan:advance, and contradicts the Q26 file-and-defer integration principle the rest of the plan adopts), OR (b) it writes rootCause/suggestedFix, creates/extends the goal, and DEFERS to the user to run /plan:advance. The plan must pick (b) explicitly (consistent with Q26 file-and-defer + resumability) and state it in both T35's locked decision and T37's acceptance; as written the executor could build either.","T37/T35 do not specify the clarify-skip for the seeded goal. Q25 hands a defect with an ALREADY-confirmed root cause to plan-flow, but /plan:start and /plan:follow-up both re-open the goal to `clarifying` and spawn plan-advance for a FRESH clarifying round (llm/commands/plan/{start,follow-up}.md). Re-clarifying a defect whose root cause is confirmed is redundant. The handoff task must state how the seeded goal enters planning without a wasted clarifying round (e.g. seed the goal description with the confirmed root cause + suggestedFix so plan-advance has nothing left to clarify, or document that the planner may skip clarification when the goal is defect-seeded). Currently neither T35 nor T37 addresses this, leaving the executor to guess.","Cross-milestone dependency on the #1 follow-up (M6) is unstated and risks a same-file conflict. T42 edits implement-reviewer.md's returned-JSON contract to add `defects[]`, and its description asserts the contract 'currently' carries 'taskId/verdict/criticism/questions/rationale, plus the `summary` from the #1 follow-up'. But M6/T28 (the task that adds `summary` to that exact JSON contract) is still `planned`, and M8 dependsOn M7 ONLY (not M6). If M8 runs before M6/T28, T42's stated premise is false and two tasks edit the same JSON block in implement-reviewer.md independently. Either add M6 (or T28) to T42/M8's dependsOn, or reword T42 so its acceptance does not presuppose the `summary` field already exists (state the defects[] addition is independent of the summary work). Same applies to T40/T28 both editing plan-reviewer.md.","T44 acceptance is not operationally verifiable, repeating the defect R3 already flagged on the old T34. Its acceptance is 'A short written audit (in the task completion / PR description) confirming the closed loop ... with any drift corrected' plus 'no contradictory routing language remains' - a subjective prose deliverable, not a checkable command/invariant. The only mechanical clause is `bun run check` green (which a markdown-only consistency task cannot actually exercise for routing correctness). Tighten the acceptance to a verifiable form: e.g. a grep-able invariant (every fix task references `defects:` in ledgerRefs; no prompt instructs implement to execute a defect directly; the `[correct]`/`[incorrect]` evidence convention string appears identically in investigate-explorer + investigate/advance), so the audit's conclusion rests on enumerable checks rather than a narrative."]
- ledgerRefs: ["goals:G1"]

### R6 — go-ahead

- createdAt: 2026-06-01T23:45:46.867Z
- updatedAt: 2026-06-01T23:45:46.867Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
- new_questions: []
- criticism: []
- ledgerRefs: ["goals:G1"]
