/**
 * postgres/restoreImporter.ts — `restoreDumpToPostgres` (T580, G81/M250), the
 * POSTGRES analogue of {@link restoreDumpToXdg} (../restoreImporter.ts): the
 * id/timestamp/counter-preserving importer from a store-neutral
 * {@link BackupDumpFile}[] dump into the multi-tenant Postgres schema
 * (postgres/schema.ts, T572/T573).
 *
 * Reuses the EXISTING parse step ({@link parseBackupDump}, the shared inverse
 * of `buildBackupDump`'s serializers — parses `ledgers.yaml` /
 * `<ledger>.md` / `archive/<ledger>/<id>.md` via `parseRegistry`/
 * `parseLedger`/`parseArchive`/`parseMilestoneItemArchive`) and INSERTs rows
 * DIRECTLY against the postgres tables — bypassing `PostgresLedgerStore`'s
 * public mutation API (`createItem`/`updateItem` would regenerate ids and
 * stamp `now()`) so every id, counter, timestamp, and author/session survives
 * EXACTLY as it was at export time, scoped to ONE `project_key`, inside ONE
 * transaction. This single importer is meant to serve BOTH `cq migrate`
 * (T504-postgres) and `cq restore` (T582) once either grows a postgres
 * target, exactly as {@link restoreDumpToXdg} serves both `cq migrate` and
 * `cq restore` for the xdg backend today.
 *
 * DECISION (T580): a restore target does NOT need to be pre-registered —
 * `restoreDumpToPostgres` UPSERTs the `projects` row itself (mirroring
 * `PostgresLedgerStore.init()`'s auto-registration, T574) inside the SAME
 * transaction as the row wipe/reseed, so the importer is self-sufficient: a
 * caller need not have constructed (and `init()`'d) a `PostgresLedgerStore`
 * first. This matches `restoreDumpToXdg`'s self-sufficiency (it calls
 * `ensureSchema` itself and needs no pre-existing sqlite file). The
 * NON-EMPTY-tenant refusal ({@link isPostgresTenantEmpty}) is therefore a
 * raw-SQL read against `ledgers`/`archive_pointers`/`items` — no
 * `PostgresLedgerStore` construction (and its cache load / bootstrap writes)
 * needed just to answer the question.
 *
 * `seq` (the identity column every row table carries, T573) is NEVER named in
 * an INSERT here — it is `GENERATED ALWAYS AS IDENTITY`, assigned in
 * insertion order, which is exactly the row order `PostgresLedgerStore`'s
 * cache-load `ORDER BY seq` expects (parity with the dump's own item order).
 */

import type { SQL } from "bun";
import type { FieldValue, Item } from "../../types.js";
import { LedgerError } from "../../types.js";
import type { BackupDumpFile } from "../backupExporter.js";
import { parseBackupDump, type RestoreSummary } from "../restoreImporter.js";
import { buildPrefixRegistry, normalizeStoredRefFields } from "../../refs.js";
import {
  CANONICAL_LEDGERS,
  LEDGER_LOGS_DIRNAME,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
} from "../../constants.js";
import { ensureSchema } from "./schema.js";
import { writeTransaction } from "./connection.js";

/**
 * True iff `pool`'s tenant `projectKey` currently holds nothing but the
 * canonical bootstrap state — the postgres analogue of
 * {@link isXdgPrimaryEmpty}, same predicate (every ledgers row a CANONICAL
 * name, no archive pointers, and — for the `milestones` ledger — nothing
 * beyond the single immortal `M-AMBIENT` item in the `active` group).
 * `restoreDumpToPostgres` refuses to overwrite a NON-empty tenant without
 * this returning `true`.
 *
 * Reads raw rows directly (no `PostgresLedgerStore` construction/cache-load)
 * so the check is pure and side-effect-free — a project_key with NO
 * `projects` row at all (an entirely unregistered tenant) is vacuously
 * empty too (zero `ledgers` rows).
 */
export async function isPostgresTenantEmpty(pool: SQL, projectKey: string): Promise<boolean> {
  const ledgerRows = await pool<Array<{ name: string }>>`
    SELECT name FROM ledgers WHERE project_key = ${projectKey}
  `;
  if (ledgerRows.length > CANONICAL_LEDGERS.length) return false;
  const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));

  for (const { name } of ledgerRows) {
    if (!canonicalNames.has(name)) return false;

    const pointerRows = await pool<Array<{ id: string }>>`
      SELECT id FROM archive_pointers WHERE project_key = ${projectKey} AND ledger = ${name}
    `;
    if (pointerRows.length > 0) return false;

    const itemRows = await pool<Array<{ id: string; milestone_id: string }>>`
      SELECT id, milestone_id FROM items WHERE project_key = ${projectKey} AND ledger = ${name}
    `;
    if (name === MILESTONES_LEDGER) {
      if (itemRows.length !== 1) return false;
      const only = itemRows[0];
      if (
        only === undefined ||
        only.id !== MILESTONES_AMBIENT_ID ||
        only.milestone_id !== MILESTONES_ACTIVE_GROUP_ID
      ) {
        return false;
      }
    } else if (itemRows.length > 0) {
      return false;
    }
  }
  return true;
}

