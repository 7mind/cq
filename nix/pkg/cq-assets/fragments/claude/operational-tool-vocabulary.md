## Operational tool vocabulary

Use these exact Claude-callable ledger MCP tools whenever the canonical prompt uses a neutral operational token:

- `ledger::derive_predicates` → `mcp__ledger__derive_predicates({})`
- `ledger::get_config("<section>")` → `mcp__ledger__get_config({"section":"<section>"})`
- `prompt-catalog fetch ("<roleId>")` → call `mcp__ledger__fetch_prompt` with `{ "roleId": "<roleId>" }`
