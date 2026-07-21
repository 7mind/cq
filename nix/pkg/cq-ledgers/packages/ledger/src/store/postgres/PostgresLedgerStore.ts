/**
 * PostgresLedgerStore — multi-tenant Postgres implementation of `LedgerStore`
 * (T573, G81/M248).
 *
 * DESIGN LOCK (Q277 async-driver consequence). Every Postgres client
 * (`Bun.sql`) is ASYNC-ONLY, while the `LedgerStore` read surface
 * (`enumerate`/`fetch`/`fetchItem`/`fetchMilestone`/`listMilestoneItems`/
 * `snapshot`/`search`) is SYNCHRONOUS. This store therefore CANNOT use the
 * SqliteLedgerStore "every row read is a fresh query" model. Instead it serves
 * reads from an in-memory MATERIALIZED CACHE of its OWN tenant's rows —
 * FsLedgerStore/InMemoryLedgerStore style — loaded on `init()`:
 *
 *  - Reads are answered synchronously from the cached `Ledger` objects
 *    (`this.ledgers`) + the archived-row maps (`this.archives` /
 *    `this.itemArchives`), exactly like InMemoryLedgerStore.
 *  - Mutations WRITE THROUGH to Postgres in a transaction (every row scoped by
 *    `project_key`), then update the cache POST-COMMIT and fire `onMutation` +
 *    `NOTIFY` (the LISTEN side is T578's concern — this store only NOTIFYs via
 *    the T572 `notifyProjectChanged` helper).
 *  - `invalidate(ledgerId)` re-reads that ledger's rows from Postgres under the
 *    per-ledger lock (async, matching the interface) so a peer instance's write
 *    — surfaced by the T578 LISTEN watcher — becomes visible here.
 *  - The derived `LedgerSearchIndex` (ftsSearch) is cold-built on `init()`,
 *    rebuilt per-mutation (whole affected-ledger bucket, matching
 *    InMemoryLedgerStore), and rebuilt on `invalidate`.
 *
 * Like SqliteLedgerStore, this implements the interface DIRECTLY (NOT via
 * AbstractLedgerStore, whose serialize funnel K102 forbids) and reuses the pure
 * `core.ts` `apply*` guards VERBATIM so error types/results match the other
 * backends. Counters live in the `ledgers` table and are incremented INSIDE the
 * write transaction (`UPDATE … RETURNING`), so cross-instance id allocation
 * never collides.
 *
 * Scope (T573): the full LedgerStore surface + write-through + cache + NOTIFY.
 *
 * Tenant bootstrap + auto-registration + display-name chain (T574): `init()`
 * (a) UPSERTs the `projects` row for this tenant's `projectKey` on EVERY
 * connect, so a later cq.toml rename (Q270) propagates to `display_name` on
 * reconnect — the caller (T577's factory) computes the RECONCILED name via
 * `resolveDisplayName` (displayName.ts) and passes it in as a constructor
 * input; (b) runs a Pass-1/Pass-2 divergence detection over this tenant's
 * persisted canonical-ledger rows, mirroring SqliteLedgerStore.init() (same
 * `classifyCanonicalLedgers` classification, divergence.ts, built on the same
 * `schemasEqual`/`schemaCompatible` helpers): missing ledgers are provisioned,
 * widened ledgers upgraded in place, and — unlike the sqlite backend — a
 * genuinely DIVERGENT canonical schema routes through `onSchemaDivergence`
 * with a TENANT-SCOPED backup (see {@link PostgresLedgerStore.backupAndReinitTenant}
 * for why this diverges from sqlite's whole-file `VACUUM INTO` and why the
 * DEFAULT policy still matches sqlite's `'backup-reinit'`).
 */

import * as path from "node:path";
import type { SQL } from "bun";
import type {
  ArchivePointer,
  FetchedLedger,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../../types.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  LedgerError,
  LedgerNotFoundError,
} from "../../types.js";
import type {
  ArchiveContent,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  FtsSearchHit,
  FtsSearchOpts,
  LedgerMutationOp,
  LedgerStore,
  OnMutation,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "../LedgerStore.js";
import type { LedgerSnapshot } from "../../snapshot.js";
import { buildSnapshot } from "../../snapshot.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyReattachItem,
  applyReopenItem,
  applyUpdateItem,
  applyUpdateMilestoneItem,
  assertGoalPhasePreconditions,
  assertMilestoneActive,
  assertPrefixUnique,
  assertQuestionAnswerPrecondition,
  effectiveIdPrefix,
  findItem,
  resolveMilestoneView,
  searchItems,
  validateSchema,
} from "../core.js";
import type { RefValidationContext, StatusChangePrecondition } from "../core.js";
import { buildPrefixRegistry } from "../../refs.js";
import { cloneItem, materialiseFetchedLedger } from "../InMemoryLedgerStore.js";
import { LedgerSearchIndex } from "../../search/LedgerSearchIndex.js";
import { AsyncMutex } from "../mutex.js";
import {
  CANONICAL_LEDGERS,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  LEDGER_LOGS_RELATIVE_PREFIX,
  LEDGER_LOGS_STRIP_RE,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  QUESTIONS_ANSWER_FIELD,
  QUESTIONS_LEDGER,
} from "../../constants.js";
import {
  MAX_READ_LOG_BYTES,
  type ReadLogResult,
} from "../../mcp/readLog.js";
import type { ListProjectsResult } from "../../mcp/listProjects.js";
import { notifyProjectChanged, writeTransaction } from "./connection.js";
import { classifyCanonicalLedgers } from "./divergence.js";

export interface PostgresLedgerStoreOpts {
  /**
   * A `Bun.sql` connection pool (see {@link openPgPool}) whose database has
   * already had {@link ensureSchema} applied. The store OWNS this pool's
   * lifecycle — `dispose()` closes it.
   */
  pool: SQL;
  /**
   * This store's tenant key. Every row this store reads/writes is scoped by
   * `project_key = projectKey`. Registration (the `projects` row) is this
   * store's job (T574): `init()` UPSERTs it from `displayName` on every
   * connect, so no pre-existing row is assumed.
   */
  projectKey: string;
  /**
   * This tenant's RECONCILED display name (Q270) — the caller (T577's
   * factory) computes it via `resolveDisplayName` (displayName.ts) from cq.toml
   * `[project].name` / `[ledger].projectId` / the repo basename / `projectKey`,
   * and passes the WINNER in here. `init()` UPSERTs it into
   * `projects.display_name` on EVERY connect (not just first registration), so
   * a later cq.toml rename propagates on reconnect.
   */
  displayName: string;
  /** Returns an ISO 8601 UTC timestamp. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /**
   * Fired AFTER every successful write (see {@link OnMutation}) — i.e. after
   * the write transaction COMMITs and the cache is updated. Guarded: a throw is
   * logged, never unwinds the committed write.
   */
  onMutation?: OnMutation;
  /**
   * Policy for a persisted canonical-ledger schema that diverged from canon
   * (detected at `init()` Pass 1 via `classifyCanonicalLedgers`, the same
   * `schemasEqual`/`schemaCompatible` detection SqliteLedgerStore uses):
   *
   * - `'backup-reinit'` (DEFAULT — parity with SqliteLedgerStore's default):
   *   copy ONLY this tenant's rows (never another tenant's — this is a SHARED
   *   multi-tenant database, so a whole-database `VACUUM INTO` byte copy like
   *   sqlite's would be both disproportionate and wrong-scoped) into a
   *   timestamped shadow `project_key`, then wipe this tenant's original rows
   *   and reseed fresh canonical state. See
   *   {@link PostgresLedgerStore.backupAndReinitTenant} for the documented
   *   cheap-enough-to-default rationale.
   * - `'abort'`: refuse to start — throw `BootstrapViolationError` — so the
   *   divergence is loud and operator-handled, with NO row touched.
   */
  onSchemaDivergence?: "backup-reinit" | "abort";
}

/** Lock key for the global milestones mutex (mirrors InMemoryLedgerStore). */
const MILESTONES_MUTEX_KEY = "__milestones__";

