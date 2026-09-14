import { expect, test } from "bun:test";
import { assertPostgresQueryPlanBounds } from "./postgresLifecycleBoundsAssertions.js";
import type { BoundsQueryPlan } from "./postgresLifecycleBoundsMeasurement.js";

test("PostgreSQL bounds permit equivalent indexes and page overhead, not scans or row growth [T5925 Behavioral-Active Blackbox-Atomic]", () => {
  const small: BoundsQueryPlan = { sql: "SELECT * FROM items WHERE project_key=$1 AND ledger=$2 AND id=$3", lookups: 1, nodes: [
    { node: "Index Scan", index: "items_ledger_status", relation: "items", rows: 1, filteredRows: 0, loops: 1, sharedBlocks: 3, localBlocks: 0 },
  ] };
  const large: BoundsQueryPlan = { ...small, nodes: [{ ...small.nodes[0]!, index: "items_pkey", sharedBlocks: 4 }] };
  expect(() => assertPostgresQueryPlanBounds(small, large)).not.toThrow();
  for (const difference of [{ node: "Seq Scan", index: null }, { rows: 2 }, { filteredRows: 1 }, { loops: 2 }, { sharedBlocks: 1000 }]) {
    expect(() => assertPostgresQueryPlanBounds(small, { ...large, nodes: [{ ...large.nodes[0]!, ...difference }] })).toThrow();
  }
  const twoStatusRanges = { ...small, lookups: 2, nodes: [{ ...small.nodes[0]!, sharedBlocks: 8 }] };
  expect(() => assertPostgresQueryPlanBounds(twoStatusRanges, twoStatusRanges)).not.toThrow();
  expect(() => assertPostgresQueryPlanBounds(small, twoStatusRanges)).toThrow();
});

test("PostgreSQL bitmap candidates have bounded overhead without hiding extra visible rows [T5925 Behavioral-Active Blackbox-Atomic]", () => {
  const small: BoundsQueryPlan = { sql: "SELECT selected rows", lookups: 1, nodes: [
    { node: "Bitmap Heap Scan", index: null, relation: "items", rows: 14, filteredRows: 0, loops: 1, sharedBlocks: 3, localBlocks: 0 },
    { node: "Bitmap Index Scan", index: "items_pkey", relation: null, rows: 14, filteredRows: 0, loops: 1, sharedBlocks: 1, localBlocks: 0 },
  ] };
  expect(() => assertPostgresQueryPlanBounds(small, { ...small, nodes: [small.nodes[0]!, { ...small.nodes[1]!, rows: 15 }] })).not.toThrow();
  expect(() => assertPostgresQueryPlanBounds(small, { ...small, nodes: [small.nodes[0]!, { ...small.nodes[1]!, rows: 1000 }] })).toThrow("candidate work");
  expect(() => assertPostgresQueryPlanBounds(small, { ...small, nodes: [{ ...small.nodes[0]!, rows: 15 }, small.nodes[1]!] })).toThrow("visited rows grew");
});
