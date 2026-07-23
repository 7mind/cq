---
description: Start an implement-flow run — resolve the target milestones (default: all open ones), validate their task DAG, then hand off to the /cq:implement:advance loop.
argument-hint: [milestoneId ...]   # optional; omit to target every open milestone
allowed-tools: mcp__ledger__*, Agent, Write, Bash, Read, Grep, Glob
---

## Catalogue
```yaml
inputs:
  - "optional milestone ids ($ARGUMENTS); empty = all open non-archived non-terminal milestones with non-terminal tasks"
outputs:
  - "scope report: target milestone ids, task counts, initial ready-set"
  - "implement-flow advance pass run inline (full /cq:implement:advance output)"
  - "handoffs item (this command is the outermost wrapper)"
ioSchema:
  - "bootstrap only — scope resolution + DAG sanity check; /cq:implement:advance owns all execution"
  - "ready-set: tasks with no unsatisfied dependsOn, not blocked, no open question"
  - "handoffs item: /cq:implement:advance suppresses its own handoff when chained here"
  - "run is resumable via /cq:implement:advance (no need to re-run /cq:implement:start)"
```

You are **bootstrapping an implement-flow run**. The user's target milestones
are:

> $ARGUMENTS

This command does the one-time **scope resolution** only, then hands off to the
`/cq:implement:advance` loop. It owns NO execution logic of its own — the entire
pass (DAG-ready pickup, worktree dispatch, review, criticism loop, question
registration, merge-back) lives in `/cq:implement:advance`, so that logic exists in
exactly ONE place (exactly as `/cq:plan` does the goal bootstrap and hands the
round to `plan-advance`).

## No confirmation checkpoints — just run (hard rule)
This flow is **fully autonomous by default**. Do NOT pause to ask the user to
confirm scope, branch, or "should I proceed?". The defaults are fixed and NOT up
for confirmation:
- **Scope** = the broadest applicable set. Empty `$ARGUMENTS` → ALL open
  milestones; an explicit list → exactly that list. Never ask "all or a subset?".
- **Integration target** = the **current branch** (merge-back lands here, per
  `/cq:implement:advance`). Never ask "which branch / main or a feature branch?".
- **Cadence** = run the whole `/cq:implement:advance` loop to completion (everything
  done, or blocked on a genuine question). Never ask "one pass then pause?".

A confirmation checkpoint is wasted latency and is forbidden. The ONLY legitimate
way to surface a blocker is a `questions` ledger item that a subagent or the loop
files for a genuine unknown (answered later in the TUI/web) — never an inline
"do you want me to…?" prompt. When in doubt, take the broadest sensible default
and proceed; the user can interrupt if they disagree.

## Provenance (every ledger write)
On any `create_item` / `update_item`, pass `author` = your OWN model class
(derived from runtime identity, never hardcoded — Claude Opus 4.8 (1M) →
`"opus-4.8[1m]"`; Codex GPT-5.x → e.g. `"gpt-5.5"`) and `session` =
`$CLAUDE_CODE_SESSION_ID` (or the Codex equivalent; omit if unavailable).

## Steps

1. **Resolve the target milestone set.**
   - If `$ARGUMENTS` lists milestone ids → those are the targets. `fetch_milestone`
     each to VALIDATE it exists and is non-archived, non-terminal; abort with a
     clear message on any unknown/archived id.
   - If `$ARGUMENTS` is empty → target **ALL** open milestones: every
     non-archived, non-terminal milestone in the `milestones` ledger that has at
     least one non-terminal linked `tasks` item (`list_milestone_items` to check).
     Skip milestones whose tasks are all terminal (nothing to do).

2. **Resolve and sanity-check the task DAG.** For each target, collect its
   `tasks` and their `dependsOn` edges (and the milestones' own
   `dependsOn`/`blockedBy`). Confirm there is at least one task that is ready to
   start (no unsatisfied `dependsOn`, not `blocked`, no `open` question). If a
   target has tasks but NONE are ready (e.g. all are blocked on open questions),
   report that — the run can still proceed for the other targets.

3. **Report the resolved scope.** State the target milestone ids, the count of
   tasks per target, and the initial ready-set (the tasks the first pass will
   pick up). No scope marker item is created — the ledger task states ARE the
   durable scope; `/cq:implement:advance` re-derives everything from them.

4. **Hand off to the advance loop.** Now execute the `/cq:implement:advance` pass
   over the resolved target set — follow the full loop spec in
   `llm/commands/cq/implement/advance.md` (READY-SET → dispatch workers → review →
   criticism loop → questions → success gate → merge-back, plus its session-log
   recording — ALL logs written via `cq log put` (summary `.md` to `logs/` →
   `sessionLogs`, raw transcript to `logs/raw/` → `rawLogs`; never a direct
   `Write` to `.cq/logs` and never `git add` of logs) — and provenance rules).
   Do NOT restate or duplicate that logic here;
   run it. Then produce `/cq:implement:advance`'s end-of-pass report.

This command is the outermost wrapper for this invocation (the user ran
`/cq:implement:start`), so the inline `/cq:implement:advance` pass **SUPPRESSES its
own handoff write** (per implement/advance.md's CHAINED section — `/<flow>:start`
is listed as a suppress-context), and **this command** writes the ONE `handoffs`
record at the stop. Use the field schema from implement/advance.md's §Handoff
record, STANDALONE branch (do not restate the mapping here).

The run is resumable: after the user answers any registered questions, they
re-run **`/cq:implement:advance`** (no need to re-run `/cq:implement:start`).