/**
 * Write a parsed dump's rows DIRECTLY to the postgres tenant `projectKey` —
 * one transaction: UPSERT the `projects` row, wipe any pre-existing rows for
 * this tenant (children first, FK order), then reinsert the dump's ledgers /
 * groups / items / archive pointers / archived items, and import the dump's
 * `.cq/logs/**` entries into the tenant-keyed `logs` table
 * (`PostgresLedgerStore.putLog`'s table, T575). Scoped STRICTLY to
 * `projectKey` — never touches another tenant's rows.
 *
 * Refuses ({@link LedgerError}) when {@link isPostgresTenantEmpty} finds
 * `projectKey` already holds more than the canonical bootstrap state — no
 * merge semantics, same disaster-recovery contract as {@link restoreDumpToXdg}.
 *
 * `archived_at` (the archive_pointers column) is stamped with the restore
 * wall-clock time, same as `restoreDumpToXdg` — it is never read back by any
 * public store surface.
 */
export async function restoreDumpToPostgres(opts: {
  pool: SQL;
  projectKey: string;
  /** `projects.display_name` to UPSERT; defaults to `projectKey` itself. */
  displayName?: string;
  dump: readonly BackupDumpFile[];
}): Promise<RestoreSummary> {
  const pool = opts.pool;
  const pk = opts.projectKey;
  const parsed = parseBackupDump(opts.dump);
  const restoredAt = new Date().toISOString();

  await ensureSchema(pool);

  const empty = await isPostgresTenantEmpty(pool, pk);
  if (!empty) {
    throw new LedgerError(
      `restore: postgres tenant ${pk} already holds data beyond the canonical bootstrap state — ` +
        `refusing to overwrite a non-empty tenant`,
    );
  }

  const refRegistry = buildPrefixRegistry(
    [...parsed.ledgers].map(([name, l]) => ({ name, schema: l.schema })),
  );
  const normalizeFieldsJson = (item: { fields: Record<string, FieldValue> }): string =>
    JSON.stringify(normalizeStoredRefFields(item.fields, refRegistry).fields);

  await writeTransaction(pool, async (tx) => {
    await tx`
      INSERT INTO projects (project_key, display_name)
      VALUES (${pk}, ${opts.displayName ?? pk})
      ON CONFLICT (project_key) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
    `;

    // Wipe any pre-existing rows for THIS tenant only (children first, FK
    // order) — defense in depth even though isPostgresTenantEmpty already
    // gated above; mirrors restoreDumpToXdg's unconditional wipe-then-insert.
    await tx`DELETE FROM archived_items WHERE project_key = ${pk}`;
    await tx`DELETE FROM archive_pointers WHERE project_key = ${pk}`;
    await tx`DELETE FROM items WHERE project_key = ${pk}`;
    await tx`DELETE FROM groups WHERE project_key = ${pk}`;
    await tx`DELETE FROM ledgers WHERE project_key = ${pk}`;
    await tx`DELETE FROM logs WHERE project_key = ${pk}`;

    for (const [name, ledger] of parsed.ledgers) {
      await tx`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${pk}, ${name}, ${JSON.stringify(ledger.schema)}, ${ledger.counters.milestone}, ${ledger.counters.item})
      `;
      for (const group of ledger.milestones) {
        await tx`
          INSERT INTO groups (project_key, ledger, id, title, description)
          VALUES (${pk}, ${name}, ${group.id}, ${group.title}, ${group.description})
        `;
        for (const item of group.items) {
          await insertItemRow(tx, pk, name, group.id, item, normalizeFieldsJson);
        }
      }

      const archiveMap = parsed.archives.get(name);
      for (const pointer of ledger.archivePointers) {
        await tx`
          INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
          VALUES (${pk}, ${name}, ${pointer.id}, ${pointer.summary}, ${pointer.title}, ${pointer.status}, ${restoredAt})
        `;
        const content = archiveMap?.get(pointer.id);
        const items: Item[] =
          content === undefined ? [] : content.kind === "item" ? [content.item] : content.milestone.items;
        for (const item of items) {
          await tx`
            INSERT INTO archived_items
              (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
            VALUES (${pk}, ${name}, ${pointer.id}, ${item.id}, ${item.milestoneId}, ${item.status},
                    ${normalizeFieldsJson(item)}, ${item.createdAt}, ${item.updatedAt},
                    ${item.author ?? null}, ${item.session ?? null})
          `;
        }
      }
    }

    const logsPrefix = `${LEDGER_LOGS_DIRNAME}/`;
    for (const f of parsed.logs) {
      const rel = f.path.slice(logsPrefix.length);
      await tx`
        INSERT INTO logs (project_key, path, content) VALUES (${pk}, ${rel}, ${f.content})
      `;
    }
  });

  return { fileCount: opts.dump.length, ledgerCount: parsed.ledgers.size, logCount: parsed.logs.length };
}

/** Insert one active item row (used by the groups loop above). */
async function insertItemRow(
  tx: SQL,
  projectKey: string,
  ledger: string,
  milestoneId: string,
  item: Item,
  normalizeFieldsJson: (item: { fields: Record<string, FieldValue> }) => string,
): Promise<void> {
  await tx`
    INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
    VALUES (${projectKey}, ${ledger}, ${item.id}, ${milestoneId}, ${item.status},
            ${normalizeFieldsJson(item)}, ${item.createdAt}, ${item.updatedAt},
            ${item.author ?? null}, ${item.session ?? null})
  `;
}
