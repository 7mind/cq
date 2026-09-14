import type { SQL } from "bun";
import { PostgresOperationQueries, type PostgresAccessRecord } from "../src/store/postgres/operationAccess.js";
import { createPostgresLifecycleRowRepository, persistPostgresPrivateRecords } from "../src/store/postgres/lifecycleRowRepository.js";
import { postgresKeyedFixture } from "./postgresKeyedFixture.js";
import { LIFECYCLE_ARCHIVED_ITEM, LIFECYCLE_LEDGER_METADATA, LIFECYCLE_PUBLIC_ITEMS, lifecycleClaim, lifecycleOperation } from "./lifecycleRowRepositoryContract.js";

export async function postgresLifecycleRowFixture() {
  const fixture = await postgresKeyedFixture();
  const { pool } = fixture;
  const projectKey = "selected";
  const accesses: PostgresAccessRecord[] = [];
  const queries = (sql: SQL) => new PostgresOperationQueries(sql, projectKey, "repository-contract",
    { record: (record) => accesses.push(record) }, () => performance.now(), null);
  try {
    await pool.begin(async (tx) => {
      await tx`INSERT INTO projects (project_key, display_name) VALUES (${projectKey}, ${projectKey})`;
      for (const metadata of LIFECYCLE_LEDGER_METADATA) await tx`INSERT INTO ledgers VALUES
        (${projectKey}, ${metadata.id}, ${JSON.stringify(metadata.schema)}, ${metadata.counters.milestone}, ${metadata.counters.item})`;
      for (const { ledgerId, item } of LIFECYCLE_PUBLIC_ITEMS) {
        await tx`INSERT INTO groups (project_key, ledger, id, title, description)
          VALUES (${projectKey}, ${ledgerId}, ${item.milestoneId}, 'members', 'selected') ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at)
          VALUES (${projectKey}, ${ledgerId}, ${item.id}, ${item.milestoneId}, ${item.status}, ${JSON.stringify(item.fields)}, ${item.createdAt}, ${item.updatedAt})`;
      }
      const item = LIFECYCLE_ARCHIVED_ITEM;
      await tx`INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
        VALUES (${projectKey}, 'tasks', 'M2', 'archive', 'archive', 'done', 'now')`;
      await tx`INSERT INTO archived_items (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at)
        VALUES (${projectKey}, 'tasks', 'M2', ${item.id}, ${item.milestoneId}, ${item.status}, ${JSON.stringify(item.fields)}, ${item.createdAt}, ${item.updatedAt})`;
      await persistPostgresPrivateRecords(queries(tx), { claims: [lifecycleClaim("G1"), lifecycleClaim("G2")], operations: [lifecycleOperation("existing")] });
      await tx`INSERT INTO projects (project_key, display_name) VALUES ('unrelated-tenant', 'unrelated-tenant')`;
      await tx`INSERT INTO plan_claims (project_key, scope, record_json)
        SELECT 'unrelated-tenant', scope, record_json FROM plan_claims WHERE project_key = ${projectKey}`;
    });
    accesses.length = 0;
    return { ...fixture, projectKey, accesses, queries, rows: createPostgresLifecycleRowRepository(queries(pool)) };
  } catch (error) { await fixture.dispose(); throw error; }
}
