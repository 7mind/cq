import type { SQL } from "bun";
import { postgresQueryParameters, type PostgresStatement } from "../src/store/postgres/operationAccess.js";

export interface ExplainNode {
  readonly "Node Type": string;
  readonly "Index Name"?: string;
  readonly "Relation Name"?: string;
  readonly "Actual Rows": number;
  readonly "Actual Loops": number;
  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly "Shared Hit Blocks": number;
  readonly "Shared Read Blocks": number;
  readonly "Local Hit Blocks": number;
  readonly "Local Read Blocks": number;
  readonly Plans?: readonly ExplainNode[];
}

export async function observePostgresQueryPlan(pool: SQL, statement: PostgresStatement) {
  const result = await pool.unsafe<Array<{ "QUERY PLAN": readonly { Plan: ExplainNode }[] }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, postgresQueryParameters(pool, statement.parameters),
  );
  return postgresQueryPlanNodes(result[0]!["QUERY PLAN"][0]!.Plan);
}

export function postgresQueryPlanNodes(root: ExplainNode) {
  const nodes: { node: string; index: string | null; relation: string | null; rows: number; filteredRows: number;
    loops: number; sharedBlocks: number; localBlocks: number }[] = [];
  const visit = (node: ExplainNode) => {
    nodes.push({ node: node["Node Type"], index: node["Index Name"] ?? null, relation: node["Relation Name"] ?? null,
      rows: node["Actual Rows"], filteredRows: (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0),
      loops: node["Actual Loops"], sharedBlocks: node["Shared Hit Blocks"] + node["Shared Read Blocks"],
      localBlocks: node["Local Hit Blocks"] + node["Local Read Blocks"] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return nodes;
}