/**
 * Lock key serializing `createLedger` (the registry write path). Review r1
 * fix: without it two concurrent in-instance createLedger calls both pass the
 * duplicate-name / prefix-uniqueness checks against the cache BEFORE either
 * INSERT commits — the same-name loser would surface a raw PG unique-violation
 * instead of `DuplicateIdError`, and two DIFFERENT names with COLLIDING
 * idPrefixes would BOTH commit, persisting a Q-CANL-8 violation.
 */
const REGISTRY_MUTEX_KEY = "__registry__";

/**
 * Allowed shape for a created ledger's name (same rule as
 * SqliteLedgerStore.createLedger): path-safe, no separators.
 */
const LEDGER_NAME_RE = /^[A-Za-z0-9_-]+$/;

// --- row shapes (mirror postgres/schema.ts DDL, snake_case columns) ---------

interface LedgerRow {
  name: string;
  schema_json: string;
  milestone_counter: number;
  item_counter: number;
}

interface GroupRow {
  ledger: string;
  id: string;
  title: string;
  description: string;
}

interface ItemRow {
  ledger: string;
  id: string;
  milestone_id: string;
  status: string;
  fields_json: string;
  created_at: string;
  updated_at: string;
  author: string | null;
  session: string | null;
}

interface ArchivedItemRow extends ItemRow {
  pointer_id: string;
}

interface PointerRow {
  ledger: string;
  id: string;
  summary: string;
  title: string;
  status: string;
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

/** Deep-clone a materialised `Ledger` so a mutation can run the pure `apply*`
 * guards against a throwaway copy and only swap it into the cache post-commit
 * (a mid-transaction failure leaves the cache untouched). */
function cloneLedger(ledger: Ledger): Ledger {
  return structuredClone(ledger);
}

export class PostgresLedgerStore implements LedgerStore {
  private readonly projectKey: string;
  private readonly displayName: string;
  private readonly now: () => string;
  private readonly onMutation: OnMutation | null;
  private readonly onSchemaDivergence: "backup-reinit" | "abort";
  private handle: SQL | null;

  /** In-memory materialized cache of this tenant's ACTIVE state (K102 read model). */
  private readonly ledgers = new Map<string, Ledger>();
  /** Archived milestone-GROUPs, key `<ledger>/<pointerId>` (non-milestones ledgers). */
  private readonly archives = new Map<string, Milestone>();
  /** Archived milestone-ITEMs, key `milestones/<pointerId>`. */
  private readonly itemArchives = new Map<string, Item>();
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly searchIndex = new LedgerSearchIndex();
  private initialised = false;

  constructor(opts: PostgresLedgerStoreOpts) {
    this.handle = opts.pool;
    this.projectKey = opts.projectKey;
    this.displayName = opts.displayName;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onMutation = opts.onMutation ?? null;
    this.onSchemaDivergence = opts.onSchemaDivergence ?? "backup-reinit";
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;
    const pool = this.pool();
    const pk = this.projectKey;

    // Pass 1 — READ-ONLY divergence detection over this tenant's persisted
    // canonical ledgers (parity with SqliteLedgerStore.init): classify every
    // canonical name as missing / widened (forward-compatible, T407) /
    // divergent, via the pure classifyCanonicalLedgers (divergence.ts). Runs
    // BEFORE the projects UPSERT (review r1 criticism 2) so the 'abort'
    // policy is genuinely side-effect-free — a divergent tenant's
    // display_name must not be overwritten by a connect that then refuses to
    // start. Reading ledgers rows before their projects parent exists is
    // fine: the classification is read-only, and a fresh tenant simply has
    // no rows (all canonical names classify as missing).
    const existingRows = await pool<LedgerRow[]>`
      SELECT name, schema_json, milestone_counter, item_counter
      FROM ledgers WHERE project_key = ${pk}
    `;
    const persistedByName = new Map(
      existingRows.map((r) => [r.name, JSON.parse(r.schema_json) as LedgerSchema]),
    );
    const { missing, widened, divergent } = classifyCanonicalLedgers(persistedByName);

    if (divergent.length > 0 && this.onSchemaDivergence === "abort") {
      // Opt-out: refuse to start so the divergence is loud + operator-handled.
      // No backup, no projects UPSERT — NOTHING is written on abort (parity
      // with SqliteLedgerStore, whose abort path leaves the db untouched).
      throw new BootstrapViolationError(
        `existing ${divergent.join(", ")} ledger(s) have a different schema than their canonical bootstrap schema (project_key ${pk})`,
      );
    }

    // Auto-registration (Q270): UPSERT the projects row on EVERY connect —
    // not just first registration — so a later cq.toml rename propagates to
    // display_name on reconnect. Runs AFTER the read-only Pass 1 + abort gate
    // (above), but BEFORE any bootstrap WRITE (FK: ledgers -> projects).
    await pool`
      INSERT INTO projects (project_key, display_name)
      VALUES (${pk}, ${this.displayName})
      ON CONFLICT (project_key) DO UPDATE SET display_name = ${this.displayName}, updated_at = now()
    `;

    if (divergent.length > 0) {
      // Default policy — TENANT-SCOPED backup + reinit (see
      // backupAndReinitTenant's doc for why this diverges from
      // SqliteLedgerStore's whole-file VACUUM INTO).
      const shadowKey = await this.backupAndReinitTenant();
      process.stderr.write(
        `WARNING: PostgresLedgerStore divergence detected for project_key ${pk} ` +
          `(ledgers: ${divergent.join(", ")}) — prior tenant state backed up to project_key ${shadowKey}\n`,
      );
    } else {
      // Pass 2 — bootstrap writes, atomically: provision missing canonical
      // ledgers, apply widening upgrades, seed the milestones bootstrap
      // active group + the immortal M-AMBIENT milestone. Always runs (even
      // when missing/widened are both empty) so a RECONNECT to an
      // already-provisioned tenant still gets the bootstrap group/M-AMBIENT
      // guarantee — parity with SqliteLedgerStore's unconditional Pass 2.
      await this.bootstrapCanonicalRows(missing, widened);
    }

    await this.loadCache();
    this.initialised = true;

    for (const name of this.ledgers.keys()) {
      this.rebuildLedgerIndexActive(name);
      this.refreshLedgerIndexArchived(name);
    }
  }

  /**
   * Provision the given canonical ledgers from canon, apply any widening
   * upgrades, and seed the milestones bootstrap active group + the immortal
   * M-AMBIENT milestone, all under one write transaction, scoped by
   * `project_key` (parity with SqliteLedgerStore.bootstrapCanonicalRows).
   */
  private async bootstrapCanonicalRows(missing: string[], widened: string[] = []): Promise<void> {
    await writeTransaction(this.pool(), (tx) => this.runBootstrapWrites(tx, missing, widened));
  }

  /**
   * The bootstrap writes themselves, parameterised over the SQL handle so
   * {@link backupAndReinitTenant} can run them inside the SAME transaction as
   * its wipe (one atomic backup+wipe+reseed, rather than three separate
   * transactions with a window for a crash to leave the tenant half-wiped).
   */
  private async runBootstrapWrites(tx: SQL, missing: string[], widened: string[]): Promise<void> {
    const canonSchema = new Map(CANONICAL_LEDGERS.map((c) => [c.name, c.schema]));
    const pk = this.projectKey;
    for (const name of missing) {
      await tx`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        VALUES (${pk}, ${name}, ${JSON.stringify(canonSchema.get(name))}, 0, 0)
      `;
    }
    for (const name of widened) {
      await tx`
        UPDATE ledgers SET schema_json = ${JSON.stringify(canonSchema.get(name))}
        WHERE project_key = ${pk} AND name = ${name}
      `;
    }
    await tx`
      INSERT INTO groups (project_key, ledger, id, title, description)
      VALUES (${pk}, ${MILESTONES_LEDGER}, ${MILESTONES_ACTIVE_GROUP_ID}, ${MILESTONES_ACTIVE_GROUP_TITLE}, '')
      ON CONFLICT DO NOTHING
    `;
    const ambient = await tx<Array<{ id: string }>>`
      SELECT id FROM items
      WHERE project_key = ${pk} AND ledger = ${MILESTONES_LEDGER} AND id = ${MILESTONES_AMBIENT_ID}
    `;
    if (ambient.length === 0) {
      const now = this.now();
      await tx`
        INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
        VALUES (${pk}, ${MILESTONES_LEDGER}, ${MILESTONES_AMBIENT_ID}, ${MILESTONES_ACTIVE_GROUP_ID}, 'open',
                ${JSON.stringify({ title: "ambient" })}, ${now}, ${now}, ${null}, ${null})
      `;
    }
  }

