# Smoke test: Claude Code Agent tool `model` param with full `claude-*` IDs

**Task**: T509 (Q252 empirical gate). **Date**: 2026-07-13.
**Verdict up front**: **BARE-ALIAS-FALLBACK** — the Agent tool's per-invocation
`model` override accepts ONLY the four bare family aliases
`["sonnet","opus","haiku","fable"]`. Full `claude-*` IDs (e.g.
`claude-opus-4-8`, `claude-opus-4-8[1m]`) are NOT valid values for this
parameter.

## Probe method

The sibling task T510 (D79 5a gate) had already extracted the Claude Code
2.1.207 Agent-tool zod input schema verbatim from the installed bundle while
investigating a different question (whether the tool exposes a per-dispatch
effort knob). That extraction incidentally captured the `model` parameter's
schema, which is the evidence this task needs. This task re-examined that
extraction and confirms it directly (no new bundle probe was required, since
the exact same installed binary and Claude Code version apply to this
session):

1. **Installed Claude Code CLI bundle** — resolved binary
   `/nix/store/17wrzmbwdd7f8yn9sdjb94gyp2l6b9nl-claude-code/bin/claude` →
   symlink chain → `/nix/store/66x2aw5m44cc4202kyjywslf3qgnkf3d-claude-code-2.1.207/libexec/claude-code/claude`.
   `claude --version` → `2.1.207 (Claude Code)`. Embedded build metadata:
   `2026-07-10T21:33:51Z`, commit `bc512d56332530b2be3f5079e29ec17aa20b8553`,
   package `@anthropic-ai/claude-code`.
2. Extracted via `strings -n 8` on the bundle file: the Agent tool's (internal
   name `hi`, description "Launch a new agent") zod schema construction,
   reproduced verbatim below.

### Verbatim enum evidence

```js
zCy = Se(() => E.object({
  description: E.string().describe("A short (3-5 word) description of the task"),
  prompt: E.string().describe("The task for the agent to perform"),
  subagent_type: E.string().optional().describe("The type of specialized agent to use for this task"),
  model: E.enum(["sonnet","opus","haiku","fable"]).optional().describe(
    "Optional model override for this agent. Takes precedence over the agent definition's model " +
    "frontmatter. If omitted, uses the agent definition's model, or inherits from the parent. " +
    "Ignored for subagent_type: \"fork\" — forks always inherit the parent model."
  ),
  run_in_background: E.boolean().optional().describe(...)
}))
```

`model: E.enum(["sonnet","opus","haiku","fable"]).optional()` is the complete
type of the per-invocation `model` override on the Agent tool — a closed
4-value zod enum, not a free-form string. There is no pattern/refinement that
would additionally accept a full `claude-*` ID or a `[1m]`-suffixed variant;
zod's `.enum()` rejects any value outside the listed literals at validation
time (would surface as a tool-call schema-validation error at dispatch, not a
silent fallback).

**Contrast with valid full-ID surfaces** (not tested here, established by
existing docs/config, cited for completeness): the CLI's `--model` flag and
agent-DEFINITION frontmatter (`.claude/agents/*.md` `model:` field, or the
`--agents` JSON flag's `model` key) both accept full `claude-*` model ID
strings including `[1m]`-suffixed variants. These are a different mechanism
from the Agent tool's per-invocation `model` parameter that cq's flow assets
use to dispatch subagents — only the latter is gated to the 4-value enum.

## Verdict: BARE-ALIAS-FALLBACK

The Agent per-invocation model override accepts only
`[sonnet, opus, haiku, fable]`.

**Consequence**: T508 had pinned cq's default `[aliases]` claude values to
full `claude-*` IDs (e.g. `claude:claude-opus-4-8[1m]`) on the theory that
pinning to an exact model+context-window variant was more precise than a bare
alias. That pin is incompatible with the actual dispatch mechanism — cq's
flow assets dispatch claude subagents via the Agent tool's `model` param,
which rejects anything outside the 4-value enum. This task (T509) flips the
defaults back to bare family aliases (`claude:opus`, `claude:sonnet`,
`claude:haiku`, `claude:fable`, `claude:opus:max` / `claude:opus:high`) — the
plan's designed fallback for exactly this empirical outcome. On the
Anthropic API, the bare aliases already resolve to the current family at
native 1M context (Opus 4.8 / Sonnet 5 / Fable 5 all run at 1M by default),
so no `[1m]` suffix is needed to get the intended context window.
