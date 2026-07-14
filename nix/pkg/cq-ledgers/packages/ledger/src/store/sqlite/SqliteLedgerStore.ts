/**
 * SqliteLedgerStore — bun:sqlite implementation of `LedgerStore` (G67-C1,
 * T526: init/bootstrap + the synchronous read surface + dispose).
 *
 * Implements the interface DIRECTLY — NOT via AbstractLedgerStore, whose
 * writeLedgerFile → serializeLedger funnel is exactly what K102 forbids for
 * this backend: rows are NORMALIZED (schema.ts), there is no serialized
 * ledger blob and no in-memory ledger cache. bun:sqlite is synchronous, so
 * every ROW read is a fresh query that observes the latest committed WAL
 * state — a peer process's committed write is visible on the very next read
 * with no invalidate round-trip (the K102 coherence model).
 *
 * Composite reads (a ledger view assembled from ledgers/groups/items/
 * archive_pointers rows) run inside a single DEFERRED transaction so a peer
 * commit cannot tear one view.
 *
 * Task split (scope discipline):
 *  - T526: constructor, init() (open + DDL + canonical-ledger
 *    bootstrap + milestones bootstrap group + M-AMBIENT + schema-divergence
 *    detection — the BACKUP action itself lands in T529), the synchronous read surface
 *    (enumerate/fetch/fetchItem/fetchMilestone/listMilestoneItems/snapshot/
 *    search), invalidate() (row reads need none — no-op), dispose().
 *  - T527: mutations (createItem/updateItem/createMilestone/
 *    createLedger/updateMilestone/reopenItem) — each ONE `BEGIN IMMEDIATE`
 *    transaction (bounded busy retry, connection.ts) touching only the
 *    affected rows, with the domain guards REUSED from core.ts.
 *  - T528: the derived search index (ftsSearch) + the
 *    index-refresh half of invalidate() + the post-commit index update in
 *    fireMutation. The index is the SAME in-memory `LedgerSearchIndex` the
 *    fs/in-memory stores use — a derived READ-side projection of the
 *    committed rows (cold-built on init(), one ledger bucket refreshed per
 *    mutation) — so every query semantic (parseQuery qualifiers, fuzzy,
 *    prefix, field boost, matchedFields, limit) is shared verbatim, and no
 *    write ever re-serializes a ledger (K102).
 *  - T529 (this task): archives (archiveMilestone/unarchiveItem/fetchArchive),
 *    row-natively reusing the core.ts detach/reattach guards against a FULL
 *    `Ledger` materialised by `loadLedger` (terminal-item verification,
 *    bootstrap/M-AMBIENT refusal, D-COHERENCE hook-firing order, the derived
 *    index's archived-bucket transition), plus the real schema-divergence
 *    BACKUP action (`VACUUM INTO` a timestamped sibling .db file).
 *  - T530: createLedgerStore xdg wiring.
 *  - T538 (D87): O(1)-in-ledger-size mutations — per-mutation INCREMENTAL
 *    single-doc search-index updates (whole-bucket rebuilds remain only in
 *    init()'s cold build and invalidate()'s cross-process refresh) and a
 *    createItem shim that no longer materialises the whole target ledger.
 */

import * as path from "node:path";
import type { Database } from "bun:sqlite";
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
  ItemNotFoundError,
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
import type { StatusChangePrecondition } from "../core.js";
import { cloneItem, materialiseFetchedLedger } from "../InMemoryLedgerStore.js";
import { LedgerSearchIndex } from "../../search/LedgerSearchIndex.js";
import { schemaCompatible, schemasEqual } from "../schemaCompat.js";
import {
  CANONICAL_LEDGERS,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  QUESTIONS_ANSWER_FIELD,
  QUESTIONS_LEDGER,
} from "../../constants.js";
import { immediateWriteTransaction, openLedgerDb } from "./connection.js";
import { ensureSchema } from "./schema.js";

export interface SqliteLedgerStoreOpts {
  /** Concrete ledger database file path (created on init if absent). */
  dbPath: string;
  /**
   * Returns an ISO 8601 UTC timestamp. Defaults to
   * `() => new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * Fired AFTER every successful write (see {@link OnMutation}) — i.e. after
   * the write transaction COMMITs. Guarded: a throw is logged, never unwinds.
   */
  onMutation?: OnMutation;
  /**
   * Policy for a persisted canonical-ledger schema that diverged from canon
   * (detected at init(), same detection as AbstractLedgerStore via
   * schemasEqual/schemaCompatible):
   *
   * - `'backup-reinit'` (default): the byte-level BACKUP action for this
   *   backend lands in T529 — until then init() throws a clear stub error
   *   instead of silently destroying divergent state.
   * - `'abort'`: refuse to start — throw `BootstrapViolationError` — so the
   *   divergence is loud and operator-handled.
   */
  onSchemaDivergence?: "backup-reinit" | "abort";
}

// --- row shapes (mirror schema.ts DDL) --------------------------------------

interface LedgerRow {
  name: string;
  schema_json: string;
  milestone_counter: number;
  item_counter: number;
}

interface GroupRow {
  id: string;
  title: string;
  description: string;
}

interface ItemRow {
  id: string;
  milestone_id: string;
  status: string;
  fields_json: string;
  created_at: string;
  updated_at: string;
  author: string | null;
  session: string | null;
}

interface PointerRow {
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

/**
 * Allowed shape for a created ledger's name (same rule as
 * AbstractLedgerStore.createLedger): path-safe, no separators.
 */
const LEDGER_NAME_RE = /^[A-Za-z0-9_-]+$/;

export class SqliteLedgerStore implements LedgerStore {
  private readonly dbPath: string;
  private readonly now: () => string;
  /** Fired post-COMMIT by {@link fireMutation}; guarded. */
  protected readonly onMutation: OnMutation | null;
  private readonly onSchemaDivergence: "backup-reinit" | "abort";
  private handle: Database | null = null;
  private initialised = false;
  /**
   * Derived full-text index over the committed item rows (T528) — the SAME
   * `LedgerSearchIndex` the fs/in-memory stores use, so ftsSearch semantics
   * are shared verbatim. Cold-built on init(); each mutation upserts/moves
   * ONLY its own doc post-commit (T538/D87 — O(1), no bucket rebuild); a
   * peer process's commit is folded in by {@link invalidate} (the T530
   * coherence watcher's refresh path), the only post-init full rebuild.
   */
  private readonly searchIndex = new LedgerSearchIndex();

