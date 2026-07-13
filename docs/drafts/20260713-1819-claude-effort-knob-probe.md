# Probe: does Claude Code's Agent (subagent-dispatch) tool accept a per-dispatch reasoning-effort/thinking-budget knob?

**Task**: T510 (D79 fix 5a gate). **Date**: 2026-07-13. **Verdict up front**: **N/A** — no per-dispatch effort/reasoning parameter exists on the Agent tool; `effort` is a static field on the *subagent definition* (frontmatter / `--agents` JSON / SDK `agents` option), not an argument of the dispatch call.

## Probe method

Two independent sources were checked, both authoritative and both agreeing:

1. **Installed Claude Code CLI bundle** — the exact zod input-schema construction for the Agent tool (internal name `hi`, tool description "Launch a new agent"), extracted from the bundle's embedded source strings.
2. **Official docs** (`https://code.claude.com/docs/en/sub-agents`, fetched live via WebFetch) — the subagent frontmatter field reference, which documents `effort` as a *subagent-definition* field, never as a tool-call argument.

### 1. Installed bundle — Agent tool schema (verbatim)

Claude Code version: **2.1.207** (`claude --version` → `2.1.207 (Claude Code)`).
Resolved binary: `/nix/store/17wrzmbwdd7f8yn9sdjb94gyp2l6b9nl-claude-code/bin/claude` → symlink → `/nix/store/nzvng3zkpwibrwigahnnamjdl5hj5vsz-claude-code-no-autoupdate/...` → `/nix/store/66x2aw5m44cc4202kyjywslf3qgnkf3d-claude-code-2.1.207/libexec/claude-code/claude`.
Embedded build metadata found in the bundle: `2026-07-10T21:33:51Z`, commit `bc512d56332530b2be3f5079e29ec17aa20b8553`, package `@anthropic-ai/claude-code`.

Extracted via `strings -n 8` on the bundle file, the Agent tool's zod schema construction (variable names are minifier-generated, reproduced verbatim):

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
  run_in_background: E.boolean().optional().describe(
    "Agents run in the background by default; you will be notified when one completes. " +
    "Set to false to run this agent synchronously when you need its result before continuing."
  )
}))

KCy = Se(() => {
  let e = E.object({
    name: E.string()...describe("Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running."),
    team_name: E.string().optional().describe("Deprecated; ignored. The session has a single implicit team."),
    mode: Wol().optional().describe('Permission mode for spawned teammate (e.g., "plan" to require plan approval).')
  });
  return zCy().merge(e).extend({
    isolation: E.enum(["worktree","remote"]).optional().describe(
      '"worktree" creates a temporary git worktree ... "remote" launches the agent in a remote cloud environment ...'
    ),
    cwd: E.string().optional().describe('Absolute path to run the agent in. ... Mutually exclusive with isolation: "worktree".')
  })
})
```

**Full parameter set across both schema variants**: `description`, `prompt`, `subagent_type`, `model`, `run_in_background`, `name`, `team_name` (deprecated/ignored), `mode`, `isolation`, `cwd`. **No `effort`, `reasoning`, `thinking`, or `budget` field anywhere in this schema.** This matches exactly what this session's own Agent tool exposes (per the task's PROBE GUIDANCE: description, isolation, model, prompt, run_in_background, subagent_type).

The bundle's per-call implementation (`d_o = Oi({... async call({prompt, subagent_type, description, model, run_in_background, name, mode, isolation, cwd}, ...) {...}})`) destructures exactly this parameter set — confirming the schema is what's actually read at dispatch time, not dead code.

### 2. Official docs — `effort` is a subagent-definition field, not a dispatch parameter

`https://code.claude.com/docs/en/sub-agents` (fetched 2026-07-13), quoted verbatim:

> The `--agents` flag accepts JSON with the same [frontmatter](#supported-frontmatter-fields) fields as file-based subagents: `description`, `prompt`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `isolation`, and `color`.

> | `effort` | No | Effort level when this subagent is active. Overrides the session effort level. Default: inherits from session. Options: `low`, `medium`, `high`, `xhigh`, `max`; available levels depend on the model |

> As of v2.1.198, subagents also inherit the main conversation's extended thinking configuration: if thinking is on in your session, it's on for the subagent, and if it's off, it stays off. There is no per-subagent thinking setting.

So `effort` (and thinking on/off) is configured **once, statically, on the subagent's definition** (a `.claude/agents/*.md` frontmatter file, the `--agents` JSON flag, or the SDK's `agents` option) — it governs every dispatch to that subagent type, and is not, and cannot be, supplied as an argument on an individual Agent-tool call. This is architecturally different from the Workflow tool's `agent()` API, which — per the same bundle's embedded docstring — DOES expose a per-call `opts.effort`:

```
agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string,
  effort?: string, isolation?: ..., agentType?: string}): Promise<any>
...opts.effort overrides the reasoning effort for this agent call ('low' | 'medium' | 'high' | 'xhigh' | 'max')
— omit to inherit the session effort...
```

## Verdict

**N/A** — the standalone Agent tool (the subagent-dispatch tool available to a flow-asset orchestrator, as invoked from this runtime) has **no** per-dispatch effort/reasoning-budget parameter. `effort` exists only as a static field on the subagent *definition* (frontmatter / `--agents` JSON / SDK `agents` option), which is orthogonal to a per-call override — consistent with `model`, which explicitly *is* overridable per-call ("Takes precedence over the agent definition's model frontmatter") while `effort` has no such override path documented or present in the schema. The Workflow tool's `agent()` API is a genuinely different surface with a genuine `opts.effort` per-call override; the Agent tool is not that surface.

**Consequence for dependent asset tasks** (per T510 spec): every claude Agent dispatch site should document the recorded/considered claude effort as **provenance/display-only** — matching `cq-subagent-dispatch.ts`'s inert recording pattern at L700-747 (`childEffort` / `emittedEffort` are set for observability on the `claude:` fallback path but are never threaded into the actual dispatch, because there is nothing on the Agent tool to thread them into).
