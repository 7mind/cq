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
 *  - THIS task (T526): constructor, init() (open + DDL + canonical-ledger
 *    bootstrap + milestones bootstrap group + M-AMBIENT + schema-divergence
 *    detection with the BACKUP action stubbed), the synchronous read surface
 *    (enumerate/fetch/fetchItem/fetchMilestone/listMilestoneItems/snapshot/
 *    search), invalidate() (row reads need none — no-op), dispose().
 *  - T527: mutations (createItem/updateItem/createMilestone/createLedger/
 *    updateMilestone/reopenItem).
 *  - T528: the derived search index (ftsSearch) + the index-refresh half of
 *    invalidate().
 *  - T529: archives (archiveMilestone/unarchiveItem/fetchArchive) + the
 *    divergence backup-reinit action.
 *  - T530: createLedgerStore xdg wiring.
 */

import type { Database } from "bun:sqlite";
import type {
  ArchivePointer,
  FetchedLedger,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../../types.js";
import { BootstrapViolationError, LedgerError, LedgerNotFoundError, ItemNotFoundError } from "../../types.js";
import type {
  ArchiveContent,
  CreateItemInit,
  CreateMilestoneItemInit,
  FetchedMilestoneItem,
  FtsSearchHit,
  FtsSearchOpts,
  LedgerStore,
  OnMutation,
  UpdateItemPatch,
  UpdateMilestoneItemPatch,
} from "../LedgerStore.js";
import type { LedgerSnapshot } from "../../snapshot.js";
import { buildSnapshot } from "../../snapshot.js";
import { findItem, resolveMilestoneView, searchItems } from "../core.js";
import { materialiseFetchedLedger } from "../InMemoryLedgerStore.js";
import { schemaCompatible, schemasEqual } from "../AbstractLedgerStore.js";
import {
  CANONICAL_LEDGERS,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
} from "../../constants.js";
import { openLedgerDb } from "./connection.js";
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
   * Fired AFTER every successful write (see {@link OnMutation}). Stored now
   * for constructor parity with FsLedgerStore; wired to the mutation methods
   * in T527.
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

export class SqliteLedgerStore implements LedgerStore {
  private readonly dbPath: string;
  private readonly now: () => string;
  /** Wired to the mutation methods in T527; stored for constructor parity. */
  protected readonly onMutation: OnMutation | null;
  private readonly onSchemaDivergence: "backup-reinit" | "abort";
  private handle: Database | null = null;
  private initialised = false;

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

    if (divergent.length === 0) {
      // Pass 2 — bootstrap writes, atomically: provision missing canonical
      // ledgers, apply widening upgrades, seed the milestones bootstrap
      // active group + the immortal M-AMBIENT milestone (parity with
      // seedBootstrapGroup + applyEnsureAmbientMilestone).
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

    if (divergent.length > 0) {
      db.close();
      if (this.onSchemaDivergence === "abort") {
        throw new BootstrapViolationError(
          `existing ${divergent.join(", ")} ledger(s) have a different schema than their canonical bootstrap schema`,
        );
      }
      // TODO(T529): the backup-reinit ACTION (back up divergent rows, rewrite
      // fresh canonical state) for this backend lands in T529.
      throw new Error(
        `SqliteLedgerStore: schema-divergence backup-reinit is implemented in T529 (divergent: ${divergent.join(", ")})`,
      );
    }

    this.handle = db;
    this.initialised = true;
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

  async ftsSearch(_query: string, _opts?: FtsSearchOpts): Promise<FtsSearchHit[]> {
    // TODO(T528): derived in-memory search index over the rows.
    throw new Error("SqliteLedgerStore.ftsSearch: not implemented until T528");
  }

  async fetchArchive(_ledgerId: string, _archiveId: string): Promise<ArchiveContent> {
    throw new Error("SqliteLedgerStore.fetchArchive: implemented in T529");
  }

  /**
   * No-op for the ROW read surface: every read re-queries the db, so a peer
   * process's committed write is observed on the next read with no
   * invalidation. TODO(T528): refresh the derived search index here once it
   * exists — that is the only cache this backend will ever hold.
   */
  async invalidate(_ledgerId: string): Promise<void> {
    this.assertInit();
  }

  // ---------------------------------------------------------------------------
  // Mutations — T527 (see the task-split note in the file header).
  // ---------------------------------------------------------------------------

  async updateMilestone(
    _milestoneId: string,
    _patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    throw new Error("SqliteLedgerStore.updateMilestone: implemented in T527");
  }

  async updateItem(
    _ledgerId: string,
    _itemId: string,
    _patch: UpdateItemPatch,
  ): Promise<Item> {
    throw new Error("SqliteLedgerStore.updateItem: implemented in T527");
  }

  async createItem(
    _ledgerId: string,
    _milestoneId: string,
    _init: CreateItemInit,
  ): Promise<Item> {
    throw new Error("SqliteLedgerStore.createItem: implemented in T527");
  }

  async createMilestone(_init: CreateMilestoneItemInit): Promise<Item> {
    throw new Error("SqliteLedgerStore.createMilestone: implemented in T527");
  }

  async createLedger(_name: string, _schema: LedgerSchema): Promise<FetchedLedger> {
    throw new Error("SqliteLedgerStore.createLedger: implemented in T527");
  }

  async reopenItem(_ledgerId: string, _itemId: string, _toStatus: string): Promise<Item> {
    throw new Error("SqliteLedgerStore.reopenItem: implemented in T527");
  }

  async unarchiveItem(
    _ledgerId: string,
    _milestoneId: string,
    _itemId: string,
  ): Promise<Item> {
    throw new Error("SqliteLedgerStore.unarchiveItem: implemented in T529");
  }

  async archiveMilestone(_milestoneId: string, _summary: string): Promise<ArchivePointer> {
    throw new Error("SqliteLedgerStore.archiveMilestone: implemented in T529");
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
