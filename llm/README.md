# `llm/` — single-source LLM assets

This tree is the **single source of truth** for the plan-flow slash commands and
subagents. It follows a tool-agnostic **asset convention** so the same files feed
Claude Code, Codex, *and* a home-manager materializer with no per-tool copies.

## Convention

```
llm/commands/<ns>/<name>.md   → slash command  /<ns>:<name>
llm/agents/<name>.md          → subagent (name/description/tools frontmatter)
llm/skills/<name>/{meta.yaml,content.md}   → skill   (none in this repo yet)
llm/context.md                → CLAUDE.md / AGENTS.md fragment (optional; none here)
```

Current assets:

| File                              | Role                                               |
|-----------------------------------|----------------------------------------------------|
| `commands/plan/start.md`          | slash command — start a goal, file first questions |
| `commands/plan/advance.md`        | slash command — thin planner↔reviewer loop         |
| `agents/plan-advance.md`          | subagent — the planner (one state step)            |
| `agents/plan-reviewer.md`         | subagent — the adversarial reviewer                |

Edit the files HERE, never a symlink or a consumer's copy.

## Three consumers, one source

1. **Claude Code** (`.claude/*`, gitignored) — run `bun run link-prompts` after
   clone to (re)create the symlinks Claude discovers:

   | Claude link                          | → source                          |
   |--------------------------------------|-----------------------------------|
   | `.claude/commands/plan/start.md`     | `llm/commands/plan/start.md`      |
   | `.claude/commands/plan/advance.md`   | `llm/commands/plan/advance.md`    |
   | `.claude/agents/plan-advance.md`     | `llm/agents/plan-advance.md`      |
   | `.claude/agents/plan-reviewer.md`    | `llm/agents/plan-reviewer.md`     |

2. **Codex** (`.codex/prompts/*`) — committed symlinks into this tree; a fresh
   clone works with no extra step.

3. **Nix / home-manager** — `flake.nix` exposes `llmAssets` (see `./assets.nix`),
   a pure, IFD-free attrset `{ skills, commands, agents, context }` of file
   *contents*. A home-manager LLM module (e.g. in a nix-config) consumes
   `inputs.<this>.llmAssets` and materializes every asset into each agent's
   layout (`~/.claude/commands`, `~/.codex/prompts`, …) globally — no symlink
   script needed there. The repo-local symlinks above remain for in-repo
   dogfooding.

## No root `AGENTS.md` — deliberate

There is intentionally **no root `AGENTS.md`**. Codex resolves project docs via
`project_doc_fallback_filenames`, and a root `AGENTS.md` would shadow `CLAUDE.md`
for Codex. Keeping `CLAUDE.md` as the sole root project doc means both tools read
the same instructions.
