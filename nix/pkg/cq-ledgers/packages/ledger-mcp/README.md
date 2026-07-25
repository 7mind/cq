# @cq/ledger-mcp

Standalone MCP server exposing the 27 ledger tools backed by a file-system
(`FsLedgerStore`) or git-object store.  Speaks stdio (default) and Streamable
HTTP (`--http`).

## Quick start — standalone binary

```sh
# stdio; ledger root = $LEDGER_ROOT or CWD
cq mcp

# explicit root
cq mcp --cwd /path/to/project

# Streamable HTTP on 127.0.0.1:7777
cq mcp --cwd /path/to/project --http 7777

# Prefix all 27 tool names with "myproj_"
cq mcp --cwd /path/to/project --tool-prefix myproj
```

Tool-name prefix rules: a prefix must match `^[a-zA-Z0-9]+$` (letters and
digits only).  The cq default is the empty string — tool names are unchanged.

## Building your own prefixed ledger MCP

Use `createLedgerMcpServer` when you need to embed the ledger tool surface
inside your own MCP server process, optionally under a distinct name prefix to
avoid collisions with other servers in the same Claude/Codex session.

### 1. Install

```sh
bun add @cq/ledger-mcp @cq/ledger @modelcontextprotocol/sdk
```

### 2. Wire it up

```ts
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLedgerMcpServer } from "@cq/ledger-mcp";
import { createLedgerStore } from "@cq/ledger";

// Build the store.  createLedgerStore honours cq.toml's [ledger] backend
// (fs or git-object); defaults to FsLedgerStore when no cq.toml is present.
// Pass your own absolute directory — nothing from cq's layout is assumed.
const root = path.resolve("/path/to/your/project");
const { store } = await createLedgerStore(root);

// Create the McpServer.
// - displayName  surfaces as serverInfo.title (clients show it in the UI).
// - toolPrefix   renames every tool to "<prefix>_<name>" so this server's
//                tools don't clash with another cq mcp instance in the
//                same session.  Omit (or pass "") for the default unprefixed
//                27-tool surface.
const server = createLedgerMcpServer({
  store,
  displayName: "my-project",
  toolPrefix: "myproj", // tools become myproj_enumerate_ledgers, myproj_create_item, …
});

// Connect a transport and serve.
const transport = new StdioServerTransport();
await server.connect(transport);
```

That is the complete setup: `createLedgerMcpServer` registers all 27 ledger
tools on the returned `McpServer`, applies the prefix to both tool names and the
server-level `instructions` text, and the process is ready to receive MCP
requests.

### 3. Discover prefixed tool names at runtime

MCP clients enumerate available tools via the standard `tools/list` protocol
call — the server returns the prefixed names automatically.  For compile-time
assertions (e.g. in tests) `@cq/ledger` exports a helper:

```ts
import { prefixedToolNames } from "@cq/ledger";

// Returns ["myproj_enumerate_ledgers", "myproj_create_item", …]
const names = prefixedToolNames("myproj");
```

### 4. Using FsLedgerStore directly

If you want to bypass `createLedgerStore`'s cq.toml resolution (e.g. you always
want the filesystem backend regardless of project config), construct
`FsLedgerStore` yourself:

```ts
import { FsLedgerStore } from "@cq/ledger";

const store = new FsLedgerStore({ root: "/path/to/your/project" });
await store.init();

const server = createLedgerMcpServer({
  store,
  displayName: "my-project",
  toolPrefix: "myproj",
});
```

### 5. No-code prefixed server via the CLI

If you do not need in-process embedding, the standalone binary covers the
no-code case:

```sh
cq mcp --cwd /path/to/your/project --tool-prefix myproj
```

The `--tool-prefix` flag applies the same prefix as the programmatic
`toolPrefix` option and is validated identically (`^[a-zA-Z0-9]+$`).

## Wire response contract

This contract landed as a single breaking cutover. No legacy peer is supported:
clients and servers must upgrade together. There is no compatibility flag, dual
response mode, or legacy handler. There is no default projection.

Item-bearing reads require `projection: "compact"` or `projection: "full"`:

- `compact` retains the intrinsic item fields `id`, `milestoneId`, `status`,
  `createdAt`, `updatedAt`, optional `author`/`session`, and only this field
  allowlist:

