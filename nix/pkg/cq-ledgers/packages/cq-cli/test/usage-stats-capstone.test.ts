/**
 * T1516 (I20/G155) — CAPSTONE end-to-end verification of the MCP usage-stats
 * surface over a REAL xdg/sqlite project: one live MCP server (serveHttp →
 * attachMcpHttp → buildServer → createLedgerMcpServer) backed by a temp xdg
 * store, three tool calls with helper-measured argument sizes — including one
 * `fetch_item` that throws a LedgerError (bytesOut=0) — then the THREE access
 * paths asserted to AGREE on callCount and byte totals:
 *
 *   1. the `get_usage_stats` MCP payload, read through the T1513 web client
 *      (`McpLedgerClient.connect` from @cq/ledger-web) over real Streamable
 *      HTTP;
 *   2. `cq stats` stdout (runStats over a SECOND in-process store connection
 *      to the same xdg sqlite project — WAL makes the server's committed
 *      counters visible);
 *   3. the store-level `fetchMcpUsageStats` — the same read the tool handler
 *      performs (the task-sanctioned fallback for the typed-client path,
 *      since the MCP SDK is not a direct cq-cli dependency).
 *
 * Byte expectations are computed with the SAME helpers the recorder uses
 * (measureUtf8JsonBytes of the exact args object the client sends;
 * measureUtf8TextBytes of the response text). The response text is exactly
 * `JSON.stringify(wirePayload)` (serializeWireDto), so the expected bytesOut
 * of a call is the UTF-8 size of the re-serialized payload the client
 * received — JSON parse/stringify round-trips byte-identically here. The
 * get_usage_stats SELF-row is recorded after the handler returns, so the
 * first stats read carries no self-row and the two later reads observe
 * callCount 1.
 *
 * Store fixture mirrors stats.test.ts (T1512): cq.toml pins backend='xdg'
 * with an explicit projectId; XDG_STATE_HOME points at a temp dir.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createLedgerStore,
  measureUtf8JsonBytes,
  measureUtf8TextBytes,
  type EndpointUsage,
  type UsageStatsSnapshot,
} from "@cq/ledger";
import { serveHttp, MCP_HTTP_PATH } from "@cq/ledger-mcp";
// The web client's typed getUsageStats (T1513) — imported from the
// @cq/ledger-web source, mirroring raw-log-lifecycle-capstone.test.ts.
import { McpLedgerClient, LedgerToolError } from "../../ledger-web/src/mcpClient.js";
import { runStats, type StatsIo } from "../src/stats.js";

const dirs: string[] = [];
let prevXdgStateHome: string | undefined;
beforeAll(async () => {
  // The runtime store is the out-of-tree xdg primary (T505): point
  // XDG_STATE_HOME at a temp dir so seeded state never touches the host.
  prevXdgStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = await makeTmpDir("cq-usage-capstone-xdg-");
});
afterAll(async () => {
  if (prevXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevXdgStateHome;
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function endpoint(snapshot: UsageStatsSnapshot, name: string): EndpointUsage | undefined {
  return snapshot.endpoints.find((e) => e.name === name);
}

/** The totals row must be the exact sum of the endpoint rows. */
function expectTotalsConsistent(snapshot: UsageStatsSnapshot): void {
  const totals = snapshot.endpoints.reduce(
    (acc, e) => ({
      name: "totals",
      callCount: acc.callCount + e.callCount,
      bytesIn: acc.bytesIn + e.bytesIn,
      bytesOut: acc.bytesOut + e.bytesOut,
    }),
    { name: "totals", callCount: 0, bytesIn: 0, bytesOut: 0 },
  );
  expect(snapshot.totals).toEqual(totals);
}

/** A capturing StatsIo recording every stdout line (mirrors stats.test.ts). */
function recordingIo(): StatsIo & { outs: string[] } {
  const outs: string[] = [];
  return { outs, out: (l) => outs.push(l), err: () => {} };
}

