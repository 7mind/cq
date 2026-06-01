---
ledger: goals
counters:
  milestone: 0
  item: 1
archives: []
---

# goals

## M1

### G1 — planning

- createdAt: 2026-06-01T19:24:30.427Z
- updatedAt: 2026-06-01T19:54:39.683Z
- author: "opus-4.8[1m]"
- session: 86ec6253-6f0d-405a-9a97-a89319e33ce3
- title: "Implement the /implement:* command family"
- description: |
    We have the plan:* command family (plan:start, plan:advance) that clarifies goals and prepares an actionable roadmap. Now build the /implement:* command family that executes that roadmap.
    
    Desired flow:
    - /implement:start accepts a list of milestones to complete; if none specified, assume ALL milestones need completion.
    - It then enters a loop: take unblocked tasks honoring DAG order (not blocked, not in a terminal condition).
    - For every independent pending task, create a git worktree and dispatch an implementation subagent using the task's suggested-model field, defaulting to the orchestrator's own model class. Show a WARNING if the suggested model is not set.
    - After the implementor completes, run a review subagent using the most capable model available.
    - The reviewer either approves or disapproves. On disapproval it returns criticism and questions for the user. Criticism can be handled autonomously in a loop; questions are registered in the ledger and must be answered by the user.
    - When the user answers, they run /implement:advance to continue.
    
    Goal: design and implement this command family with all details worked out (concurrency, DAG traversal, worktree lifecycle, model selection, review gating, autonomous-fix loop bounds, question registration/resumption, merge-back, failure handling).
- grounding: |
    Key facts shaping the plan and questions:
    
    - The existing plan-flow family is the template: thin commands at `llm/commands/plan/{start,advance}.md`, subagents at `llm/agents/{plan-advance,plan-reviewer}.md`. Assets live once under `llm/{commands,agents}` and are symlinked into `.claude/` and `.codex/` by `scripts/link-prompts.ts` (the `LINKS` array must gain the new `/implement:*` entries).
    - Platform constraint (decisive): subagents cannot spawn subagents (Agent-SDK). So, as plan-flow already does, the implementor↔reviewer loop and concurrent worktree dispatch MUST live in the `/implement:advance` orchestrator command, not in a subagent.
    - The Agent tool `model` field accepts a fixed set: sonnet | opus | haiku | inherit | full-model-ID. The 'suggested-model' must resolve onto these.
    - The repo `tasks` schema has `headline`, `description`, `acceptance`, `dependsOn`, `ledgerRefs`. NOTE: the `questions` ledger already has an optional `suggestedModel` field; whether `tasks` does must be confirmed (Q3).
    - Claude Code offers native per-subagent worktree isolation (`isolation: worktree`; auto-removed if unchanged, NOT auto-merged), plus /batch and dynamic Workflow as parallelization surfaces. Manual worktree lifecycle vs native isolation is a real fork.
    - Repo gate is `bun run check` (tsc + eslint + bun test).
    
    Sources: Claude Code subagents/agents/worktrees docs.
- milestones: ["M3"]
