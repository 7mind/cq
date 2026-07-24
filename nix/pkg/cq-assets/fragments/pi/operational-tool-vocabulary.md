## Operational tool vocabulary

Use these exact Pi-callable ledger MCP tools whenever the canonical prompt uses a neutral operational token:

- `ledger::derive_predicates` → `derive_predicates({})`
- `ledger::get_config` → `get_config({})`
- `ledger::get_reviewers` → `get_reviewers({})`
- `prompt-catalog fetch ("<roleId>")` → call `fetch_prompt` with `{ "roleId": "<roleId>" }`
