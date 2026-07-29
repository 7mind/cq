## Operational tool vocabulary

Use these exact Pi-callable ledger MCP tools whenever the canonical prompt uses a neutral operational token:

- `ledger::derive_predicates` → `derive_predicates({})`
- `ledger::get_config("<section>")` → `get_config({"section":"<section>"})`
- `prompt-catalog fetch ("<roleId>")` → call `fetch_prompt` with `{ "roleId": "<roleId>" }`