<!-- compact-item-fields:start -->
`headline`, `title`, `question`, `summary`, `severity`, `suggestedModel`,
`tags`, `sourceRefs`, `dependsOn`, `blockedBy`, `ledgerRefs`
<!-- compact-item-fields:end -->

- `full` retains the same intrinsic fields and every schema-defined entry in
  `fields`.
- Choose `compact` for discovery, status/reference checks, lists, and routing.
  Choose `full` only when the caller needs narrative or another field excluded
  from the compact allowlist. Omitting `projection` fails input validation.

Mutations return fixed acknowledgements, never full entities:

- Item acknowledgement: `{ id, milestoneId, status, fields:
  { dependsOn?, blockedBy?, ledgerRefs? }, createdAt, updatedAt, author?,
  session? }`.
- Milestone acknowledgement: `{ id, status, fields: { dependsOn?, blockedBy? },
  createdAt, updatedAt, author?, session? }`.
- Ledger acknowledgement: `{ id }`.

Use acknowledgement ids, canonicalized reference fields, status, timestamps,
and provenance directly. If later logic needs narrative content, issue a
separate `fetch_item` with `projection: "full"`; do not assume a mutation echoed
the item.

`fetch_ledger` alone supports page traversal. Supplying either `offset` or
`limit` selects the flattened response `{ ledger, items, total, offset, limit,
nextOffset }`; `offset` defaults to `0`, an omitted `limit` appears as `null`,
and `nextOffset` is `null` after the final page. Follow `nextOffset` with the
same positive `limit`. With neither parameter, the response retains milestone
grouping as `{ ledger: FetchedLedger }`.

The wire format remains minified JSON. Markdown responses were rejected because
they cost more tokens and require a second parser without improving this
contract. The general `fetch_items` alternative was rejected because explicit
compact reads plus the existing purpose-built list/search tools provide the
measured savings without another batching schema.

<!-- ledger-response-contract:start -->
| Tool | Category | Authoritative response |
|---|---|---|
| `enumerate_ledgers` | `purpose-built-small` | `{ ledgers, counts, ledgerSummaries: [{ name, itemCount, statusCounts, completedCount, progressTotal }] }` |
| `fetch_ledger` | `mandatory-item-projection` | Grouped `{ ledger }`, or paginated `{ ledger, items, total, offset, limit, nextOffset }`; every item uses the requested projection. |
| `fetch_ledger_archive` | `requested-full-content` | `{ archive }` with the requested archived item or milestone group in full. |
| `fetch_item` | `mandatory-item-projection` | `{ item }` using the requested projection. |
| `update_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `create_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `create_ledger` | `fixed-acknowledgement` | `{ ledger: { id } }`. |
| `search_items` | `mandatory-item-projection` | `{ items }` using the requested projection. |
| `fts_search` | `mandatory-item-projection` | `{ results: [{ ledgerId, item, score, matchedFields }] }`; each item uses the requested projection. |
| `create_milestone` | `fixed-acknowledgement` | `{ milestone: MilestoneAcknowledgement }`. |
| `update_milestone` | `fixed-acknowledgement` | `{ milestone: MilestoneAcknowledgement }`. |
| `fetch_milestone` | `mandatory-item-projection` | `{ milestone, resolved, references }`; milestone uses the requested projection. |
| `archive_milestone` | `purpose-built-small` | `{ pointer }` for the archived milestone. |
| `list_milestone_items` | `mandatory-item-projection` | `{ items: Record<ledgerId, Item[]> }`; every item uses the requested projection. |
| `snapshot` | `purpose-built-small` | `{ ledger: Record<ledgerId, Record<status, { count, items: [{ id, status, summary }] }>> }`. |
| `derive_predicates` | `purpose-built-small` | Predicate verdicts `{ value, items }` for `pInvestigate`, `pSeed`, `pPlan`, `pResearch`, `pImplement`, `openQuestionGate`, `belowFloor`, and `goalDrift`. |
| `reopen_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `unarchive_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `read_log` | `requested-full-content` | `{ path, content, truncated? }`. |
| `get_reviewers` | `purpose-built-small` | `{ configured, reviewers: [{ harness, model, alias }] }`. |
| `get_planners` | `purpose-built-small` | `{ configured, planners: [{ harness, model, alias }] }`. |
| `get_config` | `requested-full-content` | `{ configured, aliases, reviewers, planners, tiers, agentTiers, agentEfforts }`. |
| `get_agent_models` | `purpose-built-small` | `{ configured, agents: [{ id, status, modelClass, modelMappings }] }`. |
| `fetch_prompt` | `requested-full-content` | Full typed prompt entry, including prompt text and schemas when available. |
| `validate_input` | `purpose-built-small` | `{ ok: true }` or `{ ok: false, errors }`. |
| `validate_output` | `purpose-built-small` | `{ ok: true }` or `{ ok: false, errors }`. |
| `list_projects` | `purpose-built-small` | `{ projects: [{ key, displayName, createdAt? }] }`. |
<!-- ledger-response-contract:end -->