  constructor(opts: SqliteLedgerStoreOpts) {
    this.dbPath = opts.dbPath;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onMutation = opts.onMutation ?? null;
    this.onSchemaDivergence = opts.onSchemaDivergence ?? "backup-reinit";
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;
    const db = openLedgerDb(this.dbPath);
    ensureSchema(db);

    // Pass 1 — READ-ONLY divergence detection over the persisted canonical
    // ledgers (parity with AbstractLedgerStore.init): a missing canonical
    // ledger will be provisioned from canon; a persisted schema that only
    // LACKS canon's added-optional fields is a forward-compatible widening
    // upgraded to canon in place (T407); anything else is divergent and
    // routes through onSchemaDivergence BEFORE any bootstrap write commits.
    const missing: string[] = [];
    const widened: string[] = [];
    const divergent: string[] = [];
    const selectLedger = db.query(
      "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE name = ?",
    );
    for (const canonical of CANONICAL_LEDGERS) {
      const row = selectLedger.get(canonical.name) as LedgerRow | null;
      if (row === null) {
        missing.push(canonical.name);
        continue;
      }
      const persisted = JSON.parse(row.schema_json) as LedgerSchema;
      if (schemasEqual(persisted, canonical.schema)) continue;
      if (schemaCompatible(persisted, canonical.schema)) widened.push(canonical.name);
      else divergent.push(canonical.name);
    }

    if (divergent.length > 0 && this.onSchemaDivergence === "abort") {
      // Opt-out: refuse to start so the divergence is loud + operator-handled.
      // No backup — parity with AbstractLedgerStore (backupAndReinit is only
      // reached on the default policy).
      db.close();
      throw new BootstrapViolationError(
        `existing ${divergent.join(", ")} ledger(s) have a different schema than their canonical bootstrap schema`,
      );
    }

    if (divergent.length > 0) {
      // Default policy — T529 divergence BACKUP action (parity with
      // AbstractLedgerStore.backupAndReinit): VACUUM INTO a byte-complete
      // snapshot of the WHOLE db (every table, not just the divergent
      // ledger's) to a timestamped sibling file BEFORE any row is touched,
      // emit the stderr WARNING naming that locator, then wipe every row and
      // reseed fresh canonical state (same shape as Pass 2 below).
      const backupPath = this.backupDivergentState(db);
      process.stderr.write(
        `WARNING: LedgerStore divergence detected — prior state backed up to ${backupPath}\n`,
      );
      db.transaction(() => {
        db.exec("DELETE FROM archived_items");
        db.exec("DELETE FROM archive_pointers");
        db.exec("DELETE FROM items");
        db.exec("DELETE FROM groups");
        db.exec("DELETE FROM ledgers");
      })();
      this.bootstrapCanonicalRows(
        db,
        CANONICAL_LEDGERS.map((c) => c.name),
        [],
      );
    } else {
      // Pass 2 — bootstrap writes, atomically: provision missing canonical
      // ledgers, apply widening upgrades, seed the milestones bootstrap
      // active group + the immortal M-AMBIENT milestone (parity with
      // seedBootstrapGroup + applyEnsureAmbientMilestone).
      this.bootstrapCanonicalRows(db, missing, widened);
    }

    this.handle = db;
    this.initialised = true;

    // Cold-build the derived search index from the committed rows — one
    // ACTIVE + one ARCHIVED bucket per ledger. Guarded per ledger inside the
    // helpers; must stay within the T498 <500ms@10k target (T531 verifies).
    for (const name of this.enumerate()) {
      this.rebuildLedgerIndexActive(name);
      this.refreshLedgerIndexArchived(name);
    }
  }

  /**
   * Bootstrap-write transaction shared by the ordinary Pass-2 path (missing/
   * widened canonical ledgers only) and the divergence-reinit path (the FULL
   * canonical set, after every row was wiped): provision the given ledgers
   * from canon, apply any widening upgrades, and seed the milestones
   * bootstrap active group + the immortal M-AMBIENT milestone.
   */
  private bootstrapCanonicalRows(db: Database, missing: string[], widened: string[]): void {
    db.transaction(() => {
      const insertLedger = db.query(
        "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
      );
      const upgradeSchema = db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?");
      const canonSchema = new Map(CANONICAL_LEDGERS.map((c) => [c.name, c.schema]));
      for (const name of missing) {
        insertLedger.run(name, JSON.stringify(canonSchema.get(name)));
      }
      for (const name of widened) {
        upgradeSchema.run(JSON.stringify(canonSchema.get(name)), name);
      }
      db.query(
        "INSERT OR IGNORE INTO groups (ledger, id, title, description) VALUES (?, ?, ?, '')",
      ).run(MILESTONES_LEDGER, MILESTONES_ACTIVE_GROUP_ID, MILESTONES_ACTIVE_GROUP_TITLE);
      const ambient = db
        .query("SELECT id FROM items WHERE ledger = ? AND id = ?")
        .get(MILESTONES_LEDGER, MILESTONES_AMBIENT_ID);
      if (ambient === null) {
        const now = this.now();
        db.query(
          `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
           VALUES (?, ?, ?, 'open', ?, ?, ?, NULL, NULL)`,
        ).run(
          MILESTONES_LEDGER,
          MILESTONES_AMBIENT_ID,
          MILESTONES_ACTIVE_GROUP_ID,
          JSON.stringify({ title: "ambient" }),
          now,
          now,
        );
      }
    })();
  }