  /**
   * Divergence BACKUP+REINIT action (T574), TENANT-SCOPED — the multi-tenant
   * analogue of SqliteLedgerStore's whole-file `VACUUM INTO` backup.
   *
   * DECISION (documented per the task): a byte-level backup of the WHOLE
   * database, mirroring sqlite's approach exactly, is the WRONG shape here —
   * one Postgres database holds EVERY tenant's rows, so copying the whole
   * database would back up (and, on reinit, imply wiping) other tenants' data
   * that never diverged. The right-scoped alternative — copying only THIS
   * tenant's rows — turns out to be genuinely CHEAP: every row this backend
   * touches is already `project_key`-scoped (T572/T573), so "copy this
   * tenant" is just `INSERT INTO <table> (...) SELECT <shadow_key>, ... FROM
   * <table> WHERE project_key = <this tenant>` per table, no new tooling, no
   * `VACUUM` (which cannot run inside a transaction and would need its own
   * connection). That cheapness is why this backend's DEFAULT policy still
   * matches sqlite's `'backup-reinit'` rather than defaulting to `'abort'`.
   *
   * The whole thing — copy every table's rows for this tenant into a fresh
   * `<projectKey>__divergence-backup-<sanitized-now>` shadow project_key, wipe
   * the original tenant's rows (children first, FK order), reseed the full
   * canonical set fresh — runs as ONE write transaction: a crash mid-way rolls
   * back entirely rather than leaving the tenant half-wiped (an improvement
   * over sqlite, whose `VACUUM INTO` cannot share a transaction with the wipe).
   *
   * Returns the shadow `project_key` (the locator named in the stderr
   * WARNING).
   */
  private async backupAndReinitTenant(): Promise<string> {
    const pk = this.projectKey;
    const shadowKey = `${pk}__divergence-backup-${this.now().replace(/[^0-9A-Za-z]/g, "-")}`;
    await writeTransaction(this.pool(), async (tx) => {
      await tx`
        INSERT INTO projects (project_key, display_name)
        VALUES (${shadowKey}, ${`${this.displayName} (schema-divergence backup)`})
      `;
      await tx`
        INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
        SELECT ${shadowKey}, name, schema_json, milestone_counter, item_counter
        FROM ledgers WHERE project_key = ${pk}
      `;
      await tx`
        INSERT INTO groups (project_key, ledger, id, title, description)
        SELECT ${shadowKey}, ledger, id, title, description
        FROM groups WHERE project_key = ${pk}
      `;
      await tx`
        INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
        SELECT ${shadowKey}, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
        FROM items WHERE project_key = ${pk}
      `;
      await tx`
        INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
        SELECT ${shadowKey}, ledger, id, summary, title, status, archived_at
        FROM archive_pointers WHERE project_key = ${pk}
      `;
      await tx`
        INSERT INTO archived_items (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
        SELECT ${shadowKey}, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session
        FROM archived_items WHERE project_key = ${pk}
      `;
      // Review r2 (criticism 1): the tenant-keyed `logs` rows (T575's
      // log-artifact storage) are tenant state too — copy them into the
      // shadow and wipe them below, keeping the backup complete for THIS
      // tenant and the reinit'd tenant genuinely fresh.
      await tx`
        INSERT INTO logs (project_key, path, content, created_at)
        SELECT ${shadowKey}, path, content, created_at
        FROM logs WHERE project_key = ${pk}
      `;

      // Wipe the ORIGINAL tenant's rows (children first, FK order), then
      // reseed the full canonical set fresh — same write shape as
      // runBootstrapWrites's Pass 2, sharing THIS transaction.
      await tx`DELETE FROM archived_items WHERE project_key = ${pk}`;
      await tx`DELETE FROM archive_pointers WHERE project_key = ${pk}`;
      await tx`DELETE FROM items WHERE project_key = ${pk}`;
      await tx`DELETE FROM groups WHERE project_key = ${pk}`;
      await tx`DELETE FROM ledgers WHERE project_key = ${pk}`;
      await tx`DELETE FROM logs WHERE project_key = ${pk}`;

      await this.runBootstrapWrites(
        tx,
        CANONICAL_LEDGERS.map((c) => c.name),
        [],
      );
    });
    return shadowKey;
  }

  /**
   * Cold-load the whole tenant's rows into the in-memory cache.
   *
   * Row order: every query ORDERs BY the monotonic `seq` identity column
   * (T573 review r1 — `ctid` is unstable across UPDATEs, whereas `seq` is
   * assigned once at INSERT), giving sqlite-rowid / fs-document-order parity
   * across restart/invalidate. One deliberate consequence, matching the sqlite
   * backend's semantics exactly: `unarchiveItem` re-INSERTs the reattached
   * item row, so it gets a FRESH seq and sorts to the END of its group on a
   * later reload — the same end-of-group placement sqlite's rowid gives its
   * unarchive re-insert, and the same position `applyReattachItem` pushes to
   * in the live cache, so the cache and a reload agree.
   */
  private async loadCache(): Promise<void> {
    const pool = this.pool();
    const pk = this.projectKey;
    this.ledgers.clear();
    this.archives.clear();
    this.itemArchives.clear();

    const ledgerRows = await pool<LedgerRow[]>`
      SELECT name, schema_json, milestone_counter, item_counter
      FROM ledgers WHERE project_key = ${pk} ORDER BY name
    `;
    for (const lr of ledgerRows) {
      this.ledgers.set(lr.name, {
        id: lr.name,
        schema: JSON.parse(lr.schema_json) as LedgerSchema,
        counters: { milestone: lr.milestone_counter, item: lr.item_counter },
        milestones: [],
        archivePointers: [],
      });
    }

    // ledger -> (groupId -> items[]) so items land in their group in row order.
    const groupIndex = new Map<string, Map<string, Item[]>>();
    const groupRows = await pool<GroupRow[]>`
      SELECT ledger, id, title, description
      FROM groups WHERE project_key = ${pk} ORDER BY ledger, seq
    `;
    for (const g of groupRows) {
      const ledger = this.ledgers.get(g.ledger);
      if (ledger === undefined) continue;
      const items: Item[] = [];
      ledger.milestones.push({ id: g.id, title: g.title, description: g.description, items });
      let byGroup = groupIndex.get(g.ledger);
      if (byGroup === undefined) {
        byGroup = new Map();
        groupIndex.set(g.ledger, byGroup);
      }
      byGroup.set(g.id, items);
    }

    const itemRows = await pool<ItemRow[]>`
      SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM items WHERE project_key = ${pk} ORDER BY ledger, seq
    `;
    for (const ir of itemRows) {
      const arr = groupIndex.get(ir.ledger)?.get(ir.milestone_id);
      if (arr === undefined) {
        // Fail fast: an item row referencing a group with no groups row is a
        // writer defect (parity with SqliteLedgerStore.loadLedger).
        throw new LedgerError(
          `ledger ${ir.ledger}: item ${ir.id} references a milestone-group with no groups row`,
        );
      }
      arr.push(rowToItem(ir));
    }

    const pointerRows = await pool<PointerRow[]>`
      SELECT ledger, id, summary, title, status
      FROM archive_pointers WHERE project_key = ${pk} ORDER BY ledger, seq
    `;
    for (const p of pointerRows) {
      const ledger = this.ledgers.get(p.ledger);
      if (ledger === undefined) continue;
      ledger.archivePointers.push({
        id: p.id,
        path: `./archive/${p.ledger}/${p.id}.md`,
        summary: p.summary,
        title: p.title,
        status: p.status,
      });
    }

    const archivedRows = await pool<ArchivedItemRow[]>`
      SELECT ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM archived_items WHERE project_key = ${pk} ORDER BY ledger, seq
    `;
    for (const ar of archivedRows) {
      this.absorbArchivedRow(ar);
    }
  }

