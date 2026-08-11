# @cq/ledger-mcp

Standalone MCP server exposing the 31 ledger tools backed by an xdg/sqlite,
filesystem, or PostgreSQL ledger store. Speaks stdio (default) and Streamable
HTTP (`--http`). The six dispatch-lifecycle tools use a separate durable,
namespaced attestation backend and appear only when the server has both a
supported backend construction and an attested prompt surface.

## Quick start — standalone binary

```sh
# stdio; ledger root = $LEDGER_ROOT or CWD
cq mcp

# explicit root
cq mcp --cwd /path/to/project

# Streamable HTTP on 127.0.0.1:7777
cq mcp --cwd /path/to/project --http 7777

# Prefix all 31 tool names with "myproj_"
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
import {
  createLedgerMcpServer,
  createSingleProjectDispatchRuntime,
  resolvePromptSurface,
} from "@cq/ledger-mcp";
import { createLedgerStore } from "@cq/ledger";

// Build the ledger store and the installed attested prompt surface.
const root = path.resolve("/path/to/your/project");
const resolved = await createLedgerStore(root);
const promptSurface = resolvePromptSurface({
  promptSurface: undefined,
  promptRoot: undefined,
  environment: process.env,
});
const dispatchRuntime = await createSingleProjectDispatchRuntime({
  construction: "direct",
  resolved,
  ...(promptSurface === undefined
    ? {}
    : { promptArtifactStore: promptSurface.store }),
  environment: process.env,
});

// Create the McpServer.
// - displayName  surfaces as serverInfo.title (clients show it in the UI).
// - toolPrefix   renames every tool to "<prefix>_<name>" so this server's
//                tools don't clash with another cq mcp instance in the
//                same session.  Omit (or pass "") for the default unprefixed
//                tool surface.
const server = createLedgerMcpServer({
  store: resolved.store,
  displayName: "my-project",
  toolPrefix: "myproj", // tools become myproj_enumerate_ledgers, myproj_create_item, …
  configRoot: resolved.configRoot,
  ...(resolved.projectKey === undefined ? {} : { projectKey: resolved.projectKey }),
  ...(promptSurface === undefined ? {} : { promptArtifactStore: promptSurface.store }),
  ...(dispatchRuntime.kind === "available"
    ? { dispatchCapability: dispatchRuntime.capability }
    : {}),
});

// Connect a transport and serve.
const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async (): Promise<void> => {
  await dispatchRuntime.close();
  await resolved.store.dispose();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
```

With a supported backend and attested prompt surface, this registers all 31
tools. Without a durable dispatch runtime, `createLedgerMcpServer` omits the
six dispatch-lifecycle tools before registration and exposes the remaining
23. The prefix applies to every tool that the server registers and to matching
references in its server-level `instructions`.

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

This lower-level form has no attestation namespace or prompt surface, so it
registers the 23 non-dispatch tools. Use the resolved-store construction above
when dispatch lifecycle support is required.

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
`headline`, `title`, `question`, `answer`, `summary`, `severity`, `suggestedModel`,
`tags`, `sourceRefs`, `dependsOn`, `blockedBy`, `ledgerRefs`
<!-- compact-item-fields:end -->

- `full` retains the same intrinsic fields and every schema-defined entry in
  `fields`.
- Choose `compact` for discovery, status/reference checks, lists, and routing.
  Choose `full` only when the caller needs narrative or another field excluded
  from the compact allowlist. Omitting `projection` fails input validation.
- `fetch_item` returns `{ item }` for ordinary ledgers. For the `milestones`
  ledger it returns `{ item, resolved, references }`, with `item` projected as
  requested.

Mutations return fixed acknowledgements, never full entities:

