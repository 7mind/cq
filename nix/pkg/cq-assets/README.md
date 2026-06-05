# `nix/pkg/cq-assets/` — single-source LLM assets

This directory is the **single source of truth** for the plan-flow slash commands and
subagents. It follows a tool-agnostic **asset convention** so the same files feed
Claude Code, Codex, *and* a home-manager materializer with no per-tool copies.

## Convention

```
commands/<ns>/<name>.md       → slash command  /<ns>:<name>
agents/<name>.md              → subagent (name/description/tools frontmatter)
skills/<name>/{meta.yaml,content.md}   → skill   (none in this repo yet)
context.md                    → CLAUDE.md / AGENTS.md fragment (optional; none here)
```

Current assets:

| File                              | Role                                               |
|-----------------------------------|----------------------------------------------------|
| `commands/plan/start.md`          | slash command — start a goal, file first questions |
| `commands/plan/advance.md`        | slash command — thin planner↔reviewer loop         |
| `commands/plan/follow-up.md`      | slash command — add scope to an existing goal, re-clarify |
| `agents/plan-advance.md`          | subagent — the planner (one state step)            |
| `agents/plan-reviewer.md`         | subagent — the adversarial reviewer (mode-gated write) |
| `commands/cq/plan-review.md`      | shared prompt — canonical plan-review rubric (Claude/Codex/Pi) |
| `commands/implement/start.md`     | slash command — resolve scope, hand to advance loop |
| `commands/implement/advance.md`   | slash command — the implement orchestrator loop    |
| `agents/implement-worker.md`      | subagent — implements one task in an isolated worktree |
| `agents/implement-reviewer.md`    | subagent — adversarial per-task reviewer           |
| `agents/implement-conflict-resolver.md` | subagent — resolves rebase conflicts on merge-back |

Edit the files in this directory, never a symlink or a consumer's copy.

## Three consumers, one source

1. **Claude Code** (`.claude/*`, gitignored) — run `bun run link-prompts` after
   clone to (re)create the symlinks Claude discovers:

   | Claude link                          | → source                                   |
   |--------------------------------------|-------------------------------------------|
   | `.claude/commands/plan/start.md`     | `../cq-assets/commands/plan/start.md`     |
   | `.claude/commands/plan/advance.md`   | `../cq-assets/commands/plan/advance.md`   |
   | `.claude/commands/plan/follow-up.md` | `../cq-assets/commands/plan/follow-up.md` |
   | `.claude/agents/plan-advance.md`     | `../cq-assets/agents/plan-advance.md`     |
   | `.claude/agents/plan-reviewer.md`    | `../cq-assets/agents/plan-reviewer.md`    |
   | `.claude/commands/implement/start.md`   | `../cq-assets/commands/implement/start.md`   |
   | `.claude/commands/implement/advance.md` | `../cq-assets/commands/implement/advance.md` |
   | `.claude/agents/implement-worker.md`    | `../cq-assets/agents/implement-worker.md`    |
   | `.claude/agents/implement-reviewer.md`  | `../cq-assets/agents/implement-reviewer.md`  |
   | `.claude/agents/implement-conflict-resolver.md` | `../cq-assets/agents/implement-conflict-resolver.md` |

2. **Codex** (`.codex/prompts/*`) — committed symlinks into this tree; a fresh
   clone works with no extra step.

3. **Nix / home-manager** — `flake.nix` exposes assets (see `./assets.nix`),
   a pure, IFD-free attrset `{ skills, commands, agents, context }` of file
   *contents*. A home-manager LLM module (e.g. in a nix-config) consumes these
   assets and materializes every asset into each agent's layout (`~/.claude/commands`,
   `~/.codex/prompts`, …) globally — no symlink script needed there. The repo-local
   symlinks above remain for in-repo dogfooding.

## Session logs — subagent handover convention

Every subagent these flows dispatch (plan-flow *and* implement-flow) ends its
final message with a `### Session summary` block (**Did / Achieved / Discovered
/ Issues**). The subagent writes **no file** — it only emits the section. The
**orchestrator** command (`plan/start`, `plan/advance`, `implement/start`,
`implement/advance`) persists it to
`docs/logs/<timestamp>-<agent-id>.md` after each `Agent` call returns:
`<agent-id>` comes from the Agent tool result, `<timestamp>` is stamped by the
orchestrator (`date -u +%Y%m%d-%H%M%S`). This keeps subagents read-only (no
`Write` tool), avoids carrying a log file across worktree merge-back, and stays
concurrency-safe (a single writer, unique filenames). `docs/logs/` is tracked
via `.gitkeep`; the `docs/*.md` ledger files live in a different place and are
unaffected.

## No root `AGENTS.md` — deliberate

There is intentionally **no root `AGENTS.md`**. Codex resolves project docs via
`project_doc_fallback_filenames`, and a root `AGENTS.md` would shadow `CLAUDE.md`
for Codex. Keeping `CLAUDE.md` as the sole root project doc means both tools read
the same instructions.
