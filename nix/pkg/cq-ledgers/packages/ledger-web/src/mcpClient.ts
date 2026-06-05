/**
 * Browser MCP client — {@link LedgerClient} over the Streamable HTTP transport.
 *
 * The `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport pair
 * runs unchanged in the browser (fetch + EventSource). Each method maps to one
 * tool call, unwraps the single text content block, and JSON-decodes it; a
 * result flagged `isError` becomes a thrown {@link LedgerToolError}.
 *
 * Cross-origin requests require the server's CORS support (ledger-mcp --http
 * exposes `mcp-session-id` and answers preflight).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ArchiveContent,
  FetchedLedger,
  FtsHit,
  Item,
  ItemInit,
  ItemPatch,
  LedgerClient,
  LedgerSummary,
  MilestonePatch,
  ReadLogResult,
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

export class McpLedgerClient implements LedgerClient {
  private readonly _displayName: string;

  constructor(
    private readonly client: Client,
    displayName?: string,
  ) {
    this._displayName = displayName ?? McpLedgerClient.resolveDisplayName(client);
  }

  /**
   * Read the project display name from the SDK client after a successful
   * `connect()` call. Primary carrier: `serverInfo.title` (via
   * `getServerVersion()`). Fallback: parse the leading `'Project: <name>'`
   * line from `getInstructions()` — the same line T65 writes as a redundant
   * carrier for SDK runtimes that drop `title`. Returns "" if neither carrier
   * is available (e.g. a test stub that omits SDK methods).
   */
  private static resolveDisplayName(client: Client): string {
    try {
      const title = client.getServerVersion()?.title;
      if (title !== undefined && title !== "") return title;
      const instructions = client.getInstructions() ?? "";
      const first = instructions.split("\n")[0] ?? "";
      const m = /^Project:\s+(.+)$/.exec(first.trim());
      if (m !== null && m[1] !== undefined && m[1] !== "") return m[1];
    } catch {
      // stub/test client that doesn't implement SDK query methods
    }
    return "";
  }

  static async connect(url: string): Promise<McpLedgerClient> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client(
      { name: "ledger-web", version: "0.0.1" },
      { capabilities: {} },
    );
    // The SDK's StreamableHTTPClientTransport declares `sessionId?: string`
    // (string | undefined), which trips exactOptionalPropertyTypes against the
    // Transport interface's `sessionId?: string`. Bridge through unknown.
    await client.connect(transport as unknown as Transport);
    return new McpLedgerClient(client);
  }

  displayName(): string {
    return this._displayName;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.client.callTool({ name, arguments: args })) as CallToolResultLike;
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
    const r = await this.call<{
      ledgers: string[];
      counts?: Record<string, number>;
      ledgerSummaries?: Array<{
        name: string;
        itemCount: number;
        statusCounts?: Record<string, number>;
        completedCount?: number;
      }>;
    }>("enumerate_ledgers", {});
    // `counts` and `ledgerSummaries` are optional for forward/backward
    // compatibility with a server build that predates them — fall back
    // gracefully rather than dereferencing undefined.
    const counts = r.counts ?? {};
    const summaryMap = new Map(
      (r.ledgerSummaries ?? []).map((s) => [s.name, s]),
    );
    return r.ledgers.map((name) => {
      const extra = summaryMap.get(name);
      const summary: LedgerSummary = { name, itemCount: counts[name] ?? 0 };
      if (extra?.statusCounts !== undefined) summary.statusCounts = extra.statusCounts;
      if (extra?.completedCount !== undefined) summary.completedCount = extra.completedCount;
      return summary;
    });
  }

  async fetchLedger(ledgerId: string): Promise<FetchedLedger> {
    return (await this.call<{ ledger: FetchedLedger }>("fetch_ledger", { ledger_id: ledgerId }))
      .ledger;
  }

  async fetchLedgerArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    return (
      await this.call<{ archive: ArchiveContent }>("fetch_ledger_archive", {
        ledger_id: ledgerId,
        archive_id: archiveId,
      })
    ).archive;
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
    if (patch.blockedBy !== undefined) args["blockedBy"] = patch.blockedBy;
    if (patch.dependsOn !== undefined) args["dependsOn"] = patch.dependsOn;
    return (await this.call<{ milestone: Item }>("update_milestone", args)).milestone;
  }

  async readLog(path: string): Promise<ReadLogResult> {
    return await this.call<ReadLogResult>("read_log", { path });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