- Item acknowledgement: `{ id, milestoneId, status, fields:
  { dependsOn?, blockedBy?, ledgerRefs? }, createdAt, updatedAt, author?,
  session? }`. Milestone-root `create_item` and `update_item` use this same
  acknowledgement.
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
| `fetch_item` | `mandatory-item-projection` | Ordinary ledgers return `{ item }`; the `milestones` ledger returns `{ item, resolved, references }`. `item` uses the requested projection. |
| `update_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `create_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `create_ledger` | `fixed-acknowledgement` | `{ ledger: { id } }`. |
| `search_items` | `mandatory-item-projection` | `{ items }` using the requested projection. |
| `fts_search` | `mandatory-item-projection` | `{ results: [{ ledgerId, item, score, matchedFields }] }`; each item uses the requested projection. |
| `archive_milestone` | `purpose-built-small` | `{ pointer }` for the archived milestone. |
| `list_milestone_items` | `mandatory-item-projection` | `{ items: Record<ledgerId, Item[]> }`; every item uses the requested projection. |
| `snapshot` | `purpose-built-small` | `{ ledger: Record<ledgerId, Record<status, { count, items: [{ id, status, summary }] }>> }`. |
| `derive_predicates` | `purpose-built-small` | Predicate verdicts `{ value, items }` for `pInvestigate`, `pSeed`, `pPlan`, `pResearch`, `pImplement`, `pOperatorAction`, `openQuestionGate`, `belowFloor`, `planBusy`, and `goalDrift`. |
| `materialize_operator_action` | `purpose-built-small` | `{ state: "created"\|"existing", action, handoff }` with deterministic identities. |
| `acknowledge_operator_action` | `purpose-built-small` | `{ state: "acknowledged"\|"verified", action }` or `{ state: "pending", reason: "identity-mismatch", action }`. |
| `record_operator_action_evidence` | `purpose-built-small` | An append-only `{ state: "acknowledged"\|"verified"\|"pending", action, reason? }` evidence acknowledgement. |
| `complete_operator_action` | `purpose-built-small` | `{ task }` only after the linked action is verified. |
| `reopen_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `unarchive_item` | `fixed-acknowledgement` | `{ item: ItemAcknowledgement }`. |
| `read_log` | `requested-full-content` | `{ path, content, truncated? }`. |
| `get_config` | `requested-full-content` | The payload selected by `section`; no unrelated section is returned. |
| `get_usage_stats` | `purpose-built-small` | `{ endpoints: [{ name, callCount, bytesIn, bytesOut }], totals: { callCount, bytesIn, bytesOut } }` |
| `prepare_dispatch` | `purpose-built-small` | `{ accepted, prepared, handle, executedStepOrder }` or a typed pre-launch rejection. |
| `fetch_dispatch_input` | `requested-full-content` | The prepare-bound typed input on its first capability-authorized retrieval. |
| `store_result` | `purpose-built-small` | A handle-only stored-result acknowledgement or typed abort. |
| `confirm_dispatch_completion` | `purpose-built-small` | A handle-only consumed acknowledgement or typed abort. |
| `abort_dispatch` | `purpose-built-small` | A typed aborted acknowledgement. |
| `fetch_dispatch_result` | `requested-full-content` | One typed fetch state; only the first consumed fetch can carry `output`. |
| `fetch_prompt` | `requested-full-content` | Full typed prompt entry under the default `projection: "full"`, including prompt text and schemas when available; `projection: "schema"` returns exactly `{ roleId, version?, inputSchema?, outputSchema? }` — `{ roleId }` alone for an orchestrator-command role (schema keys ABSENT, never null). |
| `list_projects` | `purpose-built-small` | `{ projects: [{ key, displayName, createdAt? }] }`. |
| `claim_plan` | `purpose-built-small` | `{ ok: true, replayed, acknowledgement }` — the ONLY response that echoes `ownerFenceToken`, and only back to the winning or exactly-retried claimant — or `{ ok: false, conflict }` carrying public claim metadata only. |
| `publish_plan_draft` | `purpose-built-small` | `{ ok: true, replayed, acknowledgement: { …operation key, manifest, replacedManifest, reviewDefects } }` or `{ ok: false, conflict }`; never carries `ownerFenceToken`. |
| `release_plan_claim` | `purpose-built-small` | `{ ok: true, replayed, acknowledgement: { kind, …operation key, questions, researches, waitingResearches, tasks, waitingTasks, reviewDefects, goalPhase } }` or `{ ok: false, conflict }`; never carries `ownerFenceToken`. |
| `finalize_plan` | `purpose-built-small` | `{ ok: true, replayed, acknowledgement: { …operation key, reviewId, draft, decisionId, manifest, reviewDefects, goalPhase } }` or `{ ok: false, conflict }`; never carries `ownerFenceToken`. |
| `worktree_manage` | `purpose-built-small` | Prepare: `{ status: "prepared"|"resume-required"|"refused", … }`. Observe conflict: `{ status: "conflict-observed", conflictState }`. Release: `{ status: "released"|"refused", … }`. Typed acknowledgements only; never exposes filesystem mutation primitives individually. |
| `git_commit` | `purpose-built-small` | A replayable `{ kind, version, attestationId, generation, taskId, operationId, requestDigest, oldHead, newHead, tree, objectOids, paths, committedAt }` receipt. |
| `git_resolve_continue` | `purpose-built-small` | A replayable durable conflict-continuation receipt carrying attributed objects and either the terminal rebased tip or the exact next parent-bound conflict state. |
<!-- ledger-response-contract:end -->

Operator-action probe history remains append-only, but verification counts only
the complete successful probe set from the latest exact acknowledgement epoch.
Generic `reopen_item` rejects canonical operator actions and their linked strict-
envelope tasks; callers must use the typed operator-action lifecycle.

### Usage statistics: three access paths

Every MCP tool invocation records per-endpoint usage counters in the project
store (`callCount` + UTF-8 `bytesIn` of the arguments; a successful call adds
`bytesOut` — the sum of the response text-block sizes; a thrown error records
`bytesOut = 0`). The accumulated `{ endpoints, totals }` snapshot is readable
three equivalent ways, all served from the same store rows:

1. the `get_usage_stats` MCP tool (payload above) — its own endpoint row
   appears only from the second call onward, because recording happens after
   the handler returns;
2. the `cq stats` CLI subcommand (see `cq --help`), which prints the same
   `{ endpoints, totals }` JSON to stdout;
3. the typed client method `getUsageStats()` (e.g. `McpLedgerClient` in
   `@cq/ledger-web` and `@cq/ledger-tui`).

Only MCP tool invocations increment the counters; direct CLI reads (including
`cq stats` itself) and direct store writes do not.

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
    "tool": "fetch_item",
    "arguments": {
      "ledger_id": "milestones",
      "item_id": "M1",
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
    "tool": "create_item",
    "arguments": {
      "ledger_id": "milestones",
      "status": "open",
      "fields": {
        "title": "Use the allocated milestone id"
      }
    },
    "consume": "item.id"
  }
]
```
<!-- ledger-response-examples:end -->

## Client development and migration

Treat response decoding as a closed 35-tool matrix, not as a generic
full-entity decoder. Require callers to choose a projection for the five
item-bearing read tools, model the acknowledgement DTOs independently
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