describe("usage-stats capstone (T1516 / I20/G155)", () => {
  it("MCP payload, cq stats stdout, and the store read agree over a live xdg/sqlite server", async () => {
    const root = await makeTmpDir("cq-usage-capstone-");
    await writeFile(
      path.join(root, "cq.toml"),
      `[ledger]\nbackend = "xdg"\nprojectId = "${path.basename(root)}"\n`,
      "utf8",
    );
    const resolved = await createLedgerStore(root);
    const store = resolved.store;
    // Seed one item directly through the store; direct store writes do NOT
    // record usage, so every counter below comes from an MCP tool invocation.
    await store.createItem("tasks", "M-AMBIENT", {
      status: "planned",
      fields: { headline: "capstone seed" },
    });
    const server = serveHttp(
      store,
      { host: "127.0.0.1", port: 0 },
      path.basename(root),
      "",
      resolved.configRoot,
    );
    const client = await McpLedgerClient.connect(
      `http://127.0.0.1:${server.port}${MCP_HTTP_PATH}`,
    );
    try {
      // 1. The throwing call FIRST: fetch_item on a nonexistent item throws a
      // LedgerError server-side (surfacing client-side as LedgerToolError) →
      // callCount/bytesIn recorded, bytesOut = 0.
      const missingArgs = { ledger_id: "tasks", item_id: "T404", projection: "compact" };
      await expect(client.fetchItem("tasks", "T404", "compact")).rejects.toThrow(LedgerToolError);
      expect(endpoint(await store.fetchMcpUsageStats(), "fetch_item")).toEqual({
        name: "fetch_item",
        callCount: 1,
        bytesIn: measureUtf8JsonBytes(missingArgs),
        bytesOut: 0,
      });

      // 2. Two successful calls with helper-measured argument/response sizes.
      const itemArgs = { ledger_id: "tasks", item_id: "T1", projection: "compact" };
      const item = await client.fetchItem("tasks", "T1", "compact");
      expect(item.id).toBe("T1");
      const ledgerArgs = { ledger_id: "tasks", projection: "compact" };
      const ledger = await client.fetchLedger("tasks", "compact");

      // Endpoints sort by name: fetch_item < fetch_ledger. The response text
      // is exactly JSON.stringify(wirePayload) (serializeWireDto), so the
      // re-serialized client payload reproduces the recorded bytesOut.
      const expectedEndpoints: EndpointUsage[] = [
        {
          name: "fetch_item",
          callCount: 2,
          bytesIn: measureUtf8JsonBytes(missingArgs) + measureUtf8JsonBytes(itemArgs),
          bytesOut: measureUtf8TextBytes(JSON.stringify({ item })),
        },
        {
          name: "fetch_ledger",
          callCount: 1,
          bytesIn: measureUtf8JsonBytes(ledgerArgs),
          bytesOut: measureUtf8TextBytes(JSON.stringify({ ledger })),
        },
      ];

      // Path 1: the get_usage_stats MCP payload via the web client. Its own
      // row is recorded AFTER the handler returns, so this first read carries
      // NO self-row.
      const mcpPayload = await client.getUsageStats();
      expect(mcpPayload.endpoints).toEqual(expectedEndpoints);
      expectTotalsConsistent(mcpPayload);

      // Path 2: `cq stats` stdout — a second in-process store over the SAME
      // xdg sqlite project, reading the counters the server's store committed.
      const io = recordingIo();
      const outcome = await runStats({ cwd: root }, io);
      expect(outcome.exitCode).toBe(0);
      expect(io.outs).toHaveLength(1);
      const cliPayload = JSON.parse(io.outs[0]!) as UsageStatsSnapshot;

      // Path 3: the store-level read the tool handler performs.
      const storePayload = await store.fetchMcpUsageStats();

      // Both later reads observe the self-row the first get_usage_stats call
      // recorded: one call, bytesIn = UTF-8 JSON size of the {} arguments,
      // bytesOut = the first stats payload's own response text size.
      const selfRow: EndpointUsage = {
        name: "get_usage_stats",
        callCount: 1,
        bytesIn: measureUtf8JsonBytes({}),
        bytesOut: measureUtf8TextBytes(JSON.stringify(mcpPayload)),
      };
      expect(cliPayload.endpoints).toEqual([...expectedEndpoints, selfRow]);
      expectTotalsConsistent(cliPayload);

      // The three access paths AGREE: the store read is byte-identical to the
      // CLI stdout payload, and both carry the path-1 rows plus the self-row.
      expect(storePayload).toEqual(cliPayload);
      expectTotalsConsistent(storePayload);
    } finally {
      await client.close();
      server.stop(true);
      await store.dispose();
    }
  });
});
