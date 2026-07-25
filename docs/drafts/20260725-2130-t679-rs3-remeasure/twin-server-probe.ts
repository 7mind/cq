/**
 * T679 — twin-server differential probe.
 *
 * The RS3 corpus contains zero calls for several tools that the uniform
 * cutover changed anyway (`search_items`, `update_milestone`, `create_ledger`,
 * `reopen_item`, `unarchive_item`), so corpus replay cannot say whether their
 * new responses got smaller or larger. This probe answers that by measurement
 * rather than simulation: it boots the REAL stdio ledger MCP server from two
 * workspaces — the RS3-era tree and the cutover tree — drives BOTH with an
 * identical, deterministic operation script, and compares the actual response
 * text each server produced.
 *
 * Both servers run over an in-memory transport against an in-memory store with
 * a pinned clock and pinned ids, so the two runs differ only by server code.
 *
 * Usage:
 *   bun run twin-server-probe.ts --before <rs3 workspace> --after <cutover workspace> [--out <file>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Operation {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** add `projection: <value>` when the server's schema declares the param */
  projection?: "compact" | "full";
}

const NARRATIVE = [
  "Root cause: the exporter wrote the debounced snapshot before the mutex was",
  "released, so a concurrent writer observed a half-applied group. The fix",
  "serialises the export behind the same mutex and re-reads the group after",
  "acquiring it. Verified by a failing test that interleaves two writers.",
].join(" ");

function operations(): Operation[] {
  const bigDescription = `${NARRATIVE} `.repeat(12).trim();
  return [
    {
      label: "create_ledger (typical schema)",
      tool: "create_ledger",
      args: {
        name: "probes",
        schema: {
          statusValues: ["open", "wip", "done"],
          terminalStatuses: ["done"],
          fields: {
            headline: { type: "string", required: true },
            description: { type: "string", required: false },
            dependsOn: { type: "id[]", required: false },
            blockedBy: { type: "id[]", required: false },
          },
          idPrefix: "P",
        },
      },
    },
    {
      label: "create_milestone (small)",
      tool: "create_milestone",
      args: { title: "Probe milestone", description: "Probe milestone body." },
    },
    {
      label: "create_item (minimal: headline only)",
      tool: "create_item",
      args: {
        ledger_id: "probes",
        milestone_id: "M1",
        status: "open",
        fields: { headline: "Small item" },
        author: "probe",
        session: "t679",
      },
    },
    {
      label: "create_item (narrative + refs)",
      tool: "create_item",
      args: {
        ledger_id: "probes",
        milestone_id: "M1",
        status: "open",
        fields: {
          headline: "Narrative item",
          description: bigDescription,
          dependsOn: ["probes:P1"],
        },
        author: "probe",
        session: "t679",
      },
    },
    {
      label: "update_item (status only, small item)",
      tool: "update_item",
      args: { ledger_id: "probes", item_id: "P1", status: "wip", author: "probe" },
    },
    {
      label: "update_item (status only, narrative item)",
      tool: "update_item",
      args: { ledger_id: "probes", item_id: "P2", status: "wip", author: "probe" },
    },
    {
      label: "update_milestone (status only)",
      tool: "update_milestone",
      args: { milestone_id: "M1", status: "open" },
    },
    {
      label: "fetch_item (small item)",
      tool: "fetch_item",
      args: { ledger_id: "probes", item_id: "P1" },
      projection: "compact",
    },
    {
      label: "fetch_item (small item, full control)",
      tool: "fetch_item",
      args: { ledger_id: "probes", item_id: "P1" },
      projection: "full",
    },
    {
      label: "fetch_item (narrative item)",
      tool: "fetch_item",
      args: { ledger_id: "probes", item_id: "P2" },
      projection: "compact",
    },
    {
      label: "fetch_item (narrative item, full control)",
      tool: "fetch_item",
      args: { ledger_id: "probes", item_id: "P2" },
      projection: "full",
    },
    {
      label: "fetch_milestone (small)",
      tool: "fetch_milestone",
      args: { milestone_id: "M1" },
      projection: "compact",
    },
    {
      label: "list_milestone_items",
      tool: "list_milestone_items",
      args: { milestone_id: "M1" },
      projection: "compact",
    },
    {
      label: "search_items",
      tool: "search_items",
      args: { ledger_id: "probes", query: "item" },
      projection: "compact",
    },
    {
      label: "fts_search",
      tool: "fts_search",
      args: { query: "item", ledger: "probes" },
      projection: "compact",
    },
    {
      label: "snapshot (unchanged control)",
      tool: "snapshot",
      args: {},
    },
    {
      label: "enumerate_ledgers (unchanged control)",
      tool: "enumerate_ledgers",
      args: {},
    },
    {
      label: "derive_predicates (unchanged control)",
      tool: "derive_predicates",
      args: {},
    },
    {
      label: "update_item (to terminal, for reopen)",
      tool: "update_item",
      args: { ledger_id: "probes", item_id: "P1", status: "done" },
    },
    {
      label: "reopen_item",
      tool: "reopen_item",
      args: { ledger_id: "probes", item_id: "P1", to_status: "wip" },
    },
    {
      label: "update_item (P1 -> done, for archive)",
      tool: "update_item",
      args: { ledger_id: "probes", item_id: "P1", status: "done" },
    },
    {
      label: "update_item (P2 -> done, for archive)",
      tool: "update_item",
      args: { ledger_id: "probes", item_id: "P2", status: "done" },
    },
    {
      label: "update_milestone (M1 -> done, for archive)",
      tool: "update_milestone",
      args: { milestone_id: "M1", status: "done" },
    },
    {
      label: "archive_milestone (unchanged control)",
      tool: "archive_milestone",
      args: { milestone_id: "M1", summary: "probe archive" },
    },
    {
      label: "unarchive_item",
      tool: "unarchive_item",
      args: { ledger_id: "probes", milestone_id: "M1", item_id: "P2" },
    },
  ];
}