  /**
   * Divergence BACKUP action (T529, parity with
   * AbstractLedgerStore.backupAndReinit's byte-level copy): a `VACUUM INTO` a
   * timestamped sibling of `dbPath` — a byte-complete point-in-time snapshot
   * of the WHOLE database (every ledger's rows, not just the divergent one),
   * taken BEFORE any row is touched. Must run OUTSIDE any transaction (VACUUM
   * refuses to run inside one); `db` is not mid-transaction at this call site.
   * Returns the backup file's absolute path (the locator named in the stderr
   * WARNING).
   */
  private backupDivergentState(db: Database): string {
    const ts = this.now().replace(/:/g, "-");
    const ext = path.extname(this.dbPath);
    const base = ext.length > 0 ? this.dbPath.slice(0, -ext.length) : this.dbPath;
    const backupPath = `${base}.backup-${ts}${ext}`;
    db.query("VACUUM INTO ?").run(backupPath);
    return backupPath;
  }

  /**
   * Checkpoint the WAL into the main db file, then close the connection so no
   * lingering handle/lock survives (the T497 harness + conformance teardown
   * rely on this releasing the file). A fresh store can reopen the same path.
   */
  async dispose(): Promise<void> {
    if (this.handle !== null) {
      this.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.handle.close();
      this.handle = null;
    }
    this.initialised = false;
  }

  // ---------------------------------------------------------------------------
  // Reads — every method re-queries rows; WAL guarantees the latest committed
  // state, so there is no cache to keep coherent.
  // ---------------------------------------------------------------------------

  enumerate(): string[] {
    const rows = this.db()
      .query("SELECT name FROM ledgers ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  fetch(ledgerId: string): FetchedLedger {
    return this.read(() => this.fetchView(ledgerId));
  }

  fetchItem(ledgerId: string, itemId: string): Item {
    return this.read(() => {
      this.assertLedgerExists(ledgerId);
      const row = this.db()
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? AND id = ?",
        )
        .get(ledgerId, itemId) as ItemRow | null;
      if (row === null) throw new ItemNotFoundError(ledgerId, itemId);
      return rowToItem(row);
    });
  }

  fetchMilestone(milestoneId: string): FetchedMilestoneItem {
    return this.read(() => {
      const milestonesLedger = this.loadLedger(MILESTONES_LEDGER);
      const resolved = resolveMilestoneView(milestonesLedger, milestoneId);
      if (resolved === null) {
        throw new LedgerError(`milestone ${milestoneId} not found`);
      }
      const item = findItem(milestonesLedger, milestoneId).item;
      const refRows = this.db()
        .query(
          "SELECT ledger, COUNT(*) AS n FROM items WHERE milestone_id = ? AND ledger != ? GROUP BY ledger ORDER BY ledger",
        )
        .all(milestoneId, MILESTONES_LEDGER) as Array<{ ledger: string; n: number }>;
      const references: Record<string, number> = {};
      for (const r of refRows) references[r.ledger] = r.n;
      return { milestone: item, resolved, references };
    });
  }

  listMilestoneItems(milestoneId: string): Record<string, Item[]> {
    const rows = this.db()
      .query(
        "SELECT ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE milestone_id = ? AND ledger != ? ORDER BY ledger, rowid",
      )
      .all(milestoneId, MILESTONES_LEDGER) as Array<ItemRow & { ledger: string }>;
    const out: Record<string, Item[]> = {};
    for (const row of rows) {
      (out[row.ledger] ??= []).push(rowToItem(row));
    }
    return out;
  }

  snapshot(): LedgerSnapshot {
    return this.read(() =>
      buildSnapshot(this.enumerate().map((name) => this.fetchView(name))),
    );
  }

  search(ledgerId: string, query: string): Item[] {
    return this.read(() => searchItems(this.loadLedger(ledgerId), query));
  }

  /**
   * Delegates to the derived {@link LedgerSearchIndex} (parity with
   * AbstractLedgerStore.ftsSearch / InMemoryLedgerStore.ftsSearch — same
   * qualifier/fuzzy/prefix/boost/matchedFields/limit semantics). Hits are
   * cloned so a caller cannot mutate the index's backing items.
   */
  async ftsSearch(query: string, opts: FtsSearchOpts = {}): Promise<FtsSearchHit[]> {
    this.assertInit();
    return this.searchIndex
      .searchQuery(query, opts)
      .map((h) => ({ ...h, item: cloneItem(h.item) }));
  }