  /** Place one archived_items row into the archive cache maps. */
  private absorbArchivedRow(ar: ArchivedItemRow): void {
    if (ar.ledger === MILESTONES_LEDGER) {
      this.itemArchives.set(`${MILESTONES_LEDGER}/${ar.pointer_id}`, rowToItem(ar));
      return;
    }
    const key = `${ar.ledger}/${ar.pointer_id}`;
    let group = this.archives.get(key);
    if (group === undefined) {
      group = { id: ar.pointer_id, title: "", description: "", items: [] };
      this.archives.set(key, group);
    }
    group.items.push(rowToItem(ar));
  }

  async dispose(): Promise<void> {
    if (this.handle !== null) {
      await this.handle.close();
      this.handle = null;
    }
    this.ledgers.clear();
    this.archives.clear();
    this.itemArchives.clear();
    this.mutexes.clear();
    this.initialised = false;
  }

  // ---------------------------------------------------------------------------
  // Log artifacts (T575, Q274/Q285) — the tenant-keyed `logs` table (T572
  // schema) is this store's analogue of the xdg backend's out-of-tree logsDir.
  // ---------------------------------------------------------------------------

  /**
   * Bounded read of a log artifact from the tenant-keyed `logs` table — the
   * Postgres analogue of {@link SqliteLedgerStore.readLog}, serving the SAME
   * `ReadLogCapability` contract (main.ts's `readLogOf` duck-typing picks it
   * up unchanged): absolute paths rejected, a leading `.cq/logs/` prefix
   * stripped (sessionLogs/rawLogs store that repo-relative form regardless of
   * backend), a `..` escape rejected, oversized content truncated to
   * {@link MAX_READ_LOG_BYTES} and flagged `truncated: true`. Unlike the
   * filesystem-backed stores there is no symlink/TOCTOU surface to defend
   * against — a `logs` row is either present or it is not.
   */
  async readLog(relPath: string): Promise<ReadLogResult> {
    const rel = this.normalizeLogPath(relPath);
    const rows = await this.pool()<Array<{ content: string }>>`
      SELECT content FROM logs WHERE project_key = ${this.projectKey} AND path = ${rel}
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new LedgerError(`read_log: no log at ${LEDGER_LOGS_RELATIVE_PREFIX}/${rel}`);
    }
    const buf = Buffer.from(row.content, "utf8");
    if (buf.byteLength > MAX_READ_LOG_BYTES) {
      return {
        path: relPath,
        content: buf.subarray(0, MAX_READ_LOG_BYTES).toString("utf8"),
        truncated: true,
      };
    }
    return { path: relPath, content: row.content };
  }

  /**
   * Write one log artifact into the tenant-keyed `logs` table (T575) — the
   * store-side half of `cq log put`'s postgres branch, called AFTER the SAME
   * redaction + strict-JSONL-validation pipeline every other backend runs
   * (logPut.ts). Upserts on `(project_key, path)` so a retried/re-run `log
   * put` overwrites rather than conflicts.
   */
  async putLog(relPath: string, content: string): Promise<void> {
    const rel = this.normalizeLogPath(relPath);
    await this.pool()`
      INSERT INTO logs (project_key, path, content)
      VALUES (${this.projectKey}, ${rel}, ${content})
      ON CONFLICT (project_key, path) DO UPDATE SET content = EXCLUDED.content, created_at = now()
    `;
  }

  /**
   * Enumerate every log artifact this tenant owns (T575, review R690) — the
   * store-supplied logs source `buildBackupDump` (backupExporter.ts) prefers
   * over a filesystem `logsDir` when present, since postgres has no
   * filesystem logs area for `buildBackupDump` to walk. Yields the FULL
   * content alongside each path (unlike `readLog`, which caps at
   * {@link MAX_READ_LOG_BYTES}) so a backup dump is never silently truncated.
   * Scoped strictly by `project_key` — a second tenant's rows are never
   * visible here.
   */
  async *listLogs(): AsyncIterable<{ path: string; content: string }> {
    const rows = await this.pool()<Array<{ path: string; content: string }>>`
      SELECT path, content FROM logs WHERE project_key = ${this.projectKey} ORDER BY path
    `;
    for (const row of rows) {
      yield { path: row.path, content: row.content };
    }
  }

  /**
   * List every registered tenant in the `projects` table (T585 / Q284) — the
   * genuine multi-tenant `list_projects` answer, duck-typed by
   * `listProjectsOf` (ledger-mcp/main.ts) exactly like `readLog`/`listLogs`
   * above. Ordered by `display_name` for a stable, human-friendly listing;
   * scoped to NO tenant (unlike every other query on this store) since
   * listing every project IS the point.
   */
  async listProjects(): Promise<ListProjectsResult> {
    const rows = await this.pool()<
      Array<{ project_key: string; display_name: string; created_at: string }>
    >`
      SELECT project_key, display_name, created_at::text AS created_at
      FROM projects
      ORDER BY display_name
    `;
    return {
      projects: rows.map((row) => ({
        key: row.project_key,
        displayName: row.display_name,
        createdAt: row.created_at,
      })),
    };
  }

  /**
   * Normalize + confine a log path exactly like
   * {@link SqliteLedgerStore.readLog} (absolute rejected, a leading
   * `.cq/logs/` prefix stripped, a `..` escape rejected) — there is no
   * filesystem/symlink surface here, so containment reduces to a lexical
   * check on the normalized POSIX path.
   */
  private normalizeLogPath(relPath: string): string {
    if (path.isAbsolute(relPath) || path.posix.isAbsolute(relPath)) {
      throw new LedgerError(`read_log: absolute paths are not allowed: ${relPath}`);
    }
    const stripped = relPath.replace(LEDGER_LOGS_STRIP_RE, "");
    const normalized = path.posix.normalize(stripped);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new LedgerError(
        `read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`,
      );
    }
    return normalized;
  }

  // ---------------------------------------------------------------------------
  // Reads (synchronous, from the in-memory cache — parity with InMemoryLedgerStore)
  // ---------------------------------------------------------------------------

  enumerate(): string[] {
    this.assertInit();
    return Array.from(this.ledgers.keys()).sort();
  }

  fetch(ledgerId: string): FetchedLedger {
    return materialiseFetchedLedger(this.getLedger(ledgerId), this.getLedger(MILESTONES_LEDGER));
  }

  fetchItem(ledgerId: string, itemId: string): Item {
    return cloneItem(findItem(this.getLedger(ledgerId), itemId).item);
  }

  search(ledgerId: string, query: string): Item[] {
    return searchItems(this.getLedger(ledgerId), query).map(cloneItem);
  }

  async ftsSearch(query: string, opts: FtsSearchOpts = {}): Promise<FtsSearchHit[]> {
    this.assertInit();
    return this.searchIndex
      .searchQuery(query, opts)
      .map((h) => ({ ...h, item: cloneItem(h.item) }));
  }

  fetchMilestone(milestoneId: string): FetchedMilestoneItem {
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const resolved = resolveMilestoneView(milestonesLedger, milestoneId);
    if (resolved === null) {
      throw new LedgerError(`milestone ${milestoneId} not found`);
    }
    const item = findItem(milestonesLedger, milestoneId).item;
    return { milestone: cloneItem(item), resolved, references: this.countReferences(milestoneId) };
  }

  listMilestoneItems(milestoneId: string): Record<string, Item[]> {
    this.assertInit();
    const out: Record<string, Item[]> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined || group.items.length === 0) continue;
      out[name] = group.items.map(cloneItem);
    }
    return out;
  }

  snapshot(): LedgerSnapshot {
    this.assertInit();
    return buildSnapshot(this.enumerate().map((name) => this.fetch(name)));
  }

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    this.assertInit();
    const key = `${ledgerId}/${archiveId}`;
    if (ledgerId === MILESTONES_LEDGER) {
      const item = this.itemArchives.get(key);
      if (item === undefined) {
        throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
      }
      return { kind: "item", item: cloneItem(item) };
    }
    const m = this.archives.get(key);
    if (m === undefined) {
      throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
    }
    return { kind: "group", milestone: cloneMilestone(m) };
  }

  // ---------------------------------------------------------------------------
  // Mutations (async write-through: apply* against a clone → persist affected
  // rows to PG in one transaction → swap clone into cache post-commit → rebuild
  // index → fire onMutation → NOTIFY). Every mutation runs under the same
  // per-ledger / global-milestones AsyncMutex discipline as InMemoryLedgerStore
  // so within-instance ordering (and the concurrency-parity suite) holds; the
  // PG transaction provides cross-process isolation.
  // ---------------------------------------------------------------------------

  async updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      let out!: Item;
      let mutated!: Ledger;
      await writeTransaction(this.pool(), async (tx) => {
        const clone = cloneLedger(this.getLedger(MILESTONES_LEDGER));
        const x = applyUpdateMilestoneItem(
          clone,
          milestoneId,
          patch,
          this.now(),
          this.buildRefValidationContext(),
        );
        await this.persistItemRow(tx, MILESTONES_LEDGER, x);
        out = cloneItem(x);
        mutated = clone;
      });
      this.ledgers.set(MILESTONES_LEDGER, mutated);
      return out;
    });
    await this.afterCommit(MILESTONES_LEDGER, "update", false);
    return item;
  }

  async updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item> {
    const item = await this.withLock(ledgerId, async () => {
      let out!: Item;
      let mutated!: Ledger;
      await writeTransaction(this.pool(), async (tx) => {
        const clone = cloneLedger(this.getLedger(ledgerId));
        const precondition = this.statusChangePrecondition(ledgerId, clone, itemId, patch);
        const x = applyUpdateItem(
          clone,
          itemId,
          patch,
          this.now(),
          precondition,
          this.buildRefValidationContext(),
        );
        await this.persistItemRow(tx, ledgerId, x);
        out = cloneItem(x);
        mutated = clone;
      });
      this.ledgers.set(ledgerId, mutated);
      return out;
    });
    await this.afterCommit(ledgerId, "update", false);
    return item;
  }

  async createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
      );
    }
    // Global milestones lock first (strict-existence check reads the milestones
    // ledger), then the per-ledger lock — consistent __milestones__-first order
    // with archiveMilestone, so no cyclic deadlock.
    const item = await this.withMilestonesLock(async () => {
      assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      return this.withLock(ledgerId, async () => {
        let out!: Item;
        let mutated!: Ledger;
        await writeTransaction(this.pool(), async (tx) => {
          const clone = cloneLedger(this.getLedger(ledgerId));
          const refCtx = this.buildRefValidationContext();
          const x = await this.insertItemViaCore(tx, clone, init.id, (l) =>
            applyCreateItem(l, milestoneId, init, this.now(), refCtx),
          );
          out = cloneItem(x);
          mutated = clone;
        });
        this.ledgers.set(ledgerId, mutated);
        return out;
      });
    });
    await this.afterCommit(ledgerId, "create", false);
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      let out!: Item;
      let mutated!: Ledger;
      await writeTransaction(this.pool(), async (tx) => {
        const clone = cloneLedger(this.getLedger(MILESTONES_LEDGER));
        const refCtx = this.buildRefValidationContext();
        const x = await this.insertItemViaCore(tx, clone, init.id, (l) =>
          applyCreateMilestoneItem(l, init, this.now(), refCtx),
        );
        out = cloneItem(x);
        mutated = clone;
      });
      this.ledgers.set(MILESTONES_LEDGER, mutated);
      return out;
    });
    await this.afterCommit(MILESTONES_LEDGER, "create", false);
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(`ledger name "${MILESTONES_LEDGER}" is reserved`);
    }
    if (!LEDGER_NAME_RE.test(name)) {
      throw new LedgerError(`invalid ledger name "${name}": only A-Za-z0-9_- are allowed`);
    }
    validateSchema(schema);
    const pk = this.projectKey;
    // Review r1 fix: the registry-level mutex serializes the cache-read
    // validation (duplicate name, Q-CANL-8 prefix uniqueness) with the awaited
    // INSERT + cache set, so two concurrent in-instance createLedger calls
    // cannot both pass validation against the pre-INSERT cache.
    const view = await this.mutexFor(REGISTRY_MUTEX_KEY).run(async () => {
      if (this.ledgers.has(name)) throw new DuplicateIdError("ledger", name);
      // Prefix uniqueness gives global item-id uniqueness (Q-CANL-8).
      assertPrefixUnique(
        name,
        schema,
        Array.from(this.ledgers.values(), (l) => ({ name: l.id, schema: l.schema })),
      );
      await writeTransaction(this.pool(), async (tx) => {
        await tx`
          INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
          VALUES (${pk}, ${name}, ${JSON.stringify(schema)}, 0, 0)
        `;
      });
      const ledger: Ledger = {
        id: name,
        schema,
        counters: { milestone: 0, item: 0 },
        milestones: [],
        archivePointers: [],
      };
      this.ledgers.set(name, ledger);
      return materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
    });
    await this.afterCommit(name, "create", false);
    return view;
  }

  async reopenItem(ledgerId: string, itemId: string, toStatus: string): Promise<Item> {
    const item = await this.withLock(ledgerId, async () => {
      let out!: Item;
      let mutated!: Ledger;
      await writeTransaction(this.pool(), async (tx) => {
        const clone = cloneLedger(this.getLedger(ledgerId));
        const x = applyReopenItem(clone, itemId, toStatus, this.now());
        await this.persistItemRow(tx, ledgerId, x);
        out = cloneItem(x);
        mutated = clone;
      });
      this.ledgers.set(ledgerId, mutated);
      return out;
    });
    await this.afterCommit(ledgerId, "update", false);
    return item;
  }

  async unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
  ): Promise<Item> {
    const isMilestones = ledgerId === MILESTONES_LEDGER;
    const pk = this.projectKey;
    const reattached = await this.withLock(ledgerId, async () => {
      let out!: Item;
      let mutated!: Ledger;
      // Prepared OUTSIDE the transaction body so the post-commit archive-map
      // update can apply the same delta; recomputed on the (rare) retry.
      let dropGroupArchive = false;
      await writeTransaction(this.pool(), async (tx) => {
        dropGroupArchive = false;
        const clone = cloneLedger(this.getLedger(ledgerId));
        const key = `${ledgerId}/${milestoneId}`;
        let archivedItem: Item;
        if (isMilestones) {
          const it = this.itemArchives.get(key);
          if (it === undefined || it.id !== itemId) {
            throw new LedgerError(
              `no archived item ${itemId} under milestone ${milestoneId} in ledger ${ledgerId}`,
            );
          }
          archivedItem = it;
        } else {
          const group = this.archives.get(key);
          if (group === undefined) {
            throw new LedgerError(
              `no archived group for milestone ${milestoneId} in ledger ${ledgerId}`,
            );
          }
          const found = group.items.find((i) => i.id === itemId);
          if (found === undefined) {
            throw new LedgerError(
              `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
            );
          }
          archivedItem = found;
          dropGroupArchive = group.items.length === 1;
        }
        const groupsBefore = new Set(clone.milestones.map((m) => m.id));
        const attachId = isMilestones ? archivedItem.milestoneId : milestoneId;
        const x = applyReattachItem(clone, attachId, archivedItem, this.now());
        if (!groupsBefore.has(x.milestoneId)) {
          await tx`
            INSERT INTO groups (project_key, ledger, id, title, description)
            VALUES (${pk}, ${ledgerId}, ${x.milestoneId}, '', '')
          `;
        }
        await this.insertActiveRow(tx, ledgerId, x);
        await tx`
          DELETE FROM archived_items
          WHERE project_key = ${pk} AND ledger = ${ledgerId} AND pointer_id = ${milestoneId} AND id = ${itemId}
        `;
        if (isMilestones || dropGroupArchive) {
          await tx`
            DELETE FROM archive_pointers
            WHERE project_key = ${pk} AND ledger = ${ledgerId} AND id = ${milestoneId}
          `;
        }
        out = cloneItem(x);
        mutated = clone;
      });
      // Post-commit cache update: swap the ledger, drop the reattached item from
      // the archive map, drop the pointer + group archive when emptied.
      this.ledgers.set(ledgerId, mutated);
      const key = `${ledgerId}/${milestoneId}`;
      if (isMilestones) {
        this.itemArchives.delete(key);
        this.removeArchivePointer(ledgerId, milestoneId);
      } else {
        const group = this.archives.get(key);
        if (group !== undefined) {
          const idx = group.items.findIndex((i) => i.id === itemId);
          if (idx >= 0) group.items.splice(idx, 1);
          if (group.items.length === 0) {
            this.archives.delete(key);
            this.removeArchivePointer(ledgerId, milestoneId);
          }
        }
      }
      return out;
    });
    await this.afterCommit(ledgerId, "update", true);
    return reattached;
  }

  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    if (milestoneId === MILESTONES_ACTIVE_GROUP_ID) {
      throw new BootstrapViolationError(
        `the bootstrap group ${MILESTONES_ACTIVE_GROUP_ID} cannot be archived`,
      );
    }
    if (milestoneId === MILESTONES_AMBIENT_ID) {
      throw new BootstrapViolationError(
        `${MILESTONES_AMBIENT_ID} is immortal and cannot be archived`,
      );
    }
    const pk = this.projectKey;
    let participating: string[] = [];
    let pointer!: ArchivePointer;

    await this.withMilestonesLock(async () => {
      const otherIds = Array.from(this.ledgers.keys())
        .filter((n) => n !== MILESTONES_LEDGER)
        .sort();
      await this.withLocksInOrder(otherIds, async () => {
        // Hoisted so the post-commit cache update sees the detached data;
        // recomputed each (rare) transaction retry.
        let msClone!: Ledger;
        let detachedItem!: Item;
        let detachedGroups!: Map<string, { clone: Ledger; items: Item[] }>;
        let localParticipating: string[] = [];

        await writeTransaction(this.pool(), async (tx) => {
          localParticipating = [];
          detachedGroups = new Map();
          msClone = cloneLedger(this.getLedger(MILESTONES_LEDGER));

          // D101: locate the milestone item in msClone's active group and
          // compute msTitle/msStatus BEFORE calling applyDetachMilestoneItem —
          // that function stamps the passed title/status directly onto the
          // ArchivePointer it pushes into msClone.archivePointers, so
          // computing them from its *return value* (as before) is too late:
          // the cached pointer had already been pushed with the placeholder
          // "" / "" args. Mirrors InMemoryLedgerStore.performArchive.
          const activeGroup = msClone.milestones.find(
            (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
          );
          const milestoneItem = activeGroup?.items.find((it) => it.id === milestoneId);
          const msTitle =
            typeof milestoneItem?.fields["title"] === "string" ? milestoneItem.fields["title"] : "";
          const msStatus = milestoneItem?.status ?? "";

          // Detach the milestone-ITEM: verifies it exists + is terminal
          // (throws MilestoneItemNotFoundError / NonTerminalItemsError before
          // any mutation).
          const { item: msItem } = applyDetachMilestoneItem(
            msClone,
            milestoneId,
            summary,
            `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
            msTitle,
            msStatus,
          );
          detachedItem = msItem;

          // Detach each participating non-milestones group (verifies every item
          // terminal → NonTerminalItemsError before splice). Clones are
          // throwaway until commit, so a throw here leaves the cache untouched
          // (D10 no-partial-archive).
          for (const name of otherIds) {
            const clone = cloneLedger(this.getLedger(name));
            if (!clone.milestones.some((m) => m.id === milestoneId)) continue;
            localParticipating.push(name);
            const { milestone } = applyDetachMilestoneGroup(
              clone,
              milestoneId,
              summary,
              `./archive/${name}/${milestoneId}.md`,
              msTitle,
              msStatus,
            );
            detachedGroups.set(name, { clone, items: milestone.items });
          }

          const nowTs = this.now();
          // Persist each participating group's archive + drop its active rows.
          for (const name of localParticipating) {
            await tx`
              INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
              VALUES (${pk}, ${name}, ${milestoneId}, ${summary}, ${msTitle}, ${msStatus}, ${nowTs})
            `;
            for (const it of detachedGroups.get(name)?.items ?? []) {
              await this.insertArchivedRow(tx, name, milestoneId, it);
            }
            await tx`DELETE FROM items WHERE project_key = ${pk} AND ledger = ${name} AND milestone_id = ${milestoneId}`;
            await tx`DELETE FROM groups WHERE project_key = ${pk} AND ledger = ${name} AND id = ${milestoneId}`;
          }

          // Persist the milestone-item's own archive + drop its active row.
          await tx`
            INSERT INTO archive_pointers (project_key, ledger, id, summary, title, status, archived_at)
            VALUES (${pk}, ${MILESTONES_LEDGER}, ${milestoneId}, ${summary}, ${msTitle}, ${msStatus}, ${nowTs})
          `;
          await this.insertArchivedRow(tx, MILESTONES_LEDGER, milestoneId, msItem);
          await tx`DELETE FROM items WHERE project_key = ${pk} AND ledger = ${MILESTONES_LEDGER} AND id = ${milestoneId}`;

          pointer = {
            id: milestoneId,
            path: `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
            summary,
            title: msTitle,
            status: msStatus,
          };
        });

        // Post-commit cache update: swap detached clones in, populate archive maps.
        participating = localParticipating;
        for (const name of participating) {
          const entry = detachedGroups.get(name);
          if (entry === undefined) continue;
          this.ledgers.set(name, entry.clone);
          this.archives.set(`${name}/${milestoneId}`, {
            id: milestoneId,
            title: "",
            description: "",
            items: entry.items.map(cloneItem),
          });
        }
        this.ledgers.set(MILESTONES_LEDGER, msClone);
        this.itemArchives.set(`${MILESTONES_LEDGER}/${milestoneId}`, cloneItem(detachedItem));
      });
    });

    // Rebuild indices + fire hooks in D-COHERENCE order (participants
    // alphabetic, then milestones), then NOTIFY once.
    for (const name of participating) {
      this.rebuildLedgerIndexActive(name);
      this.refreshLedgerIndexArchived(name);
    }
    this.rebuildLedgerIndexActive(MILESTONES_LEDGER);
    this.refreshLedgerIndexArchived(MILESTONES_LEDGER);
    for (const name of participating) this.fireHook(name, "archive");
    this.fireHook(MILESTONES_LEDGER, "archive");
    await this.notify();
    return pointer;
  }

  /**
   * Re-read `ledgerId`'s rows from Postgres into the cache under its per-ledger
   * lock (the T578 LISTEN watcher's refresh path). No-op for an unknown ledger
   * id (graceful — drop any stale index docs), matching the interface contract.
   */
  async invalidate(ledgerId: string): Promise<void> {
    this.assertInit();
    if (!this.ledgers.has(ledgerId)) {
      this.searchIndex.removeLedger(ledgerId);
      return;
    }
    await this.withLock(ledgerId, async () => {
      await this.reloadLedger(ledgerId);
    });
  }

  // ---------------------------------------------------------------------------
  // Internals — write path
  // ---------------------------------------------------------------------------

  /**
   * Shared createItem/createMilestone write path (parity with
   * SqliteLedgerStore.insertItemViaCore, async form). On the AUTO-id path the
   * id is allocated by an in-transaction `UPDATE ledgers … RETURNING` counter
   * bump ({@link allocateItemId}) so cross-instance allocation never collides;
   * the pure `apply*` helper then re-derives the SAME id from `counter - 1`
   * while running the full guard set, and any divergence throws (rolling back).
   * On the caller-supplied-id path the counter is persisted only when `apply*`
   * bumped it past the supplied numeric id.
   */
  private async insertItemViaCore(
    tx: SQL,
    ledger: Ledger,
    suppliedId: string | undefined,
    apply: (ledger: Ledger) => Item,
  ): Promise<Item> {
    const groupsBefore = new Set(ledger.milestones.map((m) => m.id));
    const counterBefore = ledger.counters.item;
    let expected: { id: string; counter: number } | null = null;
    if (suppliedId === undefined) {
      expected = await this.allocateItemId(tx, ledger.id, effectiveIdPrefix(ledger.id, ledger.schema));
      ledger.counters.item = expected.counter - 1; // applyCreateItem pre-increments
    }
    const item = apply(ledger);
    if (
      expected !== null &&
      (item.id !== expected.id || ledger.counters.item !== expected.counter)
    ) {
      throw new LedgerError(
        `PostgresLedgerStore: id allocation diverged (sql ${expected.id}/${expected.counter}, core ${item.id}/${ledger.counters.item})`,
      );
    }
    if (!groupsBefore.has(item.milestoneId)) {
      // ON CONFLICT DO NOTHING (parity with runBootstrapWrites' milestones-group
      // provisioning): `groupsBefore` is this INSTANCE's in-memory cache, so two
      // DIFFERENT processes racing to be first to write into a brand-new
      // milestoneId's group both see it missing and both attempt this INSERT —
      // a genuine cross-process race the K102 multi-writer stress harness
      // (T576) surfaced as an unhandled unique-violation (23505, not a
      // serialization failure, so withSerializationRetry never saw it).
      await tx`
        INSERT INTO groups (project_key, ledger, id, title, description)
        VALUES (${this.projectKey}, ${ledger.id}, ${item.milestoneId}, '', '')
        ON CONFLICT DO NOTHING
      `;
    }
    await this.insertActiveRow(tx, ledger.id, item);
    if (expected === null && ledger.counters.item !== counterBefore) {
      await tx`
        UPDATE ledgers SET item_counter = ${ledger.counters.item}
        WHERE project_key = ${this.projectKey} AND name = ${ledger.id}
      `;
    }
    return item;
  }

  /**
   * Allocate the next auto item id for `ledgerId`: an atomic
   * `UPDATE … item_counter + 1 … RETURNING` inside the surrounding write
   * transaction, with a dup-avoid loop past ids parked on by caller-supplied
   * ones (parity with SqliteLedgerStore.allocateItemId).
   */
  private async allocateItemId(
    tx: SQL,
    ledgerId: string,
    prefix: string,
  ): Promise<{ id: string; counter: number }> {
    for (;;) {
      const rows = await tx<Array<{ item_counter: number }>>`
        UPDATE ledgers SET item_counter = item_counter + 1
        WHERE project_key = ${this.projectKey} AND name = ${ledgerId}
        RETURNING item_counter
      `;
      const row = rows[0];
      if (row === undefined) throw new LedgerNotFoundError(ledgerId);
      const id = prefix + String(row.item_counter);
      const exists = await tx<Array<{ one: number }>>`
        SELECT 1 AS one FROM items
        WHERE project_key = ${this.projectKey} AND ledger = ${ledgerId} AND id = ${id} LIMIT 1
      `;
      if (exists.length === 0) return { id, counter: row.item_counter };
    }
  }

  /** INSERT one active `items` row. */
  private async insertActiveRow(tx: SQL, ledgerId: string, item: Item): Promise<void> {
    await tx`
      INSERT INTO items (project_key, ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
      VALUES (${this.projectKey}, ${ledgerId}, ${item.id}, ${item.milestoneId}, ${item.status},
              ${JSON.stringify(item.fields)}, ${item.createdAt}, ${item.updatedAt},
              ${item.author ?? null}, ${item.session ?? null})
    `;
  }

  /** INSERT one `archived_items` row under `pointerId`. */
  private async insertArchivedRow(
    tx: SQL,
    ledgerId: string,
    pointerId: string,
    item: Item,
  ): Promise<void> {
    await tx`
      INSERT INTO archived_items (project_key, ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
      VALUES (${this.projectKey}, ${ledgerId}, ${pointerId}, ${item.id}, ${item.milestoneId}, ${item.status},
              ${JSON.stringify(item.fields)}, ${item.createdAt}, ${item.updatedAt},
              ${item.author ?? null}, ${item.session ?? null})
    `;
  }

  /** UPDATE an existing item's mutable columns (status/fields/updatedAt/provenance). */
  private async persistItemRow(tx: SQL, ledgerId: string, item: Item): Promise<void> {
    await tx`
      UPDATE items
      SET status = ${item.status}, fields_json = ${JSON.stringify(item.fields)},
          updated_at = ${item.updatedAt}, author = ${item.author ?? null}, session = ${item.session ?? null}
      WHERE project_key = ${this.projectKey} AND ledger = ${ledgerId} AND id = ${item.id}
    `;
  }

  /**
   * Build the optional `StatusChangePrecondition` for an `updateItem` (parity
   * with InMemoryLedgerStore.statusChangePrecondition — F2 goal-phase + D29
   * questions-answer). Cross-ledger inputs come from the cache; the goals rule
   * reads the current questions/decisions ledgers, the questions rule the item
   * under mutation (in `ledger`, the clone).
   */
  private statusChangePrecondition(
    ledgerId: string,
    ledger: Ledger,
    itemId: string,
    patch: UpdateItemPatch,
  ): StatusChangePrecondition | undefined {
    if (ledgerId === GOALS_LEDGER) {
      return (from: string, to: string): void =>
        assertGoalPhasePreconditions(
          itemId,
          from,
          to,
          this.ledgers.get(QUESTIONS_LEDGER),
          this.ledgers.get(DECISIONS_LEDGER),
        );
    }
    if (ledgerId === QUESTIONS_LEDGER) {
      return (from: string, to: string): void => {
        const { item } = findItem(ledger, itemId);
        const effectiveAnswer =
          patch.fields?.[QUESTIONS_ANSWER_FIELD] ?? item.fields[QUESTIONS_ANSWER_FIELD];
        assertQuestionAnswerPrecondition(itemId, from, to, effectiveAnswer);
      };
    }
    return undefined;
  }

  /**
   * Cross-ledger {@link RefValidationContext} (G80/M245): prefix registry +
   * active existence from the cache, archived existence from the archive maps
   * (parity with InMemoryLedgerStore.buildRefValidationContext).
   */
  private buildRefValidationContext(): RefValidationContext {
    const registry = buildPrefixRegistry(
      [...this.ledgers].map(([name, l]) => ({ name, schema: l.schema })),
    );
    return {
      registry,
      refExists: (ledger: string, id: string): boolean => {
        const l = this.ledgers.get(ledger);
        if (l !== undefined) {
          for (const m of l.milestones) for (const it of m.items) if (it.id === id) return true;
        }
        if (ledger === MILESTONES_LEDGER && this.itemArchives.has(`${MILESTONES_LEDGER}/${id}`)) {
          return true;
        }
        for (const [key, group] of this.archives) {
          if (!key.startsWith(`${ledger}/`)) continue;
          for (const it of group.items) if (it.id === id) return true;
        }
        return false;
      },
    };
  }

  /**
   * Post-commit tail shared by every mutation: rebuild the affected ledger's
   * ACTIVE index bucket (and, when `alsoArchived`, its ARCHIVED bucket), fire
   * the guarded `onMutation` hook, then NOTIFY the coherence channel. Runs
   * strictly AFTER the write transaction COMMITs and the cache is updated.
   */
  private async afterCommit(
    ledgerId: string,
    op: LedgerMutationOp,
    alsoArchived: boolean,
  ): Promise<void> {
    this.rebuildLedgerIndexActive(ledgerId);
    if (alsoArchived) this.refreshLedgerIndexArchived(ledgerId);
    this.fireHook(ledgerId, op);
    await this.notify();
  }

  /** Guarded `onMutation` fire (a throw is logged, never unwinds the write). */
  private fireHook(ledgerId: string, op: LedgerMutationOp): void {
    if (this.onMutation === null) return;
    try {
      this.onMutation(ledgerId, op);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `PostgresLedgerStore: onMutation hook threw for ${ledgerId} (${op}): ${msg}\n`,
      );
    }
  }

  /** Guarded post-commit `NOTIFY` (the T578 LISTEN watcher consumes it). */
  private async notify(): Promise<void> {
    if (this.handle === null) return;
    try {
      await notifyProjectChanged(this.handle, this.projectKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`PostgresLedgerStore: NOTIFY threw for ${this.projectKey}: ${msg}\n`);
    }
  }

  /** Rebuild the ACTIVE index bucket for a ledger from the cache. Guarded. */
  private rebuildLedgerIndexActive(ledgerId: string): void {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      const items: Item[] = [];
      for (const m of ledger.milestones) for (const it of m.items) items.push(it);
      this.searchIndex.rebuildLedgerActive(ledgerId, items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`PostgresLedgerStore: FTS active-rebuild threw for ${ledgerId}: ${msg}\n`);
    }
  }

  /** Rebuild the ARCHIVED index bucket for a ledger from the archive maps. Guarded. */
  private refreshLedgerIndexArchived(ledgerId: string): void {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      const items: Item[] = [];
      for (const ptr of ledger.archivePointers) {
        const key = `${ledgerId}/${ptr.id}`;
        if (ledgerId === MILESTONES_LEDGER) {
          const it = this.itemArchives.get(key);
          if (it !== undefined) items.push(it);
        } else {
          const group = this.archives.get(key);
          if (group !== undefined) items.push(...group.items);
        }
      }
      this.searchIndex.setLedgerArchived(ledgerId, items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `PostgresLedgerStore: FTS archived-refresh threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /** Re-read one ledger's rows from PG into the cache (invalidate refresh path). */
  private async reloadLedger(ledgerId: string): Promise<void> {
    const pool = this.pool();
    const pk = this.projectKey;
    const lr = (
      await pool<LedgerRow[]>`
        SELECT name, schema_json, milestone_counter, item_counter
        FROM ledgers WHERE project_key = ${pk} AND name = ${ledgerId}
      `
    )[0];
    // Drop the ledger's stale archive-map entries either way.
    for (const key of [...this.archives.keys()]) {
      if (key.startsWith(`${ledgerId}/`)) this.archives.delete(key);
    }
    for (const key of [...this.itemArchives.keys()]) {
      if (key.startsWith(`${ledgerId}/`)) this.itemArchives.delete(key);
    }
    if (lr === undefined) {
      this.ledgers.delete(ledgerId);
      this.searchIndex.removeLedger(ledgerId);
      return;
    }
    const ledger: Ledger = {
      id: ledgerId,
      schema: JSON.parse(lr.schema_json) as LedgerSchema,
      counters: { milestone: lr.milestone_counter, item: lr.item_counter },
      milestones: [],
      archivePointers: [],
    };
    const groupIndex = new Map<string, Item[]>();
    const groupRows = await pool<GroupRow[]>`
      SELECT ledger, id, title, description
      FROM groups WHERE project_key = ${pk} AND ledger = ${ledgerId} ORDER BY seq
    `;
    for (const g of groupRows) {
      const items: Item[] = [];
      ledger.milestones.push({ id: g.id, title: g.title, description: g.description, items });
      groupIndex.set(g.id, items);
    }
    const itemRows = await pool<ItemRow[]>`
      SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM items WHERE project_key = ${pk} AND ledger = ${ledgerId} ORDER BY seq
    `;
    for (const ir of itemRows) {
      const arr = groupIndex.get(ir.milestone_id);
      if (arr === undefined) {
        throw new LedgerError(
          `ledger ${ledgerId}: item ${ir.id} references a milestone-group with no groups row`,
        );
      }
      arr.push(rowToItem(ir));
    }
    const pointerRows = await pool<PointerRow[]>`
      SELECT ledger, id, summary, title, status
      FROM archive_pointers WHERE project_key = ${pk} AND ledger = ${ledgerId} ORDER BY seq
    `;
    for (const p of pointerRows) {
      ledger.archivePointers.push({
        id: p.id,
        path: `./archive/${ledgerId}/${p.id}.md`,
        summary: p.summary,
        title: p.title,
        status: p.status,
      });
    }
    this.ledgers.set(ledgerId, ledger);
    const archivedRows = await pool<ArchivedItemRow[]>`
      SELECT ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM archived_items WHERE project_key = ${pk} AND ledger = ${ledgerId} ORDER BY seq
    `;
    for (const ar of archivedRows) this.absorbArchivedRow(ar);
    this.rebuildLedgerIndexActive(ledgerId);
    this.refreshLedgerIndexArchived(ledgerId);
  }

  // ---------------------------------------------------------------------------
  // Internals — cache + locks (parity with InMemoryLedgerStore)
  // ---------------------------------------------------------------------------

  private countReferences(milestoneId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group !== undefined && group.items.length > 0) out[name] = group.items.length;
    }
    return out;
  }

  private removeArchivePointer(ledgerId: string, archiveId: string): void {
    const ledger = this.ledgers.get(ledgerId);
    if (ledger === undefined) return;
    const i = ledger.archivePointers.findIndex((p) => p.id === archiveId);
    if (i >= 0) ledger.archivePointers.splice(i, 1);
  }

  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ledgers.has(ledgerId)) throw new LedgerNotFoundError(ledgerId);
    return this.mutexFor(ledgerId).run(fn);
  }

  private async withMilestonesLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutexFor(MILESTONES_MUTEX_KEY).run(fn);
  }

  private async withLocksInOrder<T>(ledgerIds: string[], fn: () => Promise<T>): Promise<T> {
    if (ledgerIds.length === 0) return fn();
    const [head, ...tail] = ledgerIds;
    if (head === undefined) return fn();
    return this.withLock(head, () => this.withLocksInOrder(tail, fn));
  }

  private mutexFor(key: string): AsyncMutex {
    // Review r1 fix: EVERY milestones-ledger mutation serializes on the SAME
    // __milestones__ mutex. Without this normalization, withLock("milestones")
    // (reopenItem/unarchiveItem/updateItem on the milestones ledger) and
    // withMilestonesLock (createMilestone/updateMilestone/archiveMilestone)
    // would guard the SAME cached Ledger object with TWO different mutexes:
    // both writers clone the same base, AWAIT their network write transaction,
    // and the last post-commit cache swap discards the other's committed write.
    // No deadlock results: no code path acquires a per-ledger lock before the
    // milestones lock (createItem/archiveMilestone take __milestones__ FIRST,
    // and createItem refuses ledgerId === milestones outright).
    const normalized = key === MILESTONES_LEDGER ? MILESTONES_MUTEX_KEY : key;
    let m = this.mutexes.get(normalized);
    if (m === undefined) {
      m = new AsyncMutex();
      this.mutexes.set(normalized, m);
    }
    return m;
  }

  private getLedger(ledgerId: string): Ledger {
    this.assertInit();
    const l = this.ledgers.get(ledgerId);
    if (l === undefined) throw new LedgerNotFoundError(ledgerId);
    return l;
  }

  private pool(): SQL {
    if (this.handle === null) {
      throw new LedgerError("PostgresLedgerStore: pool is closed");
    }
    return this.handle;
  }

  private assertInit(): void {
    if (!this.initialised) throw new LedgerError("PostgresLedgerStore not initialised");
  }
}

/** Deep-clone a Milestone (archive read) — local mirror of InMemory's helper. */
function cloneMilestone(m: Milestone): Milestone {
  return { id: m.id, title: m.title, description: m.description, items: m.items.map(cloneItem) };
}
