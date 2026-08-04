/**
 * T1510: usage recording at pre-prefix specification build — one wrap for
 * both transports, throw-safe call accounting, best-effort recorder failures,
 * and canonical unprefixed endpoint identity on prefixed surfaces.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  createLedgerMcpTools,
  type UsageStatsSnapshot,
} from "../src/index.js";

type Tools = ReturnType<typeof createLedgerMcpTools>;

function callTool(
  tools: Tools,
  name: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const t = tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t.handler(args as never, null) as Promise<any>;
}

class FailingUsageStore extends InMemoryLedgerStore {
  override async recordMcpUsage(): Promise<void> {
    throw new Error("telemetry backend on fire");
  }
}

function endpoint(snapshot: UsageStatsSnapshot, name: string) {
  return snapshot.endpoints.find((e) => e.name === name);
}

describe("MCP usage recording at specification build (T1510)", () => {
  it("a successful call increments callCount, bytesIn, and bytesOut under the canonical name", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    await store.createItem("tasks", "M-AMBIENT", {
      status: "planned",
      fields: { headline: "instrumented" },
    });
    const tools = createLedgerMcpTools(store);
    await callTool(tools, "fetch_item", {
      ledger_id: "tasks",
      item_id: "T1",
      projection: "compact",
    });
    const snapshot = await store.fetchMcpUsageStats();
    const usage = endpoint(snapshot, "fetch_item");
    expect(usage).toBeDefined();
    expect(usage!.callCount).toBe(1);
    expect(usage!.bytesIn).toBeGreaterThan(0);
    expect(usage!.bytesOut).toBeGreaterThan(0);
    expect(snapshot.totals.callCount).toBe(1);
    await store.dispose();
  });

  it("a throwing handler still increments callCount and bytesIn with bytesOut=0, and the original error surfaces", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    const tools = createLedgerMcpTools(store);
    await expect(
      callTool(tools, "fetch_item", {
        ledger_id: "tasks",
        item_id: "T404",
        projection: "compact",
      }),
    ).rejects.toThrow(/T404/);
    const snapshot = await store.fetchMcpUsageStats();
    const usage = endpoint(snapshot, "fetch_item");
    expect(usage).toBeDefined();
    expect(usage!.callCount).toBe(1);
    expect(usage!.bytesIn).toBeGreaterThan(0);
    expect(usage!.bytesOut).toBe(0);
    await store.dispose();
  });

  it("a forced recordMcpUsage failure changes neither the success nor the error outcome", async () => {
    const store = new FailingUsageStore({});
    await store.init();
    await store.createItem("tasks", "M-AMBIENT", {
      status: "planned",
      fields: { headline: "instrumented" },
    });
    const tools = createLedgerMcpTools(store);
    const ok = await callTool(tools, "fetch_item", {
      ledger_id: "tasks",
      item_id: "T1",
      projection: "compact",
    });
    expect(ok.content[0].text).toContain("T1");
    await expect(
      callTool(tools, "fetch_item", {
        ledger_id: "tasks",
        item_id: "T404",
        projection: "compact",
      }),
    ).rejects.toThrow(/T404/);
    await store.dispose();
  });

  it("a prefixed tool surface aggregates under the canonical unprefixed name with no strip logic", async () => {
    const store = new InMemoryLedgerStore({});
    await store.init();
    await store.createItem("tasks", "M-AMBIENT", {
      status: "planned",
      fields: { headline: "instrumented" },
    });
    const tools = createLedgerMcpTools(store, undefined, undefined, undefined, "zz");
    await callTool(tools, "zz_fetch_item", {
      ledger_id: "tasks",
      item_id: "T1",
      projection: "compact",
    });
    const snapshot = await store.fetchMcpUsageStats();
    expect(endpoint(snapshot, "fetch_item")).toBeDefined();
    expect(endpoint(snapshot, "fetch_item")!.callCount).toBe(1);
    expect(endpoint(snapshot, "zz_fetch_item")).toBeUndefined();
    await store.dispose();
  });
});
