---
ledger: questions
counters:
  milestone: 0
  item: 10
archives:
  - id: M2
    path: ./archive/questions/M2.md
    summary: TUI + web UI improvements — complete. Per-ledger counts (T1), answer-and-resolve for questions (T2), view persistence (T3), embedded in-process MCP mode for ledger-tui + ledger-web (T17–T22), question-detail field order + highlighted recommendation (T23). Decision K2 (in-process = co-locate the MCP server, don't bypass MCP). Defect D1 (web counts undefined) resolved. Shipped on main (commits 63df0f3, 5cf4916; merged b510170).
---

# questions

## M1

### Q1 — answered

- createdAt: 2026-06-01T19:28:58.613Z
- updatedAt: 2026-06-01T19:38:54.271Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: "Worktree lifecycle: native subagent isolation vs. manual git worktree?"
- context: "Claude Code provides per-subagent `isolation: worktree` (auto-create, auto-remove on no-change, no auto-merge), but the goal text says 'create a git worktree' explicitly. These imply different orchestrator code."
- suggestions: ["Use native `isolation: worktree` subagent frontmatter; orchestrator only handles merge-back","Orchestrator manually runs `git worktree add/remove` per task","Hybrid: native isolation + explicit orchestrator cleanup"]
- recommendation: "Native `isolation: worktree` for the implementor subagent; orchestrator owns merge-back and conflict handling."
- ledgerRefs: ["goals:G1"]
- answer: Use native isolation. But you should tell me if it works on both codex and claude.

### Q2 — answered

- createdAt: 2026-06-01T19:29:02.282Z
- updatedAt: 2026-06-01T19:39:19.694Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: What is the concurrency degree for dispatching independent tasks?
- context: "'every independent pending task' could dispatch unbounded parallel subagents; docs cite 4-8 concurrent worktrees as practical, with Workflow for dozens+. Need a cap."
- suggestions: ["Fixed cap (e.g. 4)","Configurable via command arg","Sequential (one task at a time) for v1"]
- recommendation: Configurable cap, default 4; sequential fallback if unset.
- ledgerRefs: ["goals:G1"]
- answer: as recommended

### Q3 — answered

- createdAt: 2026-06-01T19:29:05.992Z
- updatedAt: 2026-06-01T19:41:26.676Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: Where does the task's 'suggested model' live — add a `suggestedModel` field to the tasks schema?
- context: The goal references a per-task suggested-model and wants a WARNING when unset. The `questions` ledger already has `suggestedModel`, but the `tasks` schema may not. Adding it touches @cq/ledger schema, MCP, and TUI/web clients.
- suggestions: ["Add `suggestedModel` to the tasks schema (and surface in TUI/web)","Read it from an existing free-form field / ledgerRefs convention","Defer model-per-task; always use orchestrator's own class for v1"]
- recommendation: Add an optional `suggestedModel` field to the tasks schema.
- ledgerRefs: ["goals:G1"]
- answer: "Yes, it was supposed to already be there. Check. If not - add. Make sure our /plan:* workflow fills this field!"

### Q4 — answered

- createdAt: 2026-06-01T19:29:10.182Z
- updatedAt: 2026-06-01T19:42:17.378Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: Model resolution & capability ordering for implementor and reviewer?
- context: Agent `model` accepts only sonnet|opus|haiku|inherit|full-ID. Goal wants implementor to default to 'orchestrator's own model class' and reviewer to use 'the most capable model available'. Need the concrete mapping and capability ranking.
- suggestions: ["opus > sonnet > haiku; reviewer always opus","Use `inherit` for implementor default; reviewer pinned to opus","Caller passes explicit model IDs"]
- recommendation: "Implementor: `suggestedModel` else `inherit`; reviewer: opus. Capability order opus > sonnet > haiku."
- ledgerRefs: ["goals:G1"]
- answer: as recommended - but you should account for codex

### Q5 — answered

- createdAt: 2026-06-01T19:29:12.938Z
- updatedAt: 2026-06-01T19:43:40.383Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: What bounds the autonomous criticism (fix-review) loop?
- context: "'criticism handled autonomously in a loop' needs a hard cap to prevent runaway cost (plan-flow caps at 4). Need iteration cap and exhaustion behavior."
- suggestions: ["Cap at 3 fix-review rounds","then register a question","Cap configurable","Cap then mark task blocked/failed"]
- recommendation: Cap at 3 rounds; on exhaustion register a question and stop the task.
- ledgerRefs: ["goals:G1"]
- answer: No iteration cap. The orchestrator should validate implementer/reviewer results for sanity. It should only stop if it detects ill loops.

### Q6 — answered

- createdAt: 2026-06-01T19:29:16.892Z
- updatedAt: 2026-06-01T19:46:45.848Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: Merge-back strategy & conflict handling for parallel worktrees?
- context: Parallel worktrees must integrate into the base branch; conflict and ordering policy are undecided.
- suggestions: ["Sequential merge in DAG order; rebase each remaining worktree on updated base","Integration branch","test","then single merge to main","Open a PR per task","human merges"]
- recommendation: Sequential merge in dependency order with rebase-before-merge; on conflict, register a question and leave the worktree intact.
- ledgerRefs: ["goals:G1"]
- answer: Sequential merge in dependency order with rebase-before-merge. On conflict the model should run a subagent to resolve conflict automatically.

### Q7 — answered

- createdAt: 2026-06-01T19:29:20.981Z
- updatedAt: 2026-06-01T19:47:53.788Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: "Question registration & /implement:advance resumption semantics?"
- context: "Reviewer questions must be registered in the ledger and gate the task until the user answers, then /implement:advance resumes. Need the ledger model: reuse the `questions` ledger with a task->question link? What task status represents 'blocked on a question'?"
- suggestions: ["Reuse `questions` ledger","link via ledgerRefs `tasks:<id>`; introduce a blocked marker the advance loop scans","Add a new task status value for blocked-on-question","Per-goal coordination milestone mirroring plan-flow's M"]
- recommendation: Reuse `questions` ledger linked to the task; introduce/confirm a 'blocked' task status the advance loop scans for.
- ledgerRefs: ["goals:G1"]
- answer: as recommended

### Q8 — answered

- createdAt: 2026-06-01T19:29:24.783Z
- updatedAt: 2026-06-01T19:48:31.479Z
- author: user
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- question: What defines task success and how are failures handled (checks / subagent crash)?
- context: "The goal lists 'failure handling' but does not define it. The repo gate is `bun run check` (tsc + eslint + bun test). Need: what counts as task success, and what happens on implementor failure or non-passing check."
- suggestions: ["Task success = `bun run check` passes in the worktree AND reviewer approves; check failure feeds the criticism loop","Reviewer is the sole gate; checks advisory","Hard-fail the task and surface to user immediately"]
- recommendation: Define task success as `bun run check` green AND reviewer go-ahead; on check failure feed output into the criticism loop.
- ledgerRefs: ["goals:G1"]
- answer: as recommended
