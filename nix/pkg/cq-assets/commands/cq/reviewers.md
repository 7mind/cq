---
description: Session-only reviewer-set override — parse a natural-language reviewer instruction (e.g. "use grok and opus only") into canonical harness:model tokens via the cq.toml [aliases] table (from the ledger MCP get_reviewers/get_config) plus a documented fallback map; echo the resolved active set; confirm the override is SESSION-ONLY and reverts on the next fresh run.
argument-hint: <natural-language reviewer instruction>  # e.g. "use grok and opus only"
allowed-tools: mcp__ledger__get_reviewers, mcp__ledger__get_config, Read
---

## Catalogue
```yaml
inputs:
  - "natural-language reviewer instruction ($ARGUMENTS, e.g. 'use grok and opus only')"
outputs:
  - "resolved active reviewer token set echoed to stdout (SESSION-ONLY, not written to any file or ledger)"
ioSchema:
  - "resolves alias names via cq.toml [aliases] (get_config) then built-in fallback map"
  - "canonical token form: harness:model (e.g. claude:opus-4.8[1m], pi:grok-build)"
  - "SESSION-ONLY: override lives in conversation context of current chained run only"
  - "reverts to cq.toml default (or single native Claude reviewer) on next fresh /cq:plan:advance or /cq:implement:advance"
  - "symmetric to /cq:planners but targets the reviewer set (get_reviewers)"
  - "unrecognised aliases reported as error; no silent drops"
```

You are the **reviewer-set override command**. The user has stated a reviewer
preference for the current chained run:

> $ARGUMENTS

Your job:
1. **Parse** the natural-language instruction into a set of alias names.
2. **Resolve** each alias name to a canonical `harness:model` token via the
   cq.toml `[aliases]` table (from the ledger MCP), falling back to the documented
   built-in map when cq.toml is absent or the alias is not declared there.
3. **Echo** the resolved active reviewer set in human-readable and token form.
4. **State** clearly that the override is SESSION-ONLY — it applies ONLY to the
   current chained run (the conversation context in which you issue this command)
   and reverts to the cq.toml default on the next fresh `/cq:plan:advance` or
   `/cq:implement:advance` invocation.

You write **NOTHING durable** — no file, no ledger item, no gitignored state.
The Write tool is not in your allowed-tools and must not be used.

---

## Step 1 — Query the ledger MCP for the configured alias table

Call `get_config` (from the ledger MCP server) to retrieve the repo's
`cq.toml` aliases and reviewer list. The result shape is:

```json
{
  "configured": true | false,
  "aliases": { "<alias>": { "harness": "claude" | "pi", "model": "<model>" } },
  "reviewers": ["<alias>", "..."]
}
```

If `configured: false` (no `cq.toml` in the repo, or its `[reviewers]` list is
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
| `codex`      | `pi:gpt-5.6-sol`            |

These names are case-insensitive. The list is intentionally minimal; extend it
ONLY via `cq.toml [aliases]`, not by patching this fallback map.

Resolution precedence: **cq.toml `[aliases]` takes priority** over the fallback
map. If the same name appears in both, the cq.toml definition wins.

## Step 3 — Parse the instruction into alias names

Extract the reviewer aliases from the natural-language `$ARGUMENTS`. Typical
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
Reviewer override for this run
================================
Instruction : <verbatim $ARGUMENTS>
Source      : cq.toml aliases  |  built-in fallback  (one or both)

Active reviewer set (applies to this session only):
  1. <alias>  →  <harness>:<model>
  2. ...

Canonical tokens: <harness1>:<model1>, <harness2>:<model2>, ...

SESSION-ONLY: this override lives in the conversation context of the current
chained run. It is NOT written to any file or ledger. The next fresh
/cq:plan:advance or /cq:implement:advance invocation (in a new session) will revert
to the reviewer set declared in cq.toml (or the single native Claude reviewer
if cq.toml is absent / unconfigured).

To make this permanent, edit cq.toml [reviewers] in the repo root.
```

## How the override is carried

Because each `/cq:plan:advance` and `/cq:implement:advance` orchestrator invocation
is a fresh session, the override lives **in the conversation context of the
current chained run**:
- The user states `/cq:reviewers use grok and opus only` in the same session
  BEFORE or WHILE running `/cq:plan:advance` or `/cq:implement:advance`.
- Those orchestrators READ the stated active set from the run context when
  deciding which reviewers to dispatch.
- When NO override has been stated in the current run context, those
  orchestrators fall back to `get_reviewers` (the cq.toml default, or the
  single native Claude reviewer if unconfigured).

This means:
- **Override applies now**: the current `/cq:plan:advance` or `/cq:implement:advance`
  chained in this same session will use the stated reviewer set.
- **Override does NOT persist**: a brand-new session (user opens a fresh Claude
  Code window, or runs the slash command cold) has no memory of this override
  and reads from cq.toml instead.
- **No file is written**: there is no `.cq-reviewers-override`, no gitignored
  state, no ledger item recording the override.

## Consistency with /cq:plan:advance and /cq:implement:advance

The orchestrators (`commands/cq/plan/advance.md`, `commands/cq/implement/advance.md`)
select reviewers as follows when T175/T176 are live:

> **Session override present?** If the user stated a reviewer set in this run
> (via `/cq:reviewers …`), use the canonical tokens the user confirmed. The
> stated tokens take precedence over `get_reviewers`.
>
> **No session override?** Call `get_reviewers` (ledger MCP). If
> `configured: true`, use the returned resolved set. If `configured: false`,
> fall back to the single native Claude reviewer.

Stating `/cq:reviewers` in the session is therefore the correct and ONLY way to
override the reviewer set for a single chained run without editing `cq.toml`.