  /**
   * Materialise the `ArchiveContent` union from the archived rows (T529):
   * a whole detached milestone-GROUP for a non-milestones ledger, or the
   * single detached milestone-ITEM for the milestones ledger — mirroring
   * AbstractLedgerStore.fetchArchive's `kind` discrimination, but reading
   * `archived_items` rows instead of parsing an archive markdown file.
   */
  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    return this.read(() => {
      this.assertLedgerExists(ledgerId);
      const ptr = this.db()
        .query("SELECT id FROM archive_pointers WHERE ledger = ? AND id = ?")
        .get(ledgerId, archiveId);
      if (ptr === null) {
        throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
      }
      const rows = this.db()
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM archived_items WHERE ledger = ? AND pointer_id = ? ORDER BY rowid",
        )
        .all(ledgerId, archiveId) as ItemRow[];
      if (ledgerId === MILESTONES_LEDGER) {
        const row = rows[0];
        if (row === undefined) {
          throw new LedgerError(`archive ${archiveId} in ledger ${ledgerId} has no item`);
        }
        return { kind: "item", item: rowToItem(row) };
      }
      return {
        kind: "group",
        milestone: { id: archiveId, title: "", description: "", items: rows.map(rowToItem) },
      };
    });
  }

  /**
   * The ROW read surface needs no invalidation (every read re-queries the db,
   * so a peer process's committed write is observed on the next read). The
   * derived search index is this backend's ONLY cache: rebuild the affected
   * ledger's active AND archived buckets from the current committed rows so a
   * peer commit — surfaced by the T530 data_version coherence watcher —
   * becomes visible to ftsSearch (a peer's `archiveMilestone`/`unarchiveItem`
   * moves docs between the two buckets). Unknown ledger ids are a no-op (any
   * stale docs are dropped), matching the abstract-suite contract.
   */
  async invalidate(ledgerId: string): Promise<void> {
    this.assertInit();
    const row = this.db().query("SELECT name FROM ledgers WHERE name = ?").get(ledgerId);
    if (row === null) {
      this.searchIndex.removeLedger(ledgerId);
      return;
    }
    this.rebuildLedgerIndexActive(ledgerId);
    this.refreshLedgerIndexArchived(ledgerId);
  }

  // ---------------------------------------------------------------------------
  // Mutations (T527) — every mutation is ONE write transaction
  // (`BEGIN IMMEDIATE` + bounded SQLITE_BUSY(-SNAPSHOT) retry — see
  // `immediateWriteTransaction` in connection.ts) whose WRITE set is only the
  // affected rows: the item row, the ledger counter, and the lazily-provisioned
  // group row. There is NO serialize/rewrite funnel (K102): the domain guards
  // are REUSED from core.ts by materialising just enough Ledger state for the
  // pure apply* helpers, so results and error types match FsLedgerStore.
  // The write lock held from BEGIN also subsumes the fs store's H41/D61
  // reload-under-lock pattern: every read inside the transaction is fresh.
  // ---------------------------------------------------------------------------

  async updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    const item = immediateWriteTransaction(this.db(), () => {
      const shim = this.singleItemShim(MILESTONES_LEDGER, milestoneId);
      const x = applyUpdateMilestoneItem(shim, milestoneId, patch, this.now());
      this.persistItemRow(MILESTONES_LEDGER, x);
      return x;
    });
    // Hook fires AFTER commit per the D-COHERENCE contract.
    this.indexUpsertActive(MILESTONES_LEDGER, item);
    this.fireMutation(MILESTONES_LEDGER, "update");
    return item;
  }

  async updateItem(
    ledgerId: string,
    itemId: string,
    patch: UpdateItemPatch,
  ): Promise<Item> {
    const item = immediateWriteTransaction(this.db(), () => {
      const shim = this.singleItemShim(ledgerId, itemId);
      const precondition = this.statusChangePrecondition(ledgerId, shim, itemId, patch);
      const x = applyUpdateItem(shim, itemId, patch, this.now(), precondition);
      this.persistItemRow(ledgerId, x);
      return x;
    });
    this.indexUpsertActive(ledgerId, item);
    this.fireMutation(ledgerId, "update");
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
    const item = immediateWriteTransaction(this.db(), () => {
      // Strict Q5 existence check against the milestones ledger. Ordering
      // parity with AbstractLedgerStore.createItem: this check runs BEFORE
      // the target-ledger existence check (createItemShim below).
      assertMilestoneActive(this.loadLedger(MILESTONES_LEDGER), milestoneId);
      // T538 (D87): a MINIMAL shim of the target ledger (targeted row
      // queries) instead of materialising all N rows via loadLedger.
      const shim = this.createItemShim(ledgerId, milestoneId, init.id);
      return this.insertItemViaCore(shim, init.id, (l) =>
        applyCreateItem(l, milestoneId, init, this.now()),
      );
    });
    this.indexUpsertActive(ledgerId, item);
    this.fireMutation(ledgerId, "create");
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = immediateWriteTransaction(this.db(), () => {
      const ledger = this.loadLedger(MILESTONES_LEDGER);
      return this.insertItemViaCore(ledger, init.id, (l) =>
        applyCreateMilestoneItem(l, init, this.now()),
      );
    });
    this.indexUpsertActive(MILESTONES_LEDGER, item);
    this.fireMutation(MILESTONES_LEDGER, "create");
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `ledger name "${MILESTONES_LEDGER}" is reserved`,
      );
    }
    if (!LEDGER_NAME_RE.test(name)) {
      throw new LedgerError(
        `invalid ledger name "${name}": only A-Za-z0-9_- are allowed`,
      );
    }
    validateSchema(schema);
    const view = immediateWriteTransaction(this.db(), () => {
      const rows = this.db()
        .query("SELECT name, schema_json FROM ledgers")
        .all() as Array<{ name: string; schema_json: string }>;
      if (rows.some((r) => r.name === name)) {
        throw new DuplicateIdError("ledger", name);
      }
      // Prefix uniqueness gives global item-id uniqueness (Q-CANL-8). The
      // `ledgers` table IS this backend's registry, read under the write lock.
      assertPrefixUnique(
        name,
        schema,
        rows.map((r) => ({ name: r.name, schema: JSON.parse(r.schema_json) as LedgerSchema })),
      );
      this.db()
        .query(
          "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
        )
        .run(name, JSON.stringify(schema));
      return this.fetchView(name);
    });
    this.fireMutation(name, "create");
    return view;
  }

  async reopenItem(ledgerId: string, itemId: string, toStatus: string): Promise<Item> {
    const item = immediateWriteTransaction(this.db(), () => {
      const shim = this.singleItemShim(ledgerId, itemId);
      const x = applyReopenItem(shim, itemId, toStatus, this.now());
      this.persistItemRow(ledgerId, x);
      return x;
    });
    this.indexUpsertActive(ledgerId, item);
    this.fireMutation(ledgerId, "update");
    return item;
  }

  /**
   * Un-archive a single item out of an archived milestone-GROUP (Q78),
   * row-natively: reuses `applyReattachItem` (core.ts) against the FULL
   * `Ledger` materialised by {@link loadLedger} — the SAME domain guard
   * (duplicate-id check across the whole ledger, lazy group re-creation) the
   * fs store uses — then persists the reattached item row, drops the
   * `archived_items` row, and drops the `archive_pointers` row too when the
   * group archive becomes empty (parity with AbstractLedgerStore.unarchiveItem).
   */
  async unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
  ): Promise<Item> {
    const isMilestones = ledgerId === MILESTONES_LEDGER;
    const item = immediateWriteTransaction(this.db(), () => {
      const db = this.db();
      const ledger = this.loadLedger(ledgerId);
      const ptr = ledger.archivePointers.find((p) => p.id === milestoneId);
      if (ptr === undefined) {
        throw new LedgerError(
          isMilestones
            ? `no archived item ${milestoneId} in ledger ${ledgerId}`
            : `no archived group for milestone ${milestoneId} in ledger ${ledgerId}`,
        );
      }
      const archivedRow = db
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM archived_items WHERE ledger = ? AND pointer_id = ? AND id = ?",
        )
        .get(ledgerId, milestoneId, itemId) as ItemRow | null;
      if (archivedRow === null) {
        throw new LedgerError(
          isMilestones
            ? `archived item file ${milestoneId} in ledger ${ledgerId} does not contain item ${itemId}`
            : `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      const groupsBefore = new Set(ledger.milestones.map((m) => m.id));
      const reattached = applyReattachItem(ledger, milestoneId, rowToItem(archivedRow), this.now());
      if (!groupsBefore.has(milestoneId)) {
        db.query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(
          ledgerId,
          milestoneId,
        );
      }
      db.query(
        `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ledgerId,
        reattached.id,
        reattached.milestoneId,
        reattached.status,
        JSON.stringify(reattached.fields),
        reattached.createdAt,
        reattached.updatedAt,
        reattached.author ?? null,
        reattached.session ?? null,
      );
      db.query(
        "DELETE FROM archived_items WHERE ledger = ? AND pointer_id = ? AND id = ?",
      ).run(ledgerId, milestoneId, itemId);
      const remaining = db
        .query("SELECT COUNT(*) AS n FROM archived_items WHERE ledger = ? AND pointer_id = ?")
        .get(ledgerId, milestoneId) as { n: number };
      if (remaining.n === 0) {
        db.query("DELETE FROM archive_pointers WHERE ledger = ? AND id = ?").run(
          ledgerId,
          milestoneId,
        );
      }
      return reattached;
    });
    // T538 (D87): move the ONE reattached doc archived → active incrementally
    // (indexMoveToActive preserves the D88 archived-first-then-active
    // ordering) instead of rebuilding both buckets.
    this.indexMoveToActive(ledgerId, item);
    this.fireMutation(ledgerId, "update");
    return item;
  }

  /**
   * Archive a milestone across all ledgers (Q6 — two-level atomic), row-
   * natively in ONE `BEGIN IMMEDIATE` transaction: reuses
   * `applyDetachMilestoneGroup`/`applyDetachMilestoneItem` (core.ts) against
   * the FULL `Ledger`s materialised by {@link loadLedger} — the SAME
   * terminal-item verification + bootstrap/M-AMBIENT refusal semantics the fs
   * store uses (NonTerminalItemsError, verification runs to completion BEFORE
   * any row is touched — D10 no-partial-archive) — then persists the detached
   * rows into `archived_items`/`archive_pointers` and deletes the active rows.
   * `onMutation` fires per participating ledger + the milestones ledger, in
   * alphabetic-then-milestones order (D-COHERENCE), AFTER commit.
   */
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
    let participating: string[] = [];
    let pointer: ArchivePointer | undefined;
    // Hoisted for the post-commit incremental index moves (T538/D87); reset
    // inside the transaction body, which the busy-retry may re-run.
    let detached = new Map<string, { items: Item[] }>();
    let detachedMsItem: Item | undefined;
    immediateWriteTransaction(this.db(), () => {
      const db = this.db();
      participating = [];
      const otherNames = this.enumerate().filter((n) => n !== MILESTONES_LEDGER);

      // Phase 1 — verify EVERY participating ledger's group is fully
      // terminal, BEFORE any mutation (applyDetachMilestoneGroup throws
      // NonTerminalItemsError strictly before its splice).
      detached = new Map<string, { items: Item[] }>();
      for (const name of otherNames) {
        const ledger = this.loadLedger(name);
        const hasGroup = ledger.milestones.some((m) => m.id === milestoneId);
        if (!hasGroup) continue;
        participating.push(name);
        const { milestone } = applyDetachMilestoneGroup(
          ledger,
          milestoneId,
          summary,
          `./archive/${name}/${milestoneId}.md`,
          "",
          "",
        );
        detached.set(name, { items: milestone.items });
      }

      // Phase 1b — verify + detach the milestone-item itself; also yields the
      // title/status used to populate every ArchivePointer written below.
      const msLedger = this.loadLedger(MILESTONES_LEDGER);
      const { item: msItem } = applyDetachMilestoneItem(
        msLedger,
        milestoneId,
        summary,
        `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
        "",
        "",
      );
      detachedMsItem = msItem;
      const msTitle = typeof msItem.fields["title"] === "string" ? msItem.fields["title"] : "";
      const msStatus = msItem.status;
      const nowTs = this.now();

      // Phase 2 — persist: move each participating ledger's group rows into
      // archived_items/archive_pointers, drop the active items/groups rows.
      const insertPointer = db.query(
        "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertArchived = db.query(
        `INSERT INTO archived_items (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const name of participating) {
        insertPointer.run(name, milestoneId, summary, msTitle, msStatus, nowTs);
        for (const it of detached.get(name)?.items ?? []) {
          insertArchived.run(
            name,
            milestoneId,
            it.id,
            it.milestoneId,
            it.status,
            JSON.stringify(it.fields),
            it.createdAt,
            it.updatedAt,
            it.author ?? null,
            it.session ?? null,
          );
        }
        db.query("DELETE FROM items WHERE ledger = ? AND milestone_id = ?").run(name, milestoneId);
        db.query("DELETE FROM groups WHERE ledger = ? AND id = ?").run(name, milestoneId);
      }

      // Phase 3 — persist the milestone-item's own archive; drop its active row.
      insertPointer.run(MILESTONES_LEDGER, milestoneId, summary, msTitle, msStatus, nowTs);
      insertArchived.run(
        MILESTONES_LEDGER,
        milestoneId,
        msItem.id,
        msItem.milestoneId,
        msItem.status,
        JSON.stringify(msItem.fields),
        msItem.createdAt,
        msItem.updatedAt,
        msItem.author ?? null,
        msItem.session ?? null,
      );
      db.query("DELETE FROM items WHERE ledger = ? AND id = ?").run(MILESTONES_LEDGER, milestoneId);

      pointer = {
        id: milestoneId,
        path: `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
        summary,
        title: msTitle,
        status: msStatus,
      };
    });
    // T538 (D87): move each detached doc active → archived incrementally —
    // O(group-size), never O(ledger-size) — BEFORE the hooks fire, so a hook
    // observes ftsSearch already reflecting the archive.
    for (const name of participating) {
      for (const it of detached.get(name)?.items ?? []) {
        this.indexMoveToArchived(name, it);
      }
    }
    if (detachedMsItem !== undefined) {
      this.indexMoveToArchived(MILESTONES_LEDGER, detachedMsItem);
    }
    // Fire per-participant hooks AFTER commit (D-COHERENCE order: alphabetic
    // participants, then the milestones ledger).
    for (const id of participating) this.fireMutation(id, "archive");
    this.fireMutation(MILESTONES_LEDGER, "archive");
    if (pointer === undefined) {
      throw new LedgerError(`SqliteLedgerStore: archiveMilestone(${milestoneId}) produced no pointer`);
    }
    return pointer;
  }

  // ---------------------------------------------------------------------------
  // Internals — write path (T527)
  // ---------------------------------------------------------------------------

  /**
   * Post-commit mutation hook (parity with AbstractLedgerStore.fireMutation):
   * the user hook is GUARDED — a throw is logged to stderr and cannot unwind
   * the already-committed write. Fired strictly AFTER the transaction COMMITs.
   *
   * T538 (D87): the index refresh no longer lives here — each mutation site
   * applies its INCREMENTAL per-doc index update (indexUpsertActive /
   * indexMoveToArchived / indexMoveToActive) BEFORE calling this, so by the
   * time the hook observes the mutation ftsSearch already reflects it (same
   * ordering as the fs store) without an O(ledger-size) bucket rebuild.
   */
  private fireMutation(ledgerId: string, op: LedgerMutationOp): void {
    if (this.onMutation !== null) {
      try {
        this.onMutation(ledgerId, op);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `LedgerStore: onMutation hook threw for ${ledgerId} (${op}): ${msg}\n`,
        );
      }
    }
  }

  /**
   * Incremental derived-index update (T538/D87): upsert the ONE mutated
   * item's ACTIVE doc — O(1) in ledger size, replacing the per-mutation
   * whole-bucket rebuild. GUARDED: an index error must never propagate into
   * the write path. The item is CLONED so the Item returned to the caller
   * cannot mutate the index's backing.
   */
  private indexUpsertActive(ledgerId: string, item: Item): void {
    try {
      this.searchIndex.upsertActiveDoc(ledgerId, cloneItem(item));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `LedgerStore: FTS active-upsert threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Move ONE doc active → archived (T538/D87 incremental form of the archive
   * transition). Active removal runs FIRST: the docId is shared between the
   * two scopes (D88), so the stale active entry must be gone before the
   * archived upsert claims the id. GUARDED like every index update.
   */
  private indexMoveToArchived(ledgerId: string, item: Item): void {
    try {
      this.searchIndex.removeActiveDoc(ledgerId, item.id);
      this.searchIndex.upsertArchivedDoc(ledgerId, cloneItem(item));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `LedgerStore: FTS archive-move threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Move ONE doc archived → active (T538/D87 incremental form of the T529
   * unarchive transition). Preserves the D88 ordering: the archived scope's
   * stale entry is discarded BEFORE the active upsert re-adds the same docId
   * — reversed, a later archived-scope operation could erase the live active
   * doc right back out of the index. GUARDED like every index update.
   */
  private indexMoveToActive(ledgerId: string, item: Item): void {
    try {
      this.searchIndex.removeArchivedDoc(ledgerId, item.id);
      this.searchIndex.upsertActiveDoc(ledgerId, cloneItem(item));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `LedgerStore: FTS unarchive-move threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Rebuild the ACTIVE search-index docs for `ledgerId` from its committed
   * item rows. Synchronous and GUARDED: an index error must never propagate
   * into the write path (parity with
   * AbstractLedgerStore.rebuildLedgerIndexActive). Replaces ONLY the one
   * ledger's bucket — O(items-in-ledger), never a full-store rebuild and
   * never a re-serialize (K102: the index is a derived read-side projection).
   * T538 (D87): called ONLY from init() (cold build) and invalidate()
   * (cross-process refresh) — never from the per-mutation path, which
   * updates the single mutated doc incrementally instead.
   */
  private rebuildLedgerIndexActive(ledgerId: string): void {
    try {
      const rows = this.db()
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? ORDER BY rowid",
        )
        .all(ledgerId) as ItemRow[];
      this.searchIndex.rebuildLedgerActive(ledgerId, rows.map(rowToItem));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `LedgerStore: FTS active-rebuild threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Replace the ARCHIVED search-index docs for `ledgerId` from its committed
   * `archived_items` rows (T529, parity with
   * AbstractLedgerStore.refreshLedgerIndexArchived). Synchronous — no file
   * I/O is needed for this backend — and GUARDED: an index error must never
   * propagate into the write path. Called after `archiveMilestone` /
   * `unarchiveItem` commit and by `invalidate` on the peer-coherence path.
   */
  private refreshLedgerIndexArchived(ledgerId: string): void {
    try {
      const rows = this.db()
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM archived_items WHERE ledger = ? ORDER BY rowid",
        )
        .all(ledgerId) as ItemRow[];
      this.searchIndex.setLedgerArchived(ledgerId, rows.map(rowToItem));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `LedgerStore: FTS archived-refresh threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Materialise a MINIMAL `Ledger` for the single-item core.ts helpers
   * (applyUpdateItem / applyUpdateMilestoneItem / applyReopenItem): the real
   * schema + counters plus AT MOST the one target item in a bare group. When
   * the item row is absent the shim carries no items, so `findItem` inside
   * the helper throws the same `ItemNotFoundError` the fs store surfaces.
   * Throws `LedgerNotFoundError` first when the ledger row is absent (parity
   * with AbstractLedgerStore's withLock guard). Must run inside a write
   * transaction — the caller persists the mutated item via
   * {@link persistItemRow}.
   */
  private singleItemShim(ledgerId: string, itemId: string): Ledger {
    const lrow = this.db()
      .query(
        "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE name = ?",
      )
      .get(ledgerId) as LedgerRow | null;
    if (lrow === null) throw new LedgerNotFoundError(ledgerId);
    const row = this.db()
      .query(
        "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? AND id = ?",
      )
      .get(ledgerId, itemId) as ItemRow | null;
    return {
      id: ledgerId,
      schema: JSON.parse(lrow.schema_json) as LedgerSchema,
      counters: { milestone: lrow.milestone_counter, item: lrow.item_counter },
      milestones:
        row === null
          ? []
          : [{ id: row.milestone_id, title: "", description: "", items: [rowToItem(row)] }],
      archivePointers: [],
    };
  }

  /**
   * Materialise a MINIMAL `Ledger` for `applyCreateItem` (T538/D87) — the
   * O(1) creation counterpart of {@link singleItemShim}, replacing the
   * O(N-rows) loadLedger the createItem path used to pay per call. Targeted
   * row queries only:
   *
   *  - the ledger row (schema + counters) — absent throws
   *    `LedgerNotFoundError`, same ordering as the loadLedger it replaces;
   *  - the target milestone-GROUP row when it exists, so applyCreateItem's
   *    existing-vs-lazy-group branch (and insertItemViaCore's groups-row
   *    provisioning) behaves exactly as with the full ledger;
   *  - on the caller-supplied-id path, the item row with that id when it
   *    exists — injected so applyCreateItem's own duplicate check throws
   *    `DuplicateIdError` at the SAME point in its guard sequence (after
   *    status/fields/prefix validation) as the fs store.
   *
   * The auto-id path needs no item rows at all: {@link allocateItemId}
   * guarantees DB-wide uniqueness via its RETURNING dup-avoid loop, and
   * {@link insertItemViaCore}'s SQL-vs-core divergence guard verifies the
   * shim-derived id matches. Must run inside a write transaction.
   */
  private createItemShim(
    ledgerId: string,
    milestoneId: string,
    suppliedId: string | undefined,
  ): Ledger {
    const db = this.db();
    const lrow = db
      .query(
        "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE name = ?",
      )
      .get(ledgerId) as LedgerRow | null;
    if (lrow === null) throw new LedgerNotFoundError(ledgerId);
    const milestones: Milestone[] = [];
    const grow = db
      .query("SELECT id, title, description FROM groups WHERE ledger = ? AND id = ?")
      .get(ledgerId, milestoneId) as GroupRow | null;
    if (grow !== null) {
      milestones.push({ id: grow.id, title: grow.title, description: grow.description, items: [] });
    }
    if (suppliedId !== undefined) {
      const irow = db
        .query(
          "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? AND id = ?",
        )
        .get(ledgerId, suppliedId) as ItemRow | null;
      if (irow !== null) {
        const existing = milestones.find((m) => m.id === irow.milestone_id);
        const dupe = rowToItem(irow);
        if (existing !== undefined) existing.items.push(dupe);
        else milestones.push({ id: irow.milestone_id, title: "", description: "", items: [dupe] });
      }
    }
    return {
      id: ledgerId,
      schema: JSON.parse(lrow.schema_json) as LedgerSchema,
      counters: { milestone: lrow.milestone_counter, item: lrow.item_counter },
      milestones,
      archivePointers: [],
    };
  }

  /** Write an updated item's mutable columns back to its row. */
  private persistItemRow(ledgerId: string, item: Item): void {
    this.db()
      .query(
        "UPDATE items SET status = ?, fields_json = ?, updated_at = ?, author = ?, session = ? WHERE ledger = ? AND id = ?",
      )
      .run(
        item.status,
        JSON.stringify(item.fields),
        item.updatedAt,
        item.author ?? null,
        item.session ?? null,
        ledgerId,
        item.id,
      );
  }

  /**
   * Build the optional `StatusChangePrecondition` for an `updateItem` against
   * `ledgerId` (parity with AbstractLedgerStore.statusChangePrecondition; the
   * rule logic lives in core.ts). The cross-ledger inputs are read INSIDE the
   * write transaction, so the F2 goal-phase check sees the same committed
   * state the write will serialize against.
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
          this.loadLedgerIfExists(QUESTIONS_LEDGER),
          this.loadLedgerIfExists(DECISIONS_LEDGER),
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

  /** {@link loadLedger}, but absent ledgers yield `undefined` (F2 inputs). */
  private loadLedgerIfExists(name: string): Ledger | undefined {
    try {
      return this.loadLedger(name);
    } catch (err: unknown) {
      if (err instanceof LedgerNotFoundError) return undefined;
      throw err;
    }
  }

  /**
   * Shared createItem/createMilestone write path. Must run inside a write
   * transaction, with `ledger` freshly materialised in that transaction.
   *
   * Auto-id path: the id is allocated FIRST via
   * `UPDATE ledgers SET item_counter = item_counter + 1 … RETURNING`
   * ({@link allocateItemId}) — the K102 replacement for the fs store's
   * H41/D61 reload-under-lock counter refresh — then the pure core.ts helper
   * re-derives the SAME id from `counter - 1` while running the FULL guard
   * set (status/fields/prefix/duplicate checks, lazy group materialisation,
   * ledger-specific invariants). Any divergence is an invariant violation and
   * throws (rolling the transaction back).
   *
   * Write set: the (possibly new) group row, the item row, and — on the
   * caller-supplied-id path, where core.ts may bump the counter past the
   * supplied numeric id — the counter.
   */
  private insertItemViaCore(
    ledger: Ledger,
    suppliedId: string | undefined,
    apply: (ledger: Ledger) => Item,
  ): Item {
    const db = this.db();
    const groupsBefore = new Set(ledger.milestones.map((m) => m.id));
    const counterBefore = ledger.counters.item;
    let expected: { id: string; counter: number } | null = null;
    if (suppliedId === undefined) {
      expected = this.allocateItemId(ledger.id, effectiveIdPrefix(ledger.id, ledger.schema));
      // applyCreateItem pre-increments, so hand it the predecessor value.
      ledger.counters.item = expected.counter - 1;
    }
    const item = apply(ledger);
    if (
      expected !== null &&
      (item.id !== expected.id || ledger.counters.item !== expected.counter)
    ) {
      throw new LedgerError(
        `SqliteLedgerStore: id allocation diverged (sql ${expected.id}/${expected.counter}, core ${item.id}/${ledger.counters.item})`,
      );
    }
    // Persist the lazily-materialised depth-2 group BEFORE the item row, so
    // loadLedger's orphan-item fail-fast invariant always holds.
    if (!groupsBefore.has(item.milestoneId)) {
      db.query("INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, '', '')").run(
        ledger.id,
        item.milestoneId,
      );
    }
    db.query(
      `INSERT INTO items (ledger, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ledger.id,
      item.id,
      item.milestoneId,
      item.status,
      JSON.stringify(item.fields),
      item.createdAt,
      item.updatedAt,
      item.author ?? null,
      item.session ?? null,
    );
    if (expected === null && ledger.counters.item !== counterBefore) {
      db.query("UPDATE ledgers SET item_counter = ? WHERE name = ?").run(
        ledger.counters.item,
        ledger.id,
      );
    }
    return item;
  }

  /**
   * Allocate the next auto item id for `ledgerId`: an atomic
   * `UPDATE … RETURNING` counter bump inside the surrounding write
   * transaction. Mirrors applyCreateItem's dup-avoid loop: keeps bumping past
   * numbers parked on by caller-supplied ids (each skipped bump persists,
   * exactly like the fs counter semantics).
   */
  private allocateItemId(ledgerId: string, prefix: string): { id: string; counter: number } {
    const db = this.db();
    const bump = db.query(
      "UPDATE ledgers SET item_counter = item_counter + 1 WHERE name = ? RETURNING item_counter",
    );
    const exists = db.query("SELECT 1 FROM items WHERE ledger = ? AND id = ?");
    for (;;) {
      const row = bump.get(ledgerId) as { item_counter: number } | null;
      if (row === null) throw new LedgerNotFoundError(ledgerId);
      const id = prefix + String(row.item_counter);
      if (exists.get(ledgerId, id) === null) return { id, counter: row.item_counter };
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private db(): Database {
    this.assertInit();
    if (this.handle === null) {
      throw new LedgerError("SqliteLedgerStore: database handle is closed");
    }
    return this.handle;
  }

  private assertInit(): void {
    if (!this.initialised) throw new LedgerError("LedgerStore not initialised");
  }

  /**
   * Run `fn` inside a single DEFERRED read transaction so a composite view
   * assembled from several row queries cannot be torn by a concurrent peer
   * commit. Internal helpers (loadLedger/fetchView) are non-transactional and
   * MUST be reached through this wrapper.
   */
  private read<T>(fn: () => T): T {
    return this.db().transaction(fn)() as T;
  }

  private assertLedgerExists(ledgerId: string): void {
    const row = this.db()
      .query("SELECT name FROM ledgers WHERE name = ?")
      .get(ledgerId);
    if (row === null) throw new LedgerNotFoundError(ledgerId);
  }

  /** Materialise the domain `Ledger` for `name` from its normalized rows. */
  private loadLedger(name: string): Ledger {
    const db = this.db();
    const row = db
      .query(
        "SELECT name, schema_json, milestone_counter, item_counter FROM ledgers WHERE name = ?",
      )
      .get(name) as LedgerRow | null;
    if (row === null) throw new LedgerNotFoundError(name);
    const groupRows = db
      .query("SELECT id, title, description FROM groups WHERE ledger = ? ORDER BY rowid")
      .all(name) as GroupRow[];
    const itemRows = db
      .query(
        "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM items WHERE ledger = ? ORDER BY rowid",
      )
      .all(name) as ItemRow[];
    const pointerRows = db
      .query(
        "SELECT id, summary, title, status FROM archive_pointers WHERE ledger = ? ORDER BY rowid",
      )
      .all(name) as PointerRow[];

    const itemsByGroup = new Map<string, Item[]>();
    const milestones: Milestone[] = groupRows.map((g) => {
      const items: Item[] = [];
      itemsByGroup.set(g.id, items);
      return { id: g.id, title: g.title, description: g.description, items };
    });
    const orphans: string[] = [];
    for (const r of itemRows) {
      const items = itemsByGroup.get(r.milestone_id);
      if (items === undefined) {
        orphans.push(r.id);
        continue;
      }
      items.push(rowToItem(r));
    }
    if (orphans.length > 0) {
      // Fail fast: an item row referencing a milestone-group with no groups
      // row is a writer defect (T527 always provisions the group first).
      throw new LedgerError(
        `ledger ${name}: item(s) ${orphans.join(", ")} reference a milestone-group with no groups row`,
      );
    }

    return {
      id: name,
      schema: JSON.parse(row.schema_json) as LedgerSchema,
      counters: { milestone: row.milestone_counter, item: row.item_counter },
      milestones,
      // The pointer path is derived, not stored: this backend has no archive
      // FILES — T529 materialises ArchiveContent from archived_items rows —
      // but the ArchivePointer shape carries the fs-convention locator.
      archivePointers: pointerRows.map(
        (p): ArchivePointer => ({
          id: p.id,
          path: `./archive/${name}/${p.id}.md`,
          summary: p.summary,
          title: p.title,
          status: p.status,
        }),
      ),
    };
  }

  private fetchView(ledgerId: string): FetchedLedger {
    return materialiseFetchedLedger(
      this.loadLedger(ledgerId),
      this.loadLedger(MILESTONES_LEDGER),
    );
  }
}
