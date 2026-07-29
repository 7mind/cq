---
description: Set a session-only planner panel from aliases or adapter:model tokens.
argument-hint: <planner instruction>
# {{cq:fragment:host-tool-vocabulary}}
---

{{cq:fragment:cq-command-invocation}}

## Catalogue
```yaml
inputs:
  - "natural-language alias list or adapter:model tokens"
outputs:
  - "resolved session-only planner set; no durable write"
ioSchema:
  - "cq.toml aliases take precedence; unknown aliases fail explicitly"
```

Parse `$ARGUMENTS` into planner aliases/tokens. Resolve named aliases from the
configured `aliases` section, case-insensitively. If alias configuration is
unavailable, reject aliases explicitly. Accept an explicit `adapter:model`
token verbatim. Report every unknown alias; never silently drop it.

Echo the original instruction, resolution source, ordered alias-to-token
mapping, and canonical token list. State that the override lives only in the
current chained run, writes no file or ledger item, and reverts to configured
planners—or the orchestrator's native fallback—on a fresh run. The plan
orchestrator uses this in-memory set before consulting planner configuration.
