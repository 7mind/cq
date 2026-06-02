---
ledger: goals
counters:
  milestone: 0
  item: 1
archives: []
---

# goals

## M1

### G1 — planned

- createdAt: 2026-06-01T19:24:30.427Z
- updatedAt: 2026-06-01T23:46:45.892Z
- author: "opus-4.8[1m]"
- session: 0a4a7acf-25b6-4783-83a1-a45870023493
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
    
    ## Follow-up (2026-06-02) — UI/schema improvements
    1) Our UIs do not allow to see archived items
    2) We should add per-milestone filter controls to the web UI - currently we only have filter by status
    3) I think it would be a good idea to use milestone table subsections in the ledgers views where items include milestone field
    4) In the TUI the items list is misaligned because of different task id length ("T1 name" vs "T14 name") - can we use a table with columns, not just a flat list?
    5) Web UI -> reviews ledger, summary column displays "criticism" field content. That field is too long so "go-ahead" badge wraps ugly. I've checked raw ledger content, there is no "summary" field in reviews. So, we need to fix both wrapping, the schema and modify prompts to fill summaries
    
    ## Follow-up (2026-06-02, #2) — defects/tasks separation + investigate:* flow
    theree is one omission in our plan:* and implement:* commands: they only operate on tasks ledger, but they should separate defects from tasks - and operate BOTH ledgers. Essentially they are very similar, just the ledger names/metadata is different. So, we need to modify the prompts. So, when user reports a defect, it should get into defects ledger. One defect may require one or more tasks to be fixed. When reviewer finds a defect - the same, it should be filed as a defect, not task. We need to introduce separate investigate:* flow specifically designed to figure out best ways to research defects (similar to our research-loop skill) and plan up fixes. This flow should be integrated into plan:* and implement:* flows. Key idea is the same as in research loop: multiple hypothesis with parallel validation, once root cause is found - planning cycle to produce tasks
