/**
 * MCP-backed implementation of {@link LedgerClient}.
 *
 * Wraps an `@modelcontextprotocol/sdk` Client connected over the Streamable
 * HTTP transport to a running `ledger-mcp --http` server. Each method maps to
 * one tool call, unwraps the single text content block, and JSON-decodes it.
 * A tool result flagged `isError` is surfaced as a thrown {@link LedgerToolError}
 * carrying the server's message.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildServer, createEmbeddedStore } from "@cq/ledger-mcp";
import type { FsLedgerStore } from "@cq/ledger";
import type {
  FetchedLedger,
  FieldValue,
  FtsHit,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSummary,
  MilestonePatch,
} from "./types.js";

export class LedgerToolError extends Error {
  constructor(
    public readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "LedgerToolError";
  }
}

interface CallToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** In-process context an embedded client owns and must tear down on close. */
export interface EmbeddedContext {
  readonly store: FsLedgerStore;
  readonly cwd: string;
}

export class McpLedgerClient implements LedgerClient {
  constructor(
    private readonly client: Client,
    private readonly embeddedCtx: EmbeddedContext | null = null,
  ) {}

  /** Connect to a `ledger-mcp --http` server at `url` (e.g. http://127.0.0.1:7777/mcp). */
  static async connect(url: string): Promise<McpLedgerClient> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client(
      { name: "ledger-tui", version: "0.0.1" },
      { capabilities: {} },
    );
    // The SDK's StreamableHTTPClientTransport declares `sessionId?: string`
    // (string | undefined), which trips exactOptionalPropertyTypes against the
    // Transport interface's `sessionId?: string`. The shapes are behaviourally
    // identical; bridge the declaration gap through unknown.
    await client.connect(transport as unknown as Transport);
    return new McpLedgerClient(client);
  }

  /**
   * Run the MCP server IN-PROCESS over an in-memory transport, backed by a
   * file-store rooted at `cwd`. No socket, no subprocess: the same tool surface
   * the `--http` server exposes, wired client↔server through a linked transport
   * pair. The returned client OWNS the store and disposes it on {@link close}.
   * Used when ledger-tui is launched with no `--mcp-url`.
   */
  static async embedded(cwd: string): Promise<McpLedgerClient> {
    const store = await createEmbeddedStore(cwd);
    const server = buildServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "ledger-tui", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    return new McpLedgerClient(client, { store, cwd });
  }

  /** The in-process context when running embedded, else null (HTTP mode). */
  get embedded(): EmbeddedContext | null {
    return this.embeddedCtx;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as CallToolResultLike;
    const first = result.content?.[0];
    const text = first?.type === "text" ? (first.text ?? "") : "";
    if (result.isError === true) {
      throw new LedgerToolError(name, text || "tool reported an error");
    }
    if (first === undefined || first.type !== "text") {
      throw new LedgerToolError(name, "expected a text content block");
    }
    return JSON.parse(text) as T;
  }

  async enumerateLedgers(): Promise<LedgerSummary[]> {
    const r = await this.call<{ ledgers: string[]; counts?: Record<string, number> }>(
      "enumerate_ledgers",
      {},
    );
    // `counts` is optional for forward/backward compatibility with a server
    // build that predates it — fall back to 0 rather than dereferencing undefined.
    const counts = r.counts ?? {};
    return r.ledgers.map((name) => ({ name, itemCount: counts[name] ?? 0 }));
  }

  async fetchLedger(ledgerId: string): Promise<FetchedLedger> {
    return (await this.call<{ ledger: FetchedLedger }>("fetch_ledger", { ledger_id: ledgerId }))
      .ledger;
  }

  async fetchItem(ledgerId: string, itemId: string): Promise<Item> {
    return (await this.call<{ item: Item }>("fetch_item", { ledger_id: ledgerId, item_id: itemId }))
      .item;
  }

  async createItem(ledgerId: string, milestoneId: string, init: ItemInit): Promise<Item> {
    const args: Record<string, unknown> = {
      ledger_id: ledgerId,
      milestone_id: milestoneId,
      status: init.status,
      fields: init.fields,
    };
    if (init.id !== undefined) args["id"] = init.id;
    if (init.author !== undefined) args["author"] = init.author;
    if (init.session !== undefined) args["session"] = init.session;
    return (await this.call<{ item: Item }>("create_item", args)).item;
  }

  async updateItem(ledgerId: string, itemId: string, patch: ItemPatch): Promise<Item> {
    const args: Record<string, unknown> = { ledger_id: ledgerId, item_id: itemId };
    if (patch.status !== undefined) args["status"] = patch.status;
    if (patch.fields !== undefined) args["fields"] = patch.fields;
    if (patch.author !== undefined) args["author"] = patch.author;
    if (patch.session !== undefined) args["session"] = patch.session;
    return (await this.call<{ item: Item }>("update_item", args)).item;
  }

  async ftsSearch(query: string, opts?: { ledger?: string }): Promise<FtsHit[]> {
    const args: Record<string, unknown> = { query };
    if (opts?.ledger !== undefined) args["ledger"] = opts.ledger;
    return (await this.call<{ results: FtsHit[] }>("fts_search", args)).results;
  }

  async createMilestone(init: { title: string; description?: string; id?: string }): Promise<Item> {
    const args: Record<string, unknown> = { title: init.title };
    if (init.description !== undefined) args["description"] = init.description;
    if (init.id !== undefined) args["id"] = init.id;
    return (await this.call<{ milestone: Item }>("create_milestone", args)).milestone;
  }

  async updateMilestone(milestoneId: string, patch: MilestonePatch): Promise<Item> {
    const args: Record<string, unknown> = { milestone_id: milestoneId };
    if (patch.status !== undefined) args["status"] = patch.status;
    if (patch.title !== undefined) args["title"] = patch.title;
    if (patch.description !== undefined) args["description"] = patch.description;
    return (await this.call<{ milestone: Item }>("update_milestone", args)).milestone;
  }

  async close(): Promise<void> {
    await this.client.close();
    // Embedded mode owns the in-process store; dispose it so its watcher /
    // lockfile are released. HTTP mode owns no store here.
    if (this.embeddedCtx !== null) {
      await this.embeddedCtx.store.dispose();
    }
  }
}

// Re-export FieldValue so UI code importing from the client need not reach
// into types.ts for the value union.
export type { FieldValue };
