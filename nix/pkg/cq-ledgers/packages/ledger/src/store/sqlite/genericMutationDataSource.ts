import type { Database } from "bun:sqlite";
import { TASKS_LEDGER } from "../../constants.js";
import type {
  GenericMutationArchivedTarget,
  GenericMutationDataSource,
  GenericMutationLedgerMetadata,
} from "../genericMutationDataSource.js";
import type { Item, LedgerSchema } from "../../types.js";
import type { SqliteOperationMeasurement } from "./operationObservability.js";

interface LedgerRow {
  readonly name: string;
  readonly schema_json: string;
  readonly milestone_counter: number;
  readonly item_counter: number;
}

interface ItemRow {
  readonly ledger: string;
  readonly id: string;
  readonly milestone_id: string;
  readonly status: string;
  readonly fields_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly author: string | null;
  readonly session: string | null;
}

interface ReferenceRow {
  readonly source_ledger: string;
  readonly source_id: string;
  readonly field_name: string;
  readonly target_ledger: string;
  readonly target_id: string;
}

function splitRef(ref: string): readonly [string, string] {
  const colon = ref.indexOf(":");
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

function rowToItem(row: ItemRow): Item {
  const item: Item = {
    id: row.id,
    milestoneId: row.milestone_id,
    status: row.status,
    fields: JSON.parse(row.fields_json) as Item["fields"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.author !== null) item.author = row.author;
  if (row.session !== null) item.session = row.session;
  return item;
}

export function createSqliteGenericMutationDataSource(
  db: Database,
  measurement: SqliteOperationMeasurement | undefined,
): GenericMutationDataSource {
  let ledgerCache: readonly GenericMutationLedgerMetadata[] | undefined;
  const record = (
    table: string,
    mode: "read" | "sweep",
    kind:
      | "keys"
      | "primary-key"
      | "milestone-members"
      | "selected-ledger-status"
      | "reference-source"
      | "reference-target",
    keys: readonly string[],
    rowKeys: readonly string[],
  ): void => {
    measurement?.recordAccess({
      phase: "transaction",
      table,
      mode,
      keyedPredicate: { kind, keys },
      rowKeys,
      count: rowKeys.length,
    });
  };
  const placeholders = (values: readonly string[]): string => values.map(() => "?").join(", ");

  return {
    listLedgers(): readonly GenericMutationLedgerMetadata[] {
      if (ledgerCache !== undefined) return ledgerCache;
      const rows = db
        .query(
          "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers ORDER BY name",
        )
        .all() as LedgerRow[];
      record(
        "ledgers",
        "read",
        "keys",
        ["registered-ledger-metadata"],
        rows.map(({ name }) => name),
      );
      ledgerCache = rows.map((row) => ({
        id: row.name,
        schema: JSON.parse(row.schema_json) as LedgerSchema,
        counters: { milestone: row.milestone_counter, item: row.item_counter },
      }));
      return ledgerCache;
    },

    fetchActiveItem(ref): Item | undefined {
      const [ledgerId, itemId] = splitRef(ref);
      const row = db
        .query(
          `SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
           FROM items WHERE ledger = ? AND id = ?`,
        )
        .get(ledgerId, itemId) as ItemRow | null;
      record("items", "read", "primary-key", [ref], row === null ? [] : [ref]);
      return row === null ? undefined : rowToItem(row);
    },

    fetchArchivedItem(ref): GenericMutationArchivedTarget | undefined {
      const [ledgerId, itemId] = splitRef(ref);
      const row = db
        .query(
          `SELECT ledger, pointer_id, id, milestone_id, status, fields_json,
                  created_at, updated_at, author, session
           FROM archived_items WHERE ledger = ? AND id = ?
           ORDER BY pointer_id LIMIT 1`,
        )
        .get(ledgerId, itemId) as (ItemRow & { pointer_id: string }) | null;
      record("archived_items", "read", "primary-key", [ref], row === null ? [] : [ref]);
      return row === null
        ? undefined
        : { ledgerId: row.ledger, pointerId: row.pointer_id, item: rowToItem(row) };
    },

    referenceTargets(sourceRef, fieldNames): readonly string[] {
      if (fieldNames.length === 0) return [];
      const [ledgerId, itemId] = splitRef(sourceRef);
      const rows = db
        .query(
          `SELECT source_ledger, source_id, field_name, target_ledger, target_id
           FROM item_references
           WHERE source_ledger = ? AND source_id = ?
             AND field_name IN (${placeholders(fieldNames)})
           ORDER BY field_name, target_ledger, target_id`,
        )
        .all(ledgerId, itemId, ...fieldNames) as ReferenceRow[];
      record(
        "item_references",
        "read",
        "reference-source",
        [sourceRef],
        rows.map(
          ({ field_name, target_ledger, target_id }) =>
            `${sourceRef}:${field_name}:${target_ledger}:${target_id}`,
        ),
      );
      return rows.map(({ target_ledger, target_id }) => `${target_ledger}:${target_id}`);
    },

    referenceSources(targetRef, fieldNames): readonly string[] {
      if (fieldNames.length === 0) return [];
      const [ledgerId, itemId] = splitRef(targetRef);
      const rows = db
        .query(
          `SELECT source_ledger, source_id, field_name, target_ledger, target_id
           FROM item_references
           WHERE target_ledger = ? AND target_id = ?
             AND field_name IN (${placeholders(fieldNames)})
           ORDER BY field_name, source_ledger, source_id`,
        )
        .all(ledgerId, itemId, ...fieldNames) as ReferenceRow[];
      record(
        "item_references",
        "read",
        "reference-target",
        [targetRef],
        rows.map(
          ({ source_ledger, source_id, field_name }) =>
            `${source_ledger}:${source_id}:${field_name}:${targetRef}`,
        ),
      );
      return rows.map(({ source_ledger, source_id }) => `${source_ledger}:${source_id}`);
    },

    itemRefsByMilestone(milestoneId): readonly string[] {
      const rows = db
        .query("SELECT ledger, id FROM items WHERE milestone_id = ? ORDER BY ledger, id")
        .all(milestoneId) as Array<{ ledger: string; id: string }>;
      const refs = rows.map(({ ledger, id }) => `${ledger}:${id}`);
      const mode = measurement?.accessScope().operation === "update-milestone" ? "read" : "sweep";
      record("items", mode, "milestone-members", [milestoneId], refs);
      return refs;
    },

    itemRefsByLedgerStatuses(ledgerId, statuses): readonly string[] {
      if (statuses.length === 0) return [];
      const rows = db
        .query(
          `SELECT ledger, id FROM items
           WHERE ledger = ? AND status IN (${placeholders(statuses)}) ORDER BY id`,
        )
        .all(ledgerId, ...statuses) as Array<{ ledger: string; id: string }>;
      const refs = rows.map(({ ledger, id }) => `${ledger}:${id}`);
      record(
        "items",
        "sweep",
        "selected-ledger-status",
        statuses.map((status) => `${ledgerId}:${status}`),
        refs,
      );
      return refs;
    },

    liveTaskRefsByMilestone(milestoneId): readonly string[] {
      const statuses = ["planned", "wip", "blocked"];
      const rows = db
        .query(
          `SELECT ledger, id FROM items
           WHERE ledger = ? AND milestone_id = ? AND status IN (${placeholders(statuses)})
           ORDER BY id`,
        )
        .all(TASKS_LEDGER, milestoneId, ...statuses) as Array<{ ledger: string; id: string }>;
      const refs = rows.map(({ ledger, id }) => `${ledger}:${id}`);
      record("items", "read", "milestone-members", [milestoneId], refs);
      return refs;
    },
  };
}