### Schema-checked request examples

The package test suite executes every call in this block against the live MCP
server. `consume` documents the acknowledgement field the client uses; it is
not sent as a tool argument.

<!-- ledger-response-examples:start -->
```json
[
  {
    "tool": "fetch_ledger",
    "arguments": {
      "ledger_id": "tasks",
      "projection": "compact",
      "offset": 0,
      "limit": 50
    }
  },
  {
    "tool": "fetch_item",
    "arguments": {
      "ledger_id": "tasks",
      "item_id": "T1",
      "projection": "full"
    }
  },
  {
    "tool": "search_items",
    "arguments": {
      "ledger_id": "tasks",
      "query": "Documented",
      "projection": "compact"
    }
  },
  {
    "tool": "fts_search",
    "arguments": {
      "query": "Documented",
      "ledger": "tasks",
      "projection": "compact",
      "limit": 20
    }
  },
  {
    "tool": "fetch_milestone",
    "arguments": {
      "milestone_id": "M1",
      "projection": "compact"
    }
  },
  {
    "tool": "list_milestone_items",
    "arguments": {
      "milestone_id": "M1",
      "projection": "compact"
    }
  },
  {
    "tool": "update_item",
    "arguments": {
      "ledger_id": "tasks",
      "item_id": "T1",
      "status": "wip"
    },
    "consume": "item.status"
  },
  {
    "tool": "create_item",
    "arguments": {
      "ledger_id": "tasks",
      "milestone_id": "M1",
      "status": "planned",
      "fields": {
        "headline": "Follow the documented acknowledgement"
      }
    },
    "consume": "item.id"
  },
  {
    "tool": "create_milestone",
    "arguments": {
      "title": "Use the allocated milestone id"
    },
    "consume": "milestone.id"
  }
]
```
<!-- ledger-response-examples:end -->

## Client development and migration

Treat response decoding as a closed 27-tool matrix, not as a generic
full-entity decoder. Require callers to choose a projection for the six
item-bearing read tools, model the three acknowledgement DTOs independently
from full items, and retain pagination metadata until `nextOffset` becomes
`null`. A client that needs more data after a mutation must fetch it explicitly.
Old clients that omit projections or decode mutations as full entities do not
interoperate with this cutover and must be upgraded with the server.

## Exported API

| Export | Description |
|---|---|
| `createLedgerMcpServer(opts)` | Main builder — returns a configured `McpServer` |
| `CreateLedgerMcpServerOptions` | Options interface for `createLedgerMcpServer` |
| `buildServer(store, displayName)` | Thin unprefixed wrapper |
| `attachMcpHttp(store, displayName, toolPrefix?)` | HTTP transport handlers for `Bun.serve` hosts |
| `serveHttp(store, opts, displayName, toolPrefix?)` | Launch a Streamable HTTP server |
| `startLedgerWatcher` / `startLedgerRefWatcher` | Coherence watchers for live-reload UIs |
| `MCP_HTTP_PATH` / `WS_PATH` / `LEDGER_TOPIC` | Well-known path/topic constants |

`createLedgerMcpServer` signature:

```ts
interface CreateLedgerMcpServerOptions {
  /** The ledger store the tools are bound to. */
  store: LedgerStore;
  /** Project display name carried on serverInfo.title + the instructions line. */
  displayName: string;
  /** Optional tool-name prefix (default '' = unprefixed). Must match /^[a-zA-Z0-9]+$/. */
  toolPrefix?: string;
}

function createLedgerMcpServer(opts: CreateLedgerMcpServerOptions): McpServer;
```
