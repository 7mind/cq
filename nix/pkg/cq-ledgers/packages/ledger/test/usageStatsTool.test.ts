/**
 * T1511: the get_usage_stats tool — behavior, self-counting, and exact
 * role-profile placement (full-parent only).
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryLedgerStore,
  LEDGER_TOOL_NAMES,
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

describe("get_usage_stats (T1511)", () => {
  it("returns non-zero rows including itself after other calls", async () => {
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
    await callTool(tools, "get_usage_stats", {});
    // The try/finally contract records callCount+bytesIn after the handler,
    // so the self row appears from the SECOND call onward.
    const result = await callTool(tools, "get_usage_stats", {});
    const snapshot = JSON.parse(result.content[0].text) as UsageStatsSnapshot;
    const names = snapshot.endpoints.map((e) => e.name);
    expect(names).toContain("fetch_item");
    expect(names).toContain("get_usage_stats");
    const self = snapshot.endpoints.find((e) => e.name === "get_usage_stats");
    expect(self).toBeDefined();
    expect(self!.callCount).toBe(1);
    // fetch_item + the first get_usage_stats; the in-flight second call
    // records after this snapshot is produced.
    expect(snapshot.totals.callCount).toBe(2);
    await store.dispose();
  });

  it("is present in the full-parent inventory and absent from child-role profiles", async () => {
    const { exposedLedgerToolsForRole } = await import("@cq/config");
    const store = new InMemoryLedgerStore({});
    await store.init();
    expect(LEDGER_TOOL_NAMES).toContain("get_usage_stats");
    const fullTools = createLedgerMcpTools(store);
    expect(fullTools.map((t) => t.name)).toContain("get_usage_stats");
    for (const roleId of [
      "plan-advance",
      "plan-reviewer",
      "implement-worker",
      "implement-reviewer",
      "implement-conflict-resolver",
      "investigate-explorer",
      "research-explorer",
    ]) {
      expect(exposedLedgerToolsForRole(roleId)).not.toContain("get_usage_stats");
    }
    await store.dispose();
  });
});
