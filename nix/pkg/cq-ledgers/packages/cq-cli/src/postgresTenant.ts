/**
 * postgresTenant.ts — tenant-scoped resolve/wipe helpers for `cq reset` /
 * `cq erase` against `[ledger] backend = 'postgres'` (T583, Q275 context).
 *
 * A shared Postgres database holds EVERY tenant's rows (T572) — `reset` and
 * `erase` must operate on ONE project's rows only, never the whole database.
 * This module is the ONE place that scopes the destructive DELETE sweep,
 * reused by both `runReset`'s and `runErase`'s postgres branches (main.ts).
 *
 * Deliberately does NOT go through `createLedgerStore` (T577): that factory's
 * `init()` UNCONDITIONALLY UPSERTs the `projects` row (T574 auto-registration)
 * as a side effect of construction — exactly the side effect `cq erase`'s
 * "refuse when the tenant isn't registered" guard must observe BEFORE it
 * happens, and `cq reset`'s confirmation message (naming the tenant) must
 * describe before it acts. Instead this resolves the connection / tenant key
 * / registry row directly via the barrel's already-exported primitives
 * (openPgPool, ensureSchema, resolvePostgresDsn, resolveProjectKey,
 * resolveDisplayName, PostgresLedgerStore) — the honest minimal path for a
 * DELETE sweep that needs no fully-loaded store.
 */

import * as path from "node:path";
import type { SQL } from "bun";
import { loadConfig, type LedgerConfig } from "@cq/config";
import {
  openPgPool,
  ensureSchema,
  resolvePostgresDsn,
  resolveDisplayName,
  resolveProjectKey,
  PostgresLedgerStore,
} from "@cq/ledger";

/** A resolved connection to the tenant `root`'s cq.toml names, PRE any registry mutation. */
export interface PostgresTenantHandle {
  /** The live connection pool (schema already ensured). Caller owns `.close()`. */
  readonly pool: SQL;
  /** This tenant's key (`projects.project_key`). */
  readonly projectKey: string;
  /**
   * `projects.display_name` for an ALREADY-registered tenant, or `null` when
   * `projectKey` has no `projects` row yet — the erase guard's "nothing to
   * erase" signal.
   */
  readonly registeredDisplayName: string | null;
  /**
   * The RECONCILED display name (Q270 chain) a fresh registration would use —
   * for naming a not-yet-registered tenant in `reset`'s confirmation message
   * (erase refuses before it would need this).
   */
  readonly candidateDisplayName: string;
  /** `[ledger].backup`, surfaced so `cq reset` can enforce its pre-wipe-snapshot fail-fast. */
  readonly backup: LedgerConfig["backup"];
}

/**
 * Resolve the `backend = 'postgres'` tenant `root`'s cq.toml names: open +
 * schema-ensure a pool, resolve the projectKey + candidate display name, and
 * read back the `projects` row WITHOUT registering one.
 */
export async function resolvePostgresTenant(root: string): Promise<PostgresTenantHandle> {
  const config = loadConfig(root);
  const ledgerConfig = config?.ledger;
  if (ledgerConfig === null || ledgerConfig === undefined || ledgerConfig.backend !== "postgres") {
    throw new Error(
      `resolvePostgresTenant: [ledger] backend != 'postgres' at ${root} (internal inconsistency)`,
    );
  }
  const projectKey = await resolveProjectKey({ repoRoot: root, projectId: ledgerConfig.projectId });
  const resolution = resolvePostgresDsn(ledgerConfig, process.env);
  const dsn = resolution.kind === "dsn" ? resolution.dsn : "";
  const pool = openPgPool(dsn);
  await ensureSchema(pool);

  const rows = await pool<Array<{ display_name: string }>>`
    SELECT display_name FROM projects WHERE project_key = ${projectKey}
  `;
  const registeredDisplayName = rows[0]?.display_name ?? null;
  const candidateDisplayName = resolveDisplayName({
    projectName: config?.project?.name,
    projectId: ledgerConfig.projectId,
    repoBasename: path.basename(root),
    projectKey,
  });

  return { pool, projectKey, registeredDisplayName, candidateDisplayName, backup: ledgerConfig.backup };
}

/** Active row counts per ledger for `projectKey`, BEFORE any wipe (for the operator summary). */
export async function countTenantActiveItems(
  pool: SQL,
  projectKey: string,
): Promise<Array<{ name: string; itemCount: number }>> {
  const rows = await pool<Array<{ ledger: string; count: string }>>`
    SELECT ledger, COUNT(*)::text AS count FROM items
    WHERE project_key = ${projectKey} GROUP BY ledger ORDER BY ledger
  `;
  return rows.map((r) => ({ name: r.ledger, itemCount: Number(r.count) }));
}

/**
 * DELETE every row `projectKey` owns, children-first (FK order) — the same
 * wipe order {@link PostgresLedgerStore.backupAndReinitTenant} uses, minus its
 * shadow-copy step (no backup here: `cq reset` enforces `[ledger].backup ===
 * 'none'` before calling this — its own pre-wipe snapshot is not yet wired,
 * see `PostgresBackupNotWiredError`; the general `cq backup`/`cq restore`
 * parity IS wired, T582). `includeProjectRow` also drops the
 * `projects` registry row (erase only; reset keeps it so the tenant stays
 * registered through the reinit).
 */
export async function wipeTenantRows(
  pool: SQL,
  projectKey: string,
  includeProjectRow: boolean,
): Promise<void> {
  await pool.begin(async (tx) => {
    await tx`DELETE FROM archived_items WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM archive_pointers WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM items WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM groups WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM ledgers WHERE project_key = ${projectKey}`;
    await tx`DELETE FROM logs WHERE project_key = ${projectKey}`;
    if (includeProjectRow) {
      await tx`DELETE FROM projects WHERE project_key = ${projectKey}`;
    }
  });
}

/**
 * Re-seed the full canonical ledger set for `projectKey` fresh (reset only) —
 * constructs a THROWAWAY {@link PostgresLedgerStore} on the SAME pool +
 * projectKey and runs its normal `init()` bootstrap (every canonical ledger
 * classifies as missing right after {@link wipeTenantRows}, so `init()`'s
 * Pass 2 provisions everything) rather than duplicating its private
 * `runBootstrapWrites` DDL here. Does NOT dispose/close the pool — the caller
 * owns the pool's lifecycle across the whole reset operation.
 */
export async function reseedCanonicalTenant(
  pool: SQL,
  projectKey: string,
  displayName: string,
): Promise<void> {
  const store = new PostgresLedgerStore({ pool, projectKey, displayName });
  await store.init();
}
