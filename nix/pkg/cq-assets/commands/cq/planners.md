---
description: Session-only planner-set override — parse a natural-language planner instruction (e.g. "use grok and opus only") into canonical harness:model tokens via the cq.toml [aliases] table (from the ledger MCP get_planners/get_config) plus a documented fallback map; echo the resolved active set; confirm the override is SESSION-ONLY and reverts on the next fresh run.
argument-hint: <natural-language planner instruction>  # e.g. "use grok and opus only"
allowed-tools: mcp__ledger__get_planners, mcp__ledger__get_config, Read
---

## Catalogue
```yaml
inputs:
  - "natural-language planner instruction ($ARGUMENTS, e.g. 'use grok and opus only')"
outputs:
  - "resolved active planner token set echoed to stdout (SESSION-ONLY, not written to any file or ledger)"
ioSchema:
  - "resolves alias names via cq.toml [aliases] (get_config) then built-in fallback map"
  - "canonical token form: harness:model (e.g. claude:opus-4.8[1m], pi:grok-build)"
  - "SESSION-ONLY: override lives in conversation context of current chained run only"
  - "reverts to cq.toml default (or single native Claude planner) on next fresh run"
  - "unrecognised aliases reported as error; no silent drops"
```

You are the **planner-set override command**. The user has stated a planner
preference for the current chained run:

> $ARGUMENTS

Your job:
1. **Parse** the natural-language instruction into a set of alias names.
2. **Resolve** each alias name to a canonical `harness:model` token via the
   cq.toml `[aliases]` table (from the ledger MCP), falling back to the documented
   built-in map when cq.toml is absent or the alias is not declared there.
3. **Echo** the resolved active planner set in human-readable and token form.
4. **State** clearly that the override is SESSION-ONLY — it applies ONLY to the
   current chained run (the conversation context in which you issue this command)
   and reverts to the cq.toml default on the next fresh `/cq:plan:advance`
   invocation.

You write **NOTHING durable** — no file, no ledger item, no gitignored state.
The Write tool is not in your allowed-tools and must not be used.

---

## Step 1 — Query the ledger MCP for the configured alias table

Call `get_config` (from the ledger MCP server) to retrieve the repo's
`cq.toml` aliases and planner list. The result shape is:

```json
{
  "configured": true | false,
  "aliases": { "<alias>": { "harness": "claude" | "pi", "model": "<model>" } },
  "planners": ["<alias>", "..."]
}
```

If `configured: false` (no `cq.toml` in the repo, or its `[planners]` list is
empty), the alias table is empty; use ONLY the built-in fallback map below.

If the ledger MCP server is not available (tool call fails), treat the result
as `configured: false` and continue with the fallback map — do not abort.

## Step 2 — Built-in fallback alias map

When cq.toml is absent OR when a name from the user's instruction is not
declared in the `[aliases]` table, resolve it through this hardcoded map:

| Alias name   | Canonical token         |
|--------------|------------------------|
| `grok`       | `pi:grok-build`         |
| `opus`       | `claude:opus-4.8[1m]`  |
| `codex`      | `pi:gpt-5.5`            |

These names are case-insensitive. The list is intentionally minimal; extend it
ONLY via `cq.toml [aliases]`, not by patching this fallback map.

Resolution precedence: **cq.toml `[aliases]` takes priority** over the fallback
map. If the same name appears in both, the cq.toml definition wins.

## Step 3 — Parse the instruction into alias names

Extract the planner aliases from the natural-language `$ARGUMENTS`. Typical
forms include:
- `"use grok and opus only"` → `["grok", "opus"]`
- `"only codex"` → `["codex"]`
- `"grok, opus, codex"` → `["grok", "opus", "codex"]`
- `"just opus"` → `["opus"]`
- a bare `harness:model` token (e.g. `"claude:opus-4.8[1m]"`) → take it
  verbatim as an already-resolved token; skip alias lookup for that entry.

Unrecognised alias names (not in cq.toml AND not in the fallback map) are an
error: report them by name and ask the user to either add them to `cq.toml
[aliases]` or use a known name.

## Step 4 — Resolve each alias to a canonical token

For each parsed alias name `A`:
1. If `A` is already a `harness:model` token (contains `:`), use it as-is.
2. Else if `A` is in the cq.toml `aliases` table (from Step 1), use
   `"<harness>:<model>"` from that entry.
3. Else if `A` (case-insensitive) is in the fallback map (Step 2), use the
   fallback canonical token.
4. Else: report as unrecognised — do not silently drop it.

## Step 5 — Echo the resolved active set

Print a clear confirmation block:

```
Planner override for this run
================================
Instruction : <verbatim $ARGUMENTS>
Source      : cq.toml aliases  |  built-in fallback  (one or both)

Active planner set (applies to this session only):
  1. <alias>  →  <harness>:<model>
  2. ...

Canonical tokens: <harness1>:<model1>, <harness2>:<model2>, ...

SESSION-ONLY: this override lives in the conversation context of the current
chained run. It is NOT written to any file or ledger. The next fresh
/cq:plan:advance invocation (in a new session) will revert to the planner set
declared in cq.toml (or the single native Claude planner if cq.toml is
absent / unconfigured).

To make this permanent, edit cq.toml [planners] in the repo root.
```

## How the override is carried

Because each `/cq:plan:advance` orchestrator invocation is a fresh session, the
override lives **in the conversation context of the current chained run**:
- The user states `/cq:planners use grok and opus only` in the same session
  BEFORE or WHILE running `/cq:plan:advance`.
- The orchestrator READS the stated active set from the run context when
  deciding which planners to dispatch.
- When NO override has been stated in the current run context, the orchestrator
  falls back to `get_planners` (the cq.toml default, or the single native
  Claude planner if unconfigured).

This means:
- **Override applies now**: the current `/cq:plan:advance` chained in this same
  session will use the stated planner set.
- **Override does NOT persist**: a brand-new session (user opens a fresh Claude
  Code window, or runs the slash command cold) has no memory of this override
  and reads from cq.toml instead.
- **No file is written**: there is no `.cq-planners-override`, no gitignored
  state, no ledger item recording the override.

## Consistency with /cq:plan:advance

The orchestrator (`commands/cq/plan/advance.md`) selects planners as follows when
the planner-set override is live:

> **Session override present?** If the user stated a planner set in this run
> (via `/cq:planners …`), use the canonical tokens the user confirmed. The
> stated tokens take precedence over `get_planners`.
>
> **No session override?** Call `get_planners` (ledger MCP). If
> `configured: true`, use the returned resolved set. If `configured: false`,
> fall back to the single native Claude planner.

Stating `/cq:planners` in the session is therefore the correct and ONLY way to
override the planner set for a single chained run without editing `cq.toml`.
