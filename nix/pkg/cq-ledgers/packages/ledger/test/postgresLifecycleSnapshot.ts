import type { SQL } from "bun";

export async function snapshotPostgresLifecycleRows(pool: SQL, projectKey: string) {
  return {
    items: [...await pool`SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE project_key = ${projectKey} ORDER BY ledger, id`],
    groups: [...await pool`SELECT ledger, id, title, description FROM groups WHERE project_key = ${projectKey} ORDER BY ledger, id`],
    archived: [...await pool`SELECT ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM archived_items WHERE project_key = ${projectKey} ORDER BY ledger, pointer_id, id`],
    pointers: [...await pool`SELECT ledger, id, summary, title, status, archived_at FROM archive_pointers WHERE project_key = ${projectKey} ORDER BY ledger, id`],
    counters: [...await pool`SELECT name, item_counter, milestone_counter FROM ledgers WHERE project_key = ${projectKey} ORDER BY name`],
    references: [...await pool`SELECT source_ledger, source_id, field_name, target_ledger, target_id FROM item_references
      WHERE project_key = ${projectKey} ORDER BY source_ledger, source_id, field_name, target_ledger, target_id`],
    claims: [...await pool`SELECT scope, record_json FROM plan_claims WHERE project_key = ${projectKey} ORDER BY scope`],
    operations: [...await pool`SELECT scope, record_json FROM plan_operations WHERE project_key = ${projectKey} ORDER BY scope`],
    coherenceState: [...await pool`SELECT version FROM coherence_state WHERE project_key = ${projectKey}`],
    coherenceVector: [...await pool`SELECT ledger, document_id, scope, kind, version, origin FROM coherence_vector
      WHERE project_key = ${projectKey} ORDER BY ledger, document_id, scope`],
  };
}
