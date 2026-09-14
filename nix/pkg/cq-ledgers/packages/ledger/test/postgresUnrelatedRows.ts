import type { SQL } from "bun";
import { strict as assert } from "node:assert";
import { encodePostgresPlanScope } from "../src/store/planLifecycleDump.js";
import { lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";

export async function seedPostgresUnrelatedRows(pool: SQL, projectKey: string, count: number): Promise<void> {
  if (count === 0) return;
  const schemas = await pool<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
  assert(schemas[0] !== undefined && schemas[0].schema.startsWith("cq_keyed_"), "bulk seed requires an isolated keyed test schema");
  await pool.begin(async (tx) => {
    // Bulk fixture setup uses the migration's set-based reference backfill, not one trigger invocation per row.
    await tx.unsafe("ALTER TABLE items DISABLE TRIGGER item_references_items_write");
    await tx`INSERT INTO groups (project_key, ledger, id, title, description)
      VALUES (${projectKey}, 'tasks', 'M900000', 'unrelated', 'unrelated'),
        (${projectKey}, 'goals', 'M-AMBIENT', '', '') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      VALUES (${projectKey}, 'goals', 'G900000', 'M-AMBIENT', 'clarifying', '{"title":"unrelated owner","description":"unrelated"}', 'now', 'now')`;
    await tx`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
      SELECT ${projectKey}, 'tasks', 'T' || (900000 + n)::text, 'M900000', 'planned',
        jsonb_build_object('headline', 'unrelated', 'dependsOn', jsonb_build_array('tasks:T900001'), 'worksetOwnerRef', 'goals:G900000')::text,
        'now', 'now' FROM generate_series(1, ${count}::integer) AS n`;
    await tx`INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
      VALUES (${projectKey}, 'tasks', 'M900001', 'unrelated', 'unrelated', 'done', 'now')`;
    await tx`INSERT INTO archived_items (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
      SELECT ${projectKey}, 'tasks', 'M900001', 'T' || (950000 + n)::text, 'M900001', 'done', '{"headline":"unrelated archived"}', 'now', 'now'
      FROM generate_series(1, ${count}::integer) AS n`;
    await tx.unsafe("ALTER TABLE items ENABLE TRIGGER item_references_items_write");
    await tx.unsafe("ANALYZE items");
    await tx`INSERT INTO item_references (project_key, source_ledger, source_id, field_name, target_ledger, target_id)
      SELECT project_key, ledger, id, field_name, target_ledger, target_id FROM items
      CROSS JOIN LATERAL cq_item_reference_values(fields_json)
      WHERE project_key = ${projectKey} AND ledger = 'tasks' AND milestone_id = 'M900000'`;
  });
  for (const table of ["items", "groups", "archived_items", "item_references", "plan_claims", "plan_operations"]) {
    await pool.unsafe(`VACUUM (ANALYZE) ${table}`);
  }
}

export async function seedPostgresUnrelatedPrivateRows(pool: SQL, projectKey: string, count: number): Promise<void> {
  if (count === 0) return;
  const schemas = await pool<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
  assert(schemas[0] !== undefined && schemas[0].schema.startsWith("cq_keyed_"), "private seed requires an isolated keyed test schema");
  const separator = encodePostgresPlanScope("\u0000");
  const claim = JSON.stringify(lifecycleClaim("G-template"));
  const operation = JSON.stringify(lifecycleOperation("existing"));
  await pool.begin(async (tx) => {
    await tx`INSERT INTO plan_claims (project_key, scope, record_json)
      SELECT ${projectKey}, 'G' || n::text || ${separator} || 'request-G' || n::text,
        (${claim}::text::jsonb || jsonb_build_object('goalId', 'G' || n::text, 'claimId', 'claim_G' || n::text || '_1', 'claimRequestId', 'request-G' || n::text))::text
      FROM generate_series(10000, ${10000 + count - 1}::integer) AS n`;
    await tx`INSERT INTO plan_operations (project_key, scope, record_json)
      SELECT ${projectKey}, 'G' || n::text || ${separator} || 'claim_G' || n::text || '_1' || ${separator} || '1' || ${separator} || 'release' || ${separator} || 'existing',
        (${operation}::text::jsonb || jsonb_build_object('replay', (${operation}::text::jsonb -> 'replay') || jsonb_build_object('goalId', 'G' || n::text, 'claimId', 'claim_G' || n::text || '_1')))::text
      FROM generate_series(10000, ${10000 + count - 1}::integer) AS n`;
  });
}