interface OperationResult {
  label: string;
  tool: string;
  ok: boolean;
  text: string;
  bytes: number;
  tokens: number;
  argsBytes: number;
  argsTokens: number;
}

async function runWorkspace(
  workspaceInput: string,
  ops: Operation[],
): Promise<{ workspace: string; results: OperationResult[]; toolsWithProjection: string[] }> {
  const workspace = resolve(workspaceInput);
  const { McpServer } = await import(
    Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", `${workspace}/packages/ledger`)
  );
  const { Client } = await import(
    Bun.resolveSync("@modelcontextprotocol/sdk/client/index.js", `${workspace}/packages/ledger`)
  );
  const { InMemoryTransport } = await import(
    Bun.resolveSync("@modelcontextprotocol/sdk/inMemory.js", `${workspace}/packages/ledger`)
  );
  const { registerLedgerStdioTools } = await import(
    `${workspace}/packages/ledger/src/mcp/stdioLedgerTools.ts`
  );
  const { InMemoryLedgerStore } = await import(
    `${workspace}/packages/ledger/src/store/InMemoryLedgerStore.ts`
  );

  let tick = 0;
  const store = new InMemoryLedgerStore({
    now: () => new Date(Date.UTC(2026, 6, 25, 0, 0, tick++)).toISOString(),
  });
  await store.init();
  const server = new McpServer(
    { name: "t679-twin-probe", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerLedgerStdioTools(server, store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "t679-twin-probe-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  const listed = (await client.listTools()) as {
    tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
  };
  const projectionCapable = new Set(
    listed.tools
      .filter((t) => t.inputSchema.properties?.["projection"] !== undefined)
      .map((t) => t.name),
  );

  const results: OperationResult[] = [];
  for (const op of ops) {
    const args: Record<string, unknown> = { ...op.args };
    if (op.projection !== undefined && projectionCapable.has(op.tool)) {
      args["projection"] = op.projection;
    }
    let text = "";
    let ok = true;
    try {
      const call = (await client.callTool({ name: op.tool, arguments: args })) as Any;
      text = (call.content ?? [])
        .map((piece: Any) => (piece?.type === "text" ? piece.text : ""))
        .join("");
      ok = call.isError !== true;
    } catch (error) {
      ok = false;
      text = `THROWN: ${(error as Error).message}`;
    }
    const argsText = JSON.stringify(args);
    results.push({
      label: op.label,
      tool: op.tool,
      ok,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      tokens: encode(text).length,
      argsBytes: Buffer.byteLength(argsText, "utf8"),
      argsTokens: encode(argsText).length,
    });
  }

  await client.close();
  await server.close();
  return { workspace, results, toolsWithProjection: [...projectionCapable].sort() };
}

function arg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  const value = process.argv[idx + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  return value;
}

const ops = operations();
const before = await runWorkspace(arg("before"), ops);
const after = await runWorkspace(arg("after"), ops);

const rows = ops.map((op, index) => {
  const b = before.results[index]!;
  const a = after.results[index]!;
  return {
    label: op.label,
    tool: op.tool,
    beforeOk: b.ok,
    afterOk: a.ok,
    beforeBytes: b.bytes,
    afterBytes: a.bytes,
    beforeTokens: b.tokens,
    afterTokens: a.tokens,
    deltaTokens: a.tokens - b.tokens,
    deltaPercent:
      b.tokens === 0 ? 0 : Number((((a.tokens - b.tokens) / b.tokens) * 100).toFixed(2)),
    argsTokensBefore: b.argsTokens,
    argsTokensAfter: a.argsTokens,
    argsDeltaTokens: a.argsTokens - b.argsTokens,
    netDeltaTokens: a.tokens - b.tokens + (a.argsTokens - b.argsTokens),
    beforeText: b.text.length > 400 ? `${b.text.slice(0, 400)}…` : b.text,
    afterText: a.text.length > 400 ? `${a.text.slice(0, 400)}…` : a.text,
  };
});

const report = {
  probe: "T679 twin-server differential (RS3-era server vs cutover server, identical operations)",
  generatedAt: new Date().toISOString(),
  tokenizer: "gpt-tokenizer@3.4.0 / o200k_base",
  beforeWorkspace: before.workspace,
  afterWorkspace: after.workspace,
  beforeProjectionTools: before.toolsWithProjection,
  afterProjectionTools: after.toolsWithProjection,
  rows,
  totals: {
    beforeTokens: rows.reduce((a, r) => a + r.beforeTokens, 0),
    afterTokens: rows.reduce((a, r) => a + r.afterTokens, 0),
    argsDeltaTokens: rows.reduce((a, r) => a + r.argsDeltaTokens, 0),
    responseRegressions: rows.filter((r) => r.deltaTokens > 0).map((r) => r.label),
    netRegressions: rows.filter((r) => r.netDeltaTokens > 0).map((r) => r.label),
    failedOperations: rows.filter((r) => !r.beforeOk || !r.afterOk).map((r) => r.label),
  },
};

const out = resolve(arg("out", join(import.meta.dir, "out/twin-server-probe.json")));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${out}`);
for (const row of rows) {
  console.log(
    [
      row.label.padEnd(42),
      `before=${String(row.beforeTokens).padStart(5)}`,
      `after=${String(row.afterTokens).padStart(5)}`,
      `Δresp=${String(row.deltaTokens).padStart(6)}`,
      `Δargs=${String(row.argsDeltaTokens).padStart(3)}`,
      `Δnet=${String(row.netDeltaTokens).padStart(6)}`,
      row.beforeOk && row.afterOk ? "" : `ok(before=${row.beforeOk},after=${row.afterOk})`,
    ].join(" "),
  );
}
console.log(JSON.stringify(report.totals, null, 2));
