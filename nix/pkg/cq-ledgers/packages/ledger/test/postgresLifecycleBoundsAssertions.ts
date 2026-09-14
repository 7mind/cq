import { strict as assert } from "node:assert";
import type { PostgresLifecycleBoundsFixture, BoundsQueryPlan } from "./postgresLifecycleBoundsMeasurement.js";

export type PostgresLifecycleBoundsReport = Pick<PostgresLifecycleBoundsFixture, "observations" | "diagnostics">;
const INDEXED_DOMAIN_TABLES = new Set(["items", "groups", "archived_items", "archive_pointers", "item_references", "plan_claims", "plan_operations"]);
const INDEX_PATH_BLOCK_LIMIT = 4;
const HEAP_BLOCKS_PER_VISITED_ROW = 2;
const BITMAP_CANDIDATES_PER_VISIBLE_ROW = 2;

function assertIndexedClosure(plan: BoundsQueryPlan): void {
  let heap: BoundsQueryPlan["nodes"][number] | null = null;
  for (const node of plan.nodes) {
    if (node.node === "Bitmap Heap Scan") heap = node;
    if (node.node === "Bitmap Index Scan") {
      assert(heap !== null && node.index !== null, `bitmap index has no heap/index identity: ${plan.sql}`);
      const visibleRows = Math.max(1, heap.rows + heap.filteredRows);
      assert(node.rows * node.loops <= BITMAP_CANDIDATES_PER_VISIBLE_ROW * visibleRows * Math.max(1, heap.loops),
        `bitmap candidate work exceeds its visible closure: ${plan.sql}`);
      assert(node.sharedBlocks + node.localBlocks <= INDEX_PATH_BLOCK_LIMIT * plan.lookups + HEAP_BLOCKS_PER_VISITED_ROW * visibleRows,
        `bitmap index exceeds its closure block bound: ${plan.sql}`);
    }
    if (node.relation === null || !INDEXED_DOMAIN_TABLES.has(node.relation)) continue;
    assert.notEqual(node.node, "Seq Scan", `unbounded ${node.relation} scan: ${plan.sql}`);
    assert(["Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(node.node), `unsupported closure access ${node.node}: ${plan.sql}`);
    const maximumBlocks = Math.max(1, node.loops) * (INDEX_PATH_BLOCK_LIMIT * plan.lookups + HEAP_BLOCKS_PER_VISITED_ROW * (node.rows + node.filteredRows));
    assert(node.sharedBlocks + node.localBlocks <= maximumBlocks,
      `${node.relation} exceeds its indexed closure block bound ${maximumBlocks}: ${JSON.stringify(node)}; ${plan.sql}`);
  }
}

export function assertPostgresQueryPlanBounds(small: BoundsQueryPlan, large: BoundsQueryPlan): void {
  assert.equal(large.sql, small.sql);
  assert(Number.isSafeInteger(small.lookups) && small.lookups > 0);
  assert.equal(large.lookups, small.lookups);
  assertIndexedClosure(small); assertIndexedClosure(large);
  // Compare visible relation work across equivalent index/bitmap plans; bitmap candidates are bounded separately.
  const relationWork = (value: BoundsQueryPlan) => {
    const result = new Map<string, { rows: number; filteredRows: number }>();
    for (const node of value.nodes) {
      if (node.relation === null) continue;
      const current = result.get(node.relation) ?? { rows: 0, filteredRows: 0 };
      result.set(node.relation, { rows: current.rows + node.rows * node.loops, filteredRows: current.filteredRows + node.filteredRows * node.loops });
    }
    return result;
  };
  const baseline = relationWork(small);
  const expanded = relationWork(large);
  assert.deepEqual([...expanded.keys()].sort(), [...baseline.keys()].sort(), `query relation set changed: ${small.sql}`);
  for (const [relation, work] of expanded) {
    const before = baseline.get(relation)!;
    assert(work.rows <= before.rows && work.filteredRows <= before.filteredRows, `query visited rows grew for ${relation}: ${small.sql}`);
  }
}

export function assertPostgresLifecycleBounds(small: PostgresLifecycleBoundsReport, large: PostgresLifecycleBoundsReport): void {
  assert(small.observations.length > 0, "bounds scenario executed no operations");
  assert.deepEqual(large.observations, small.observations, "public result, key/lock/write or coherence/projection work grew with unrelated rows");
  assert.equal(small.diagnostics.length, small.observations.length);
  assert.equal(large.diagnostics.length, large.observations.length);
  for (const [operation, diagnostic] of small.diagnostics.entries()) {
    const expanded = large.diagnostics[operation]!;
    assert(diagnostic.plans.length > 0, `${diagnostic.name} measured no closure SELECT`);
    assert.equal(expanded.plans.length, diagnostic.plans.length);
    for (const [index, plan] of diagnostic.plans.entries()) {
      const expandedPlan = expanded.plans[index]!;
      assertPostgresQueryPlanBounds(plan, expandedPlan);
    }
  }
}