- grounding: |
    Key facts shaping the plan and questions:
    
    - The existing plan-flow family is the template: thin commands at `llm/commands/plan/{start,advance}.md`, subagents at `llm/agents/{plan-advance,plan-reviewer}.md`. Assets live once under `llm/{commands,agents}` and are symlinked into `.claude/` and `.codex/` by `scripts/link-prompts.ts` (the `LINKS` array must gain the new `/implement:*` entries).
    - Platform constraint (decisive): subagents cannot spawn subagents (Agent-SDK). So, as plan-flow already does, the implementor↔reviewer loop and concurrent worktree dispatch MUST live in the `/implement:advance` orchestrator command, not in a subagent.
    - The Agent tool `model` field accepts a fixed set: sonnet | opus | haiku | inherit | full-model-ID. The 'suggested-model' must resolve onto these.
    - The repo `tasks` schema has `headline`, `description`, `acceptance`, `dependsOn`, `ledgerRefs`. NOTE: the `questions` ledger already has an optional `suggestedModel` field; whether `tasks` does must be confirmed (Q3).
    - Claude Code offers native per-subagent worktree isolation (`isolation: worktree`; auto-removed if unchanged, NOT auto-merged), plus /batch and dynamic Workflow as parallelization surfaces. Manual worktree lifecycle vs native isolation is a real fork.
    - Repo gate is `bun run check` (tsc + eslint + bun test).
    
    ## Follow-up grounding (2026-06-02, UI/schema scope) — verified against source
    - reviews schema: `REVIEWS_SCHEMA` in `packages/ledger/src/constants.ts` (L271-286) has new_questions[], criticism[], ledgerRefs[], tags[], sourceRefs[] — NO `summary` field (confirms Q16). `CANONICAL_LEDGERS` (same file) is asserted by `packages/ledger/test/canonical-ledgers.test.ts`; live registry is `docs/ledgers.yaml`; `examples/sample-ledger` has its own copy.
    - summarize() in BOTH UIs picks headline ?? title ?? question ?? summary ?? Object.values(f)[0]; reviews therefore fall through to criticism (the long string[]). Adding optional `summary` makes it the natural pick (Q16/Q17).
    - Store-layer archive plumbing already exists: `LedgerSearchIndex` has separate active/archived buckets + `includeArchived`; `FsLedgerStore` has archiveDir, `collectArchivedItems`, `refreshLedgerIndexArchived`; MCP exposes `fetch_ledger_archive` + `archivePointers[]` on `fetch_ledger`. Web `mcpClient` does NOT yet implement `fetchLedgerArchive`; no cross-ledger enumerate tool exists (Q11). New MCP tools permitted if agents benefit.
    - Web `ItemTable` is a flat <table> with a milestone column + single status <select>; status badge `.lw-status` wraps because the summary cell is unclamped. TUI list renders each row as one ink <Text> 'id [status] summary' in ScrollList — misaligned by variable id width (Q15).
    - Reviewer write paths: plan-reviewer.md writes its reviews item directly via create_item; implement-reviewer.md returns a JSON block that /implement:advance records as the terminal reviews item (Q18 — summary must be threaded through all three).
    
    ## Follow-up grounding (2026-06-02, #2 — defects/tasks + investigate:*) — verified against source
    - Schemas (docs/ledgers.yaml, the live registry): `defects` (idPrefix D) has headline(req)/description/rootCause/suggestedFix/fix/severity(REQUIRED)/sourceRefs[]/blockedBy[]/dependsOn[]/ledgerRefs[]/tags[]/suggestedModel; statusValues open|wip|blocked|resolved|abandoned, terminal resolved|abandoned. `hypothesis` (idPrefix H) has headline(req)/description/rationale/parentHypothesis(id)/evidence[]/sourceRefs[]/dependsOn[]/ledgerRefs[]/tags[]/suggestedModel; statusValues open|uncertain|confirmed|wrong, terminal confirmed|wrong. `tasks` ALSO already carries an optional `severity` field plus dependsOn[]/ledgerRefs[].
    - DECISIVE on Q28 schema-tweak: the bidirectional defect↔task link chosen in Q20 (tasks.ledgerRefs += defects:<D>; defects.dependsOn = fix-task ids) needs NO new schema field — dependsOn[] and ledgerRefs[] exist on BOTH schemas (and on hypothesis). So 'Full' scope (Q28) means prompt edits + UI work; NO @cq/ledger schema change is required for the link. (A schema change would only arise if UI work surfaces a need; none identified.)
    - Prompt files that gain defect-awareness: llm/commands/plan/{start,advance,follow-up}.md, llm/agents/{plan-advance,plan-reviewer}.md, llm/commands/implement/{start,advance}.md, llm/agents/{implement-worker,implement-reviewer,implement-conflict-resolver}.md. /implement:advance.md already references 'defect D2' inline — confirms defect vocabulary is welcome there.
    - NEW investigate:* assets (Q23): llm/commands/investigate/{start,advance}.md + llm/agents/investigate-explorer.md, all added to the LINKS array in scripts/link-prompts.ts (which currently lists plan/* + implement/* only).
    - Reviewer defect bucket (Q22): plan-reviewer writes its review item directly (add a `defects[]` consideration -> orchestrator/command files defects); implement-reviewer returns JSON the /implement:advance orchestrator records (add `defects[]` to its JSON contract; advance.md files each as open defect + routes per Q26 file-and-defer).
    - Model tiers (decision K4) already established: frontier/standard/fast -> opus/sonnet/haiku (Claude) or host top/mid/fast (Codex); investigate-explorer is READ-ONLY (no worktree, Agent/Write/Edit disallowed, like plan-reviewer's disallowedTools).
    - UI surfaces for the 'Full' scope: the defects + hypothesis ledgers already render via the generic ItemTable/ScrollList (they are canonical ledgers); the #1 follow-up (M6) already adds milestone subsections + archive views generically. The #2 UI add is defect-centric: surface a defect's linked fix-tasks (dependsOn/ledgerRefs) and a hypothesis tree (parentHypothesis ancestry) as a relationship view in BOTH UIs.
    
    Sources: docs/ledgers.yaml; llm/commands+agents prompt files; scripts/link-prompts.ts; research-loop skill; Claude Code subagents/worktrees docs; answered questions Q19-Q28.
- milestones: ["M3","M6","M7","M8","M9"]
