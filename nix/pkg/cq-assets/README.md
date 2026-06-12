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
| `commands/cq/plan.md`             | slash command — start a goal, file first questions |
| `commands/cq/plan/advance.md`        | slash command — thin planner↔reviewer loop         |
| `commands/cq/plan/follow-up.md`      | slash command — add scope to an existing goal, re-clarify |
| `agents/plan-advance.md`          | subagent — the planner (one state step)            |
| `agents/plan-reviewer.md`         | subagent — the adversarial reviewer (mode-gated write) |
| `commands/cq/plan-review.md`      | shared prompt — canonical plan-review rubric (Claude/Codex/Pi) |
| `commands/cq/implement-review.md` | shared prompt — canonical implement-review rubric (Claude/Codex/Pi) |
| `commands/cq/reviewers.md`        | session-only reviewer-set override command |
| `commands/cq/implement/start.md`     | slash command — resolve scope, hand to advance loop |
| `commands/cq/implement/advance.md`   | slash command — the implement orchestrator loop    |
| `agents/implement-worker.md`      | subagent — implements one task in an isolated worktree |
| `agents/implement-reviewer.md`    | subagent — adversarial per-task reviewer           |
| `agents/implement-conflict-resolver.md` | subagent — resolves rebase conflicts on merge-back |
| `commands/cq/investigate.md`      | slash command — start a root-cause investigation   |
| `commands/cq/investigate/advance.md` | slash command — the investigate orchestrator loop   |
| `agents/investigate-explorer.md`  | subagent — read-only hypothesis explorer           |
| `agents/investigate-prober.md`    | subagent — execution-capable evidence gatherer     |
| `commands/cq/advance.md`          | shared prompt — unified multi-flow advance coordinator |

Edit the files in this directory, never a symlink or a consumer's copy.

## Three consumers, one source

1. **Claude Code** (`.claude/*`, gitignored) — run `bun run link-prompts` after
   clone to (re)create the symlinks Claude discovers:

   | Claude link                          | → source                                   |
   |--------------------------------------|-------------------------------------------|
   | `.claude/commands/cq/plan.md`        | `../cq-assets/commands/cq/plan.md`        |
   | `.claude/commands/cq/plan/advance.md`   | `../cq-assets/commands/cq/plan/advance.md`   |
   | `.claude/commands/cq/plan/follow-up.md` | `../cq-assets/commands/cq/plan/follow-up.md` |
   | `.claude/agents/plan-advance.md`     | `../cq-assets/agents/plan-advance.md`     |
   | `.claude/agents/plan-reviewer.md`    | `../cq-assets/agents/plan-reviewer.md`    |
   | `.claude/commands/cq/implement/start.md`   | `../cq-assets/commands/cq/implement/start.md`   |
   | `.claude/commands/cq/implement/advance.md` | `../cq-assets/commands/cq/implement/advance.md` |
   | `.claude/agents/implement-worker.md`    | `../cq-assets/agents/implement-worker.md`    |
   | `.claude/agents/implement-reviewer.md`  | `../cq-assets/agents/implement-reviewer.md`  |
   | `.claude/agents/implement-conflict-resolver.md` | `../cq-assets/agents/implement-conflict-resolver.md` |
   | `.claude/commands/cq/investigate.md`      | `../cq-assets/commands/cq/investigate.md`      |
   | `.claude/commands/cq/investigate/advance.md` | `../cq-assets/commands/cq/investigate/advance.md` |
   | `.claude/agents/investigate-explorer.md`  | `../cq-assets/agents/investigate-explorer.md`  |
   | `.claude/agents/investigate-prober.md`    | `../cq-assets/agents/investigate-prober.md`    |
   | `.claude/commands/cq/advance.md`          | `../cq-assets/commands/cq/advance.md`          |
   | `.claude/commands/cq/plan-review.md`      | `../cq-assets/commands/cq/plan-review.md`      |
   | `.claude/commands/cq/implement-review.md` | `../cq-assets/commands/cq/implement-review.md` |
   | `.claude/commands/cq/reviewers.md`        | `../cq-assets/commands/cq/reviewers.md`        |

2. **Codex** (`.codex/prompts/*`) — committed symlinks into this tree; a fresh
   clone works with no extra step.

3. **Nix / home-manager** — `flake.nix` exposes assets (see `./assets.nix`),
   a pure, IFD-free attrset `{ skills, commands, agents, context }` of file
   *contents*. A home-manager LLM module (e.g. in a nix-config) consumes these
   assets and materializes every asset into each agent's layout (`~/.claude/commands`,
   `~/.codex/prompts`, …) globally — no symlink script needed there. The repo-local
   symlinks above remain for in-repo dogfooding.

## Configuration — cq.toml and the ledger MCP

An optional `cq.toml` file at the repo root configures reviewer and planner
harnesses via a `[aliases]` table and top-level `reviewers` and `planners`
lists. See `cq.toml.example` for the schema (alias names resolve to
`<harness>:<model>` tokens; absence of `cq.toml` means the native Claude
reviewer only). The `cq.toml` is parsed by the `@cq/config` parser package
and surfaced by the **ledger MCP server**, which exposes `get_reviewers`,
`get_config`, and `get_planners` as `mcp__ledger__*` tools over the `.mcp.json`
interface so orchestrator flows can dispatch parallel reviewers and planners
at review and plan gates. Planners mirror reviewers, resolving through the
same shared `[aliases]` table (see `cq.toml.example`).

## Session logs — subagent handover convention

Every subagent these flows dispatch (plan-flow *and* implement-flow) ends its
final message with a `### Session summary` block (**Did / Achieved / Discovered
/ Issues**). The subagent writes **no file** — it only emits the section. The
**orchestrator** command (`cq/plan`, `plan/advance`, `implement/start`,
`implement/advance`) persists it to
`.cq/logs/<timestamp>-<agent-id>.md` after each `Agent` call returns:
`<agent-id>` comes from the Agent tool result, `<timestamp>` is stamped by the
orchestrator (`date -u +%Y%m%d-%H%M%S`). This keeps subagents read-only (no
`Write` tool), avoids carrying a log file across worktree merge-back, and stays
concurrency-safe (a single writer, unique filenames). `.cq/logs/` is tracked
via `.gitkeep`; the `.cq/*.md` ledger files live in a different place and are
unaffected.

## No root `AGENTS.md` — deliberate

There is intentionally **no root `AGENTS.md`**. Codex resolves project docs via
`project_doc_fallback_filenames`, and a root `AGENTS.md` would shadow `CLAUDE.md`
for Codex. Keeping `CLAUDE.md` as the sole root project doc means both tools read
the same instructions.
