import type { SQL } from "bun";

export async function migrateKeyedMutationSchema(tx: SQL): Promise<void> {
  await tx.unsafe(`
    CREATE INDEX items_ledger_status ON items (project_key, ledger, status, id);
    CREATE INDEX items_milestone ON items (project_key, milestone_id, ledger, id);
    CREATE INDEX archived_items_target ON archived_items (project_key, ledger, id, pointer_id);
    CREATE INDEX archived_items_milestone ON archived_items (project_key, milestone_id, ledger, id);
    CREATE INDEX archived_items_ledger_status ON archived_items (project_key, ledger, status, id);

    CREATE TABLE item_references (
      project_key TEXT NOT NULL,
      source_ledger TEXT NOT NULL,
      source_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      target_ledger TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (project_key, source_ledger, source_id, field_name, target_ledger, target_id),
      FOREIGN KEY (project_key, source_ledger, source_id)
        REFERENCES items (project_key, ledger, id) ON DELETE CASCADE
    );
    CREATE INDEX item_references_target
      ON item_references (project_key, target_ledger, target_id, field_name, source_ledger, source_id);

    CREATE FUNCTION cq_item_reference_values(payload TEXT)
    RETURNS TABLE (field_name TEXT, target_ledger TEXT, target_id TEXT)
    LANGUAGE SQL IMMUTABLE AS $references$
      SELECT field_name, left(target, strpos(target, ':') - 1), substr(target, strpos(target, ':') + 1)
      FROM (
        SELECT field.key AS field_name, element.value #>> '{}' AS target
        FROM jsonb_each(payload::jsonb) AS field
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(field.value) = 'array' THEN field.value ELSE '[]'::jsonb END
        ) AS element(value)
        WHERE field.key IN ('dependsOn', 'blockedBy', 'ledgerRefs', 'sourceRefs')
          AND jsonb_typeof(element.value) = 'string'
        UNION ALL
        SELECT 'worksetOwnerRef', payload::jsonb ->> 'worksetOwnerRef'
        WHERE jsonb_typeof(payload::jsonb -> 'worksetOwnerRef') = 'string'
      ) AS targets
      WHERE strpos(target, ':') > 1
    $references$;

    CREATE FUNCTION cq_update_item_references() RETURNS TRIGGER
    LANGUAGE plpgsql AS $trigger$
    BEGIN
      DELETE FROM item_references AS edge
      WHERE edge.project_key = NEW.project_key AND edge.source_ledger = NEW.ledger AND edge.source_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM cq_item_reference_values(NEW.fields_json) AS ref
          WHERE ref.field_name = edge.field_name AND ref.target_ledger = edge.target_ledger AND ref.target_id = edge.target_id
        );
      INSERT INTO item_references (project_key, source_ledger, source_id, field_name, target_ledger, target_id)
        SELECT NEW.project_key, NEW.ledger, NEW.id, field_name, target_ledger, target_id
        FROM cq_item_reference_values(NEW.fields_json)
        ON CONFLICT DO NOTHING;
      RETURN NEW;
    END
    $trigger$;
    CREATE TRIGGER item_references_items_write AFTER INSERT OR UPDATE OF fields_json ON items
      FOR EACH ROW EXECUTE FUNCTION cq_update_item_references();

    INSERT INTO item_references (project_key, source_ledger, source_id, field_name, target_ledger, target_id)
      SELECT project_key, ledger, id, field_name, target_ledger, target_id
      FROM items CROSS JOIN LATERAL cq_item_reference_values(fields_json)
      ON CONFLICT DO NOTHING;

    ALTER TABLE plan_claims
      ADD COLUMN goal_id TEXT GENERATED ALWAYS AS (record_json::jsonb ->> 'goalId') STORED NOT NULL,
      ADD COLUMN claim_request_id TEXT GENERATED ALWAYS AS (record_json::jsonb ->> 'claimRequestId') STORED NOT NULL,
      ADD COLUMN claim_id TEXT GENERATED ALWAYS AS (record_json::jsonb ->> 'claimId') STORED NOT NULL,
      ADD COLUMN generation INTEGER GENERATED ALWAYS AS ((record_json::jsonb ->> 'generation')::integer) STORED NOT NULL,
      ADD COLUMN state TEXT GENERATED ALWAYS AS (record_json::jsonb ->> 'state') STORED NOT NULL;
    CREATE UNIQUE INDEX plan_claims_request ON plan_claims (project_key, goal_id, claim_request_id);
    CREATE UNIQUE INDEX plan_claims_identity ON plan_claims (project_key, goal_id, claim_id, generation);
    CREATE UNIQUE INDEX plan_claims_active_goal ON plan_claims (project_key, goal_id) WHERE state = 'active';
    ALTER TABLE plan_operations
      ADD COLUMN goal_id TEXT GENERATED ALWAYS AS (record_json::jsonb #>> '{replay,goalId}') STORED NOT NULL,
      ADD COLUMN claim_id TEXT GENERATED ALWAYS AS (record_json::jsonb #>> '{replay,claimId}') STORED NOT NULL,
      ADD COLUMN generation INTEGER GENERATED ALWAYS AS ((record_json::jsonb #>> '{replay,generation}')::integer) STORED NOT NULL,
      ADD COLUMN operation_kind TEXT GENERATED ALWAYS AS (record_json::jsonb #>> '{replay,operation}') STORED NOT NULL,
      ADD COLUMN operation_id TEXT GENERATED ALWAYS AS (record_json::jsonb #>> '{replay,operationId}') STORED NOT NULL;
    CREATE UNIQUE INDEX plan_operations_identity
      ON plan_operations (project_key, goal_id, claim_id, generation, operation_kind, operation_id);

    CREATE TABLE coherence_state (
      project_key TEXT PRIMARY KEY REFERENCES projects(project_key) ON DELETE CASCADE,
      version BIGINT NOT NULL CHECK (version >= 0)
    );
    INSERT INTO coherence_state (project_key, version) SELECT project_key, 0 FROM projects;
    CREATE TABLE coherence_vector (
      project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE CASCADE,
      ledger TEXT NOT NULL,
      document_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('active', 'archived', 'registry', 'control')),
      kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
      version BIGINT NOT NULL CHECK (version > 0),
      origin TEXT NOT NULL,
      PRIMARY KEY (project_key, ledger, document_id, scope)
    );
    CREATE INDEX coherence_vector_version ON coherence_vector (project_key, version);
  `);
}
