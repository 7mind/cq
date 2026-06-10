# @cq/ledger-mcp

Standalone MCP server exposing the 26 ledger tools backed by a file-system
(`FsLedgerStore`) or git-object store.  Speaks stdio (default) and Streamable
HTTP (`--http`).

## Quick start — standalone binary

```sh
# stdio; ledger root = $LEDGER_ROOT or CWD
ledger-mcp

# explicit root
ledger-mcp --cwd /path/to/project

# Streamable HTTP on 127.0.0.1:7777
ledger-mcp --cwd /path/to/project --http 7777

# Prefix all 26 tool names with "myproj_"
ledger-mcp --cwd /path/to/project --tool-prefix myproj
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
//                tools don't clash with another ledger-mcp instance in the
//                same session.  Omit (or pass "") for the default unprefixed
//                26-tool surface.
const server = createLedgerMcpServer({
  store,
  displayName: "my-project",
  toolPrefix: "myproj", // tools become myproj_enumerate_ledgers, myproj_create_item, …
});

// Connect a transport and serve.
const transport = new StdioServerTransport();
await server.connect(transport);
```

That is the complete setup: `createLedgerMcpServer` registers all 26 ledger
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
ledger-mcp --cwd /path/to/your/project --tool-prefix myproj
```

The `--tool-prefix` flag applies the same prefix as the programmatic
`toolPrefix` option and is validated identically (`^[a-zA-Z0-9]+$`).

## Exported API

| Export | Description |
|---|---|
| `createLedgerMcpServer(opts)` | Main builder — returns a configured `McpServer` |
| `CreateLedgerMcpServerOptions` | Options interface for `createLedgerMcpServer` |
| `buildServer(store, displayName)` | Thin unprefixed wrapper (backwards-compatible) |
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
