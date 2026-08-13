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
import { promises as fs } from "node:fs";
import type { Database } from "bun:sqlite";
import type {
  ArchivePointer,
  FetchedLedger,
  FieldValue,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../../types.js";
import type { UsageStatsSnapshot } from "../../usageStats.js";
import type {
  PlanClaimInput,
  PlanClaimResult,
  PlanFinalizeInput,
  PlanFinalizeResult,
  PlanLifecycleStore,
  PlanPrivateClaimRecord,
  PlanPublishDraftInput,
  PlanPublishDraftResult,
  PlanReleaseInput,
  PlanReleaseResult,
} from "../../planLifecycle.js";
import { PlanPrivateClaimRecordSchema } from "../../planLifecycle.js";
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
  validateMilestoneItemPatch,
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
import { buildPrefixRegistry, normalizeStoredRefFields } from "../../refs.js";
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
  TASKS_LEDGER,
  LEDGER_LOGS_STRIP_RE,
  LEDGER_LOGS_RELATIVE_PREFIX,
  DEFAULT_ON_SCHEMA_DIVERGENCE,
} from "../../constants.js";
import { immediateWriteTransaction, openLedgerDb } from "./connection.js";
import { ensureSchema, SCHEMA_VERSION } from "./schema.js";
import { createSqliteWorksetStore } from "./sqliteWorksetStore.js";
import type { CreateInMemoryWorksetStoreOptions, WorksetStore } from "../../worksetStore.js";
import { createObserveOnlyWorksetInvocationAuthority } from "../../worksetInvocationAuthority.js";
import { serializeWorksetRootsDocument } from "../../worksetStoreGit.js";
import {
  claimInMemoryPlan,
  finalizeInMemoryPlan,
  publishInMemoryPlanDraft,
  releaseInMemoryPlanClaim,
  type InMemoryPlanLifecycleState,
  type InMemoryPlanMutation,
  type InMemoryPlanOperationRecord,
} from "../inMemoryPlanLifecycle.js";
import {
  assertManagedGoalTransitionAllowed,
  assertManagedTaskTransitionAllowed,
  assertRawPlanCreateAllowed,
  assertRawPlanUpdateAllowed,
} from "../planLifecycleGuards.js";
import {
  rawTaskSerializationContender,
  type PlanLifecycleSerializationBoundaryHook,
  type PlanLifecycleSerializationContender,
} from "../planLifecycleSerialization.js";
import { serializePlanLifecycleDump } from "../planLifecycleDump.js";
import {
  MAX_READ_LOG_BYTES,
  ReadLogNotImplementedError,
  type ReadLogResult,
} from "../../mcp/readLog.js";
import {
  observeTaskAdoptionEligibility,
  TaskAdoptionFenceRegistry,
  type TaskAdoptionEligibilityFence,
  type TaskAdoptionEligibilityObservation,
  type TaskAdoptionEligibilityResult,
  type TaskAdoptionPublicationResult,
} from "../../taskAdoptionEligibility.js";
import {
  applyOperatorActionLifecycleMutation,
  type OperatorActionLifecycleMutation,
  type OperatorActionLifecycleMutationResult,
} from "../operatorActionLifecycle.js";
import { createOwnedWriteTransaction } from "../ownedWriteTransaction.js";
import type { WorksetOwnedWriteTx } from "../../worksetOwnedLifecycle.js";
import type { WorksetPlanLifecycleTx } from "../../worksetPlanLifecycle.js";
import { createWorksetPlanLifecycleTransaction } from "../worksetPlanLifecycleTransaction.js";
import {
  createGenericMutationTransaction,
  genericArchiveKey,
  type GenericArchiveEntry,
  type WorksetGenericMutationTx,
} from "../genericMutationTransaction.js";
import type { WorksetRootsEpoch } from "../../worksetEffectAdmission.js";

export interface SqliteLedgerStoreOpts {
  /** Concrete ledger database file path (created on init if absent). */
  dbPath: string;
  /**
   * The out-of-tree logs directory (T499) this store's `readLog` capability
   * confines reads to — `resolveLogsDir(projectKey)`, the sibling of the
   * `state/` sub-directory `dbPath` lives under (same `projectKey`, T495
   * layout). Optional: when absent, `readLog` throws {@link
   * ReadLogNotImplementedError}, mirroring the in-memory store's documented
   * behaviour (e.g. a test constructing a bare store with no logs area).
   */
  logsDir?: string;
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
  /** Test-only synchronous hook reached immediately after `BEGIN IMMEDIATE`. */
  planSerializationBoundaryHook?: PlanLifecycleSerializationBoundaryHook;
  /**
   * Policy for a persisted canonical-ledger schema that diverged from canon
   * (detected at init(), same detection as AbstractLedgerStore via
   * schemasEqual/schemaCompatible):
   *
   * - `'abort'` (default, {@link DEFAULT_ON_SCHEMA_DIVERGENCE}): refuse to
   *   start — throw `BootstrapViolationError` — leaving every row untouched,
   *   so the divergence is loud and operator-handled.
   * - `'backup-reinit'`: `VACUUM INTO` a timestamped sibling snapshot (T529),
   *   then wipe every row and reseed fresh canonical state.
   */
  onSchemaDivergence?: "backup-reinit" | "abort";
  /**
   * Consent to `'backup-reinit'` DESTROYING a store that already holds user
   * data. Default `false` — without it, a populated store REFUSES to reinit
   * even when the policy says `'backup-reinit'` (D170).
   *
   * WHY THIS EXISTS: the ledger was destroyed TWICE on 2026-07-27 (1147 then
   * 1155 active items, plus 2278 archived, replaced by a single bootstrap
   * milestone). Neither wipe came from production code — production never
   * passes a policy and so always takes `'abort'` — but test-shaped code passes
   * `'backup-reinit'` in many places, and two different code paths reached the
   * REAL store: one from an agent worktree, one presenting the main-checkout
   * path. Guarding the RESOLUTION routes proved to be whack-a-mole; guarding
   * the DESTRUCTION is route-independent, which is why this gate exists.
   *
   * A store that is merely bootstrapped (the immortal `M-AMBIENT` milestone and
   * nothing else) is NOT populated, so ordinary fresh-store tests are
   * unaffected. A test that genuinely wants to exercise reinit over real rows
   * must say so explicitly, in the clear.
   */
  allowDestructiveReinitOfPopulatedStore?: boolean;
  /**
   * T1957 — options for the project {@link WorksetStore} mounted on this
   * database after init (hooks / validators for contract fixtures).
   * WorksetStore is a separate capability from LedgerStore (both expose a
   * `snapshot` method with different return types), obtained via
   * {@link SqliteLedgerStore.worksetStore}.
   */
  workset?: CreateInMemoryWorksetStoreOptions;
  /** Runtime-only authority for destructive divergence reinitialization. */
  worksetAuthority?: unknown;
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

interface PlanRecordRow {
  scope: string;
  record_json: string;
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

export class SqliteLedgerStore implements LedgerStore, PlanLifecycleStore {
  private readonly dbPath: string;
  private readonly logsDir: string | undefined;
  private readonly now: () => string;
  /** Fired post-COMMIT by {@link fireMutation}; guarded. */
  protected readonly onMutation: OnMutation | null;
  private readonly planSerializationBoundaryHook: PlanLifecycleSerializationBoundaryHook | null;
  private readonly onSchemaDivergence: "backup-reinit" | "abort";
  /** D170 destructive-intent gate — see {@link SqliteLedgerStoreOpts}. */
  private readonly allowDestructiveReinitOfPopulatedStore: boolean;
  private readonly worksetOptions: CreateInMemoryWorksetStoreOptions;
  private readonly worksetAuthority: unknown;
  private handle: Database | null = null;
  private initialised = false;
  /** T1957 project workset capability; created in {@link init}, cleared on dispose. */
  private worksetHandle: WorksetStore | null = null;
  /**
   * Derived full-text index over the committed item rows (T528) — the SAME
   * `LedgerSearchIndex` the fs/in-memory stores use, so ftsSearch semantics
   * are shared verbatim. Cold-built on init(); each mutation upserts/moves
   * ONLY its own doc post-commit (T538/D87 — O(1), no bucket rebuild); a
   * peer process's commit is folded in by {@link invalidate} (the T530
   * coherence watcher's refresh path), the only post-init full rebuild.
   */
  private readonly searchIndex = new LedgerSearchIndex();
  private readonly taskAdoptionFences = new TaskAdoptionFenceRegistry();

  constructor(opts: SqliteLedgerStoreOpts) {
    this.dbPath = opts.dbPath;
    this.logsDir = opts.logsDir;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onMutation = opts.onMutation ?? null;
    this.planSerializationBoundaryHook = opts.planSerializationBoundaryHook ?? null;
    this.onSchemaDivergence = opts.onSchemaDivergence ?? DEFAULT_ON_SCHEMA_DIVERGENCE;
    this.allowDestructiveReinitOfPopulatedStore =
      opts.allowDestructiveReinitOfPopulatedStore ?? false;
    this.worksetOptions = opts.workset ?? {};
    this.worksetAuthority =
      opts.worksetAuthority ?? createObserveOnlyWorksetInvocationAuthority();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;
    const db = openLedgerDb(this.dbPath);
    ensureSchema(db);

    // v1→v2 in-place migration (T553, G80/M245): settle every stored
    // dependsOn/blockedBy entry on the canonical `<ledger>:<id>` form and
    // give canonical ledgers a schema_json carrying satisfiesDependencyStatuses.
    // Runs BEFORE Pass 1 so the divergence check sees the already-canonicalized
    // schemas; a strict no-op on a store already at SCHEMA_VERSION.
    this.migrateStoredRefsToV2(db);

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
      // ledger's — including workset_state so roots survive in the artifact)
      // BEFORE any row is touched, emit the stderr WARNING naming that locator,
      // then wipe every row and reseed fresh canonical state under exclusive
      // administrative admission (T1959). Live roots become unrestricted empty.
      // This read-only preflight preserves the substantive D170 refusal for
      // ordinary callers; management repeats it under exclusion before mutation.
      this.assertDivergenceReinitAllowed(db, divergent);
      const tempWorkset = createSqliteWorksetStore({ db, ...this.worksetOptions });
      try {
        await tempWorkset.runAdministrative({
          kind: "divergence-reinitialization",
          authority: this.worksetAuthority,
          destructivePhase: () => {
            // D170 DESTRUCTIVE-INTENT GATE — re-evaluate only after exclusion
            // drains admitted mutations, before the backup or any destructive
            // write. A mutation that completed while exclusion was being
            // acquired therefore cannot slip past the population check.
            this.assertDivergenceReinitAllowed(db, divergent);
            const backupPath = this.backupDivergentState(db);
            process.stderr.write(
              `WARNING: LedgerStore divergence detected — prior state backed up to ${backupPath}\n`,
            );
            db.transaction(() => {
              db.exec("DELETE FROM workset_admissions");
              db.exec("DELETE FROM plan_operations");
              db.exec("DELETE FROM plan_claims");
              db.exec("DELETE FROM archived_items");
              db.exec("DELETE FROM archive_pointers");
              db.exec("DELETE FROM items");
              db.exec("DELETE FROM groups");
              db.exec("DELETE FROM ledgers");
              db.query(
                "UPDATE workset_state SET epoch = 0, roots_json = ? WHERE id = 1",
              ).run("[]");
            })();
            this.bootstrapCanonicalRows(
              db,
              CANONICAL_LEDGERS.map((c) => c.name),
              [],
            );
          },
        });
      } catch (error) {
        db.close();
        throw error;
      }
    } else {
      // Pass 2 — bootstrap writes, atomically: provision missing canonical
      // ledgers, apply widening upgrades, seed the milestones bootstrap
      // active group + the immortal M-AMBIENT milestone (parity with
      // seedBootstrapGroup + applyEnsureAmbientMilestone).
      this.bootstrapCanonicalRows(db, missing, widened);
    }

    this.handle = db;
    this.initialised = true;
    // T1957: mount the project WorksetStore over the same connection. Roots
    // and admissions share the ledger.db WAL; snapshot always re-reads rows so
    // peer commits are visible without a separate invalidate path.
    this.worksetHandle = createSqliteWorksetStore({
      db,
      ...this.worksetOptions,
    });

    // Cold-build the derived search index from the committed rows — one
    // ACTIVE + one ARCHIVED bucket per ledger. Guarded per ledger inside the
    // helpers; must stay within the T498 <500ms@10k target (T531 verifies).
    for (const name of this.enumerate()) {
      this.rebuildLedgerIndexActive(name);
      this.refreshLedgerIndexArchived(name);
    }
  }

  /**
   * T1957 — project {@link WorksetStore} over this database. Separate from
   * {@link LedgerStore} because both surfaces define `snapshot` with different
   * return types. Requires {@link init}.
   */
  worksetStore(): WorksetStore {
    this.assertInit();
    if (this.worksetHandle === null) {
      throw new LedgerError("SqliteLedgerStore workset capability is not mounted");
    }
    return this.worksetHandle;
  }

  /**
   * Duck-typed BackupDump source (T1959): emit portable `workset-roots.json`.
   */
  exportWorksetRootsState(): string {
    this.assertInit();
    const snap = this.worksetStore().snapshot();
    // snapshot() is sync on the sqlite backend.
    return serializeWorksetRootsDocument(snap as { roots: readonly string[]; epoch: number });
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
    return this.vacuumIntoSibling(db, "backup");
  }

  /**
   * Count rows that represent USER DATA, for the D170 destructive-intent gate.
   *
   * A freshly bootstrapped store holds exactly the immortal `M-AMBIENT`
   * milestone and its `active` group, so that state must NOT count as populated
   * — otherwise every ordinary fresh-store test would need the consent flag.
   * Anything beyond it (any other item, any archived item, any archive pointer)
   * is data a human or a flow put there, and losing it is the D170 incident.
   *
   * Counted on the OPEN handle before any mutation, so the numbers reported in
   * the refusal are exactly what would have been destroyed.
   */
  private countUserRows(db: Database): {
    items: number;
    archivedItems: number;
    archivePointers: number;
    worksetState: number;
    total: number;
  } {
    const scalar = (sql: string): number => {
      const row = db.query(sql).get() as { c: number } | null;
      return row === null ? 0 : row.c;
    };
    // Exclude ONLY the bootstrap milestone row, matched by exact ledger + id
    // through placeholders (never interpolation).
    const itemsRow = db
      .query<{ c: number }, [string, string]>(
        "SELECT count(*) AS c FROM items WHERE NOT (ledger = ? AND id = ?)",
      )
      .get(MILESTONES_LEDGER, MILESTONES_AMBIENT_ID);
    const items = itemsRow === null ? 0 : itemsRow.c;
    const archivedItems = scalar("SELECT count(*) AS c FROM archived_items");
    const archivePointers = scalar("SELECT count(*) AS c FROM archive_pointers");
    const worksetRow = db
      .query<{ roots_json: string; epoch: number }, []>(
        "SELECT roots_json, epoch FROM workset_state WHERE id = 1",
      )
      .get();
    const worksetState =
      worksetRow !== null &&
      (worksetRow.epoch !== 0 || (JSON.parse(worksetRow.roots_json) as unknown[]).length !== 0)
        ? 1
        : 0;
    return {
      items,
      archivedItems,
      archivePointers,
      worksetState,
      total: items + archivedItems + archivePointers + worksetState,
    };
  }

  private assertDivergenceReinitAllowed(db: Database, divergent: readonly string[]): void {
    const userRows = this.countUserRows(db);
    if (userRows.total === 0 || this.allowDestructiveReinitOfPopulatedStore) return;
    throw new BootstrapViolationError(
      `refusing to reinitialise a POPULATED ledger: ${divergent.join(", ")} ledger(s) ` +
        `diverged from canon, and onSchemaDivergence='backup-reinit' would DESTROY ` +
        `${userRows.items} item(s), ${userRows.archivedItems} archived item(s) and ` +
        `${userRows.archivePointers} archive pointer(s), plus ` +
        `${userRows.worksetState} substantive workset root state at ${this.dbPath}. No data was ` +
        `touched. Either resolve the divergence (the usual cause is a build whose canon ` +
        `differs from the persisted schema — deploy/rebuild so they match), or, if you ` +
        `genuinely intend to erase this store, pass ` +
        `allowDestructiveReinitOfPopulatedStore: true. D170: this path destroyed the live ` +
        `ledger twice on 2026-07-27.`,
    );
  }

  /**
   * `VACUUM INTO` a `<dbPath-stem>.<label>-<ts><ext>` sibling of `dbPath` — a
   * byte-complete point-in-time snapshot of the WHOLE database, taken BEFORE
   * any row is touched. Shared by the T529 divergence backup and the T553
   * pre-migration snapshot. Must run OUTSIDE any transaction (VACUUM refuses to
   * run inside one). Returns the snapshot file's path.
   */
  private vacuumIntoSibling(db: Database, label: string): string {
    const ts = this.now().replace(/:/g, "-");
    const ext = path.extname(this.dbPath);
    const base = ext.length > 0 ? this.dbPath.slice(0, -ext.length) : this.dbPath;
    const dest = `${base}.${label}-${ts}${ext}`;
    db.query("VACUUM INTO ?").run(dest);
    return dest;
  }

  /**
   * Versioned in-place v1→v2 migration (T553, G80/M245 — the final
   * expand-then-migrate step). READ meta('schema_version'); when it is already
   * at {@link SCHEMA_VERSION} this is a STRICT no-op (opening a v2 store touches
   * nothing). Otherwise, for a v1 store:
   *
   *  (a) SNAPSHOT the whole db FIRST via `VACUUM INTO` a timestamped sibling
   *      (OUTSIDE the transaction — VACUUM cannot run inside one), with a
   *      stderr locator line, so the pre-migration state is always recoverable.
   *  (b) In ONE immediate write transaction, rewrite every `items` AND
   *      `archived_items` row's `fields_json` dependsOn/blockedBy entries to the
   *      canonical prefixed form by exact alpha-prefix resolution against the
   *      SAME registry the writers use (canonical + custom ledgers present in
   *      this store). An entry that does not resolve (free-text, unknown alpha
   *      prefix, the dash-bearing M-AMBIENT) is preserved VERBATIM — the
   *      migration NEVER destroys data — with a single stderr warning per store.
   *  (c) Rewrite `ledgers.schema_json` to the current canonical schema (now
   *      carrying satisfiesDependencyStatuses) for CANONICAL ledgers only —
   *      Pass 1's schemasEqual ignores satisfiesDependencyStatuses, so it would
   *      NOT upgrade this facet on its own. Custom ledgers are left untouched.
   *  (d) Bump meta('schema_version') to {@link SCHEMA_VERSION}.
   *
   * Idempotent: because (b) canonicalizes to a fixed point and the version gate
   * skips an already-v2 store, running twice yields byte-identical rows.
   */
  private migrateStoredRefsToV2(db: Database): void {
    const versionRow = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: number;
    } | null;
    const version = versionRow === null ? 1 : Number(versionRow.value);
    if (version >= SCHEMA_VERSION) return;

    // v2→v3 (T1509/G155), v3→v4 (T1957/G158), and v4→v5: additive DDL only
    // (mcp_usage_stats; workset tables; domain coherence counter/triggers), which
    // ensureSchema already applied idempotently at open — bump the marker
    // WITHOUT the v1 snapshot/rewrite churn.
    if (version >= 2) {
      db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
      return;
    }

    // (a) Snapshot BEFORE any write, OUTSIDE the transaction.
    const snapshotPath = this.vacuumIntoSibling(db, "pre-v2-migration");
    process.stderr.write(
      `WARNING: LedgerStore schema v${version}→v${SCHEMA_VERSION} migration — ` +
        `pre-migration snapshot written to ${snapshotPath}\n`,
    );

    let anyUnresolved = false;
    immediateWriteTransaction(db, () => {
      const ledgerRows = db.query("SELECT name, schema_json FROM ledgers").all() as Array<{
        name: string;
        schema_json: string;
      }>;
      // Registry spans every registered ledger (canonical + custom) — the same
      // input buildRefValidationContext feeds the writers, so the migration
      // resolves bare ids exactly as a subsequent write would.
      const registry = buildPrefixRegistry(
        ledgerRows.map((r) => ({
          name: r.name,
          schema: JSON.parse(r.schema_json) as LedgerSchema,
        })),
      );

      // (b) Canonicalize dependsOn/blockedBy in active AND archived rows.
      for (const table of ["items", "archived_items"] as const) {
        const rows = db.query(`SELECT rowid AS rid, fields_json FROM ${table}`).all() as Array<{
          rid: number;
          fields_json: string;
        }>;
        const update = db.query(`UPDATE ${table} SET fields_json = ? WHERE rowid = ?`);
        for (const row of rows) {
          const fields = JSON.parse(row.fields_json) as Record<string, FieldValue>;
          const result = normalizeStoredRefFields(fields, registry);
          if (result.unresolved) anyUnresolved = true;
          if (!result.changed) continue;
          update.run(JSON.stringify(result.fields), row.rid);
        }
      }

      // (c) Refresh CANONICAL ledgers' schema_json to canon (custom untouched).
      const present = new Set(ledgerRows.map((r) => r.name));
      const upgradeSchema = db.query("UPDATE ledgers SET schema_json = ? WHERE name = ?");
      for (const canonical of CANONICAL_LEDGERS) {
        if (!present.has(canonical.name)) continue;
        upgradeSchema.run(JSON.stringify(canonical.schema), canonical.name);
      }

      // (d) Bump the on-disk schema version.
      db.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
    });

    if (anyUnresolved) {
      process.stderr.write(
        `WARNING: LedgerStore v${SCHEMA_VERSION} migration left one or more ` +
          `dependsOn/blockedBy entries VERBATIM (free-text or unknown prefix — data preserved)\n`,
      );
    }
  }

  /**
   * Checkpoint the WAL into the main db file, then close the connection so no
   * lingering handle/lock survives (the T497 harness + conformance teardown
   * rely on this releasing the file). A fresh store can reopen the same path.
   */
  async dispose(): Promise<void> {
    this.worksetHandle = null;
    if (this.handle !== null) {
      this.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.handle.close();
      this.handle = null;
    }
    this.initialised = false;
  }

  /** I20/G155, T1509: atomically increment per-project usage counters. */
  async recordMcpUsage(endpoint: string, bytesIn: number, bytesOut: number): Promise<void> {
    this.assertInit();
    this.db()
      .query(
        `INSERT INTO mcp_usage_stats (endpoint, call_count, bytes_in, bytes_out)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           call_count = call_count + 1,
           bytes_in = bytes_in + excluded.bytes_in,
           bytes_out = bytes_out + excluded.bytes_out`,
      )
      .run(endpoint, bytesIn, bytesOut);
  }

  /** I20/G155, T1509: accumulated usage snapshot (name-sorted + totals). */
  async fetchMcpUsageStats(): Promise<UsageStatsSnapshot> {
    this.assertInit();
    const rows = this.db()
      .query(
        "SELECT endpoint, call_count, bytes_in, bytes_out FROM mcp_usage_stats ORDER BY endpoint",
      )
      .all() as Array<{ endpoint: string; call_count: number; bytes_in: number; bytes_out: number }>;
    const endpoints = rows.map((row) => ({
      name: row.endpoint,
      callCount: row.call_count,
      bytesIn: row.bytes_in,
      bytesOut: row.bytes_out,
    }));
    const totals = endpoints.reduce(
      (acc, endpoint) => ({
        name: "totals",
        callCount: acc.callCount + endpoint.callCount,
        bytesIn: acc.bytesIn + endpoint.bytesIn,
        bytesOut: acc.bytesOut + endpoint.bytesOut,
      }),
      { name: "totals", callCount: 0, bytesIn: 0, bytesOut: 0 },
    );
    return { endpoints, totals };
  }

  /**
   * Bounded, root-confined read of a log file under the out-of-tree logs area
   * (T499) — the xdg backend's `read_log` capability, the analogue of {@link
   * FsLedgerStore.readLog} (T147/Q87) rooted at `this.logsDir`
   * (`resolveLogsDir(projectKey)`, T495 layout) instead of `<root>/.cq/logs`.
   * Mirrors the FS capability's confinement + TOCTOU defences EXACTLY (D26/
   * D28): absolute paths rejected; a leading `.cq/logs/` prefix stripped
   * (sessionLogs/rawLogs store that repo-relative form regardless of backend);
   * lexical + realpath containment against `..`/symlink escape; oversized
   * content truncated to {@link MAX_READ_LOG_BYTES} and flagged
   * `truncated: true`.
   *
   * Throws {@link ReadLogNotImplementedError} when this store was constructed
   * with no `logsDir` (mirrors the in-memory store's documented behaviour).
   */
  async readLog(relPath: string): Promise<ReadLogResult> {
    if (this.logsDir === undefined) {
      throw new ReadLogNotImplementedError();
    }
    const logsDir = this.logsDir;

    if (path.isAbsolute(relPath)) {
      throw new LedgerError(`read_log: absolute paths are not allowed: ${relPath}`);
    }
    // sessionLogs/rawLogs store REPO-relative paths (".cq/logs/<file>")
    // regardless of backend; strip a leading .cq/logs/ so it is not doubled
    // into <logsDir>/.cq/logs/<file>. A path already relative to logsDir
    // ("<file>") is unaffected.
    const rel = relPath.replace(LEDGER_LOGS_STRIP_RE, "");
    const resolved = path.resolve(logsDir, rel);
    if (resolved !== logsDir && !resolved.startsWith(logsDir + path.sep)) {
      throw new LedgerError(
        `read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`,
      );
    }

    // Re-assert containment after symlink resolution (D26): a symlink whose
    // lexical path is inside logsDir may point outside the confinement root.
    // D28: hoist `real` outside the try block so the subsequent readFile uses
    // the validated canonical path, closing the check-then-use TOCTOU.
    let real: string | undefined;
    try {
      real = await fs.realpath(resolved);
      let realLogsDir: string;
      try {
        realLogsDir = await fs.realpath(logsDir);
      } catch {
        // logsDir doesn't exist yet — a missing file read will ENOENT below.
        realLogsDir = logsDir;
      }
      if (real !== realLogsDir && !real.startsWith(realLogsDir + path.sep)) {
        throw new LedgerError(
          `read_log: path escapes ${LEDGER_LOGS_RELATIVE_PREFIX} root: ${relPath}`,
        );
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      // ENOENT: file doesn't exist — fall through so readFile surfaces it.
    }

    const buf = await fs.readFile(real ?? resolved);
    if (buf.byteLength > MAX_READ_LOG_BYTES) {
      const content = buf.subarray(0, MAX_READ_LOG_BYTES).toString("utf8");
      return { path: relPath, content, truncated: true };
    }
    return { path: relPath, content: buf.toString("utf8") };
  }

  // ---------------------------------------------------------------------------
  // Reads — every method re-queries rows; WAL guarantees the latest committed
  // state, so there is no cache to keep coherent.
  // ---------------------------------------------------------------------------

  enumerate(): string[] {
    const rows = this.db().query("SELECT name FROM ledgers ORDER BY name").all() as Array<{
      name: string;
    }>;
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
    return this.read(() => buildSnapshot(this.enumerate().map((name) => this.fetchView(name))));
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
   * peer commit — surfaced by the xdg domain-state coherence watcher —
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

  async updateMilestone(milestoneId: string, patch: UpdateMilestoneItemPatch): Promise<Item> {
    const item = immediateWriteTransaction(this.db(), () => {
      const shim = this.singleItemShim(MILESTONES_LEDGER, milestoneId);
      const x = applyUpdateMilestoneItem(
        shim,
        milestoneId,
        patch,
        this.now(),
        this.buildRefValidationContext(),
        this.nonTerminalChildren(milestoneId),
      );
      this.persistItemRow(MILESTONES_LEDGER, x);
      return x;
    });
    // Hook fires AFTER commit per the D-COHERENCE contract.
    this.indexUpsertActive(MILESTONES_LEDGER, item);
    this.fireMutation(MILESTONES_LEDGER, "update");
    return item;
  }

  /** D267/T1856: active children of `milestoneId` whose status is
   * non-terminal in their own ledger, as sorted `<ledger>:<id>` refs. */
  private nonTerminalChildren(milestoneId: string): string[] {
    const blockers: string[] = [];
    const schemas = this.db()
      .query("SELECT name, schema_json FROM ledgers")
      .all() as Array<{ name: string; schema_json: string }>;
    const childQuery = this.db().query(
      "SELECT id, status FROM items WHERE ledger = ? AND milestone_id = ?",
    );
    for (const row of schemas) {
      if (row.name === MILESTONES_LEDGER) continue;
      const terminal = new Set((JSON.parse(row.schema_json) as LedgerSchema).terminalStatuses);
      for (const child of childQuery.all(row.name, milestoneId) as Array<{
        id: string;
        status: string;
      }>) {
        if (!terminal.has(child.status)) blockers.push(`${row.name}:${child.id}`);
      }
    }
    return blockers.sort();
  }

  async updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      // Canonical disposition (D267/T1856): one delegated path.
      return this.updateMilestone(itemId, validateMilestoneItemPatch(patch));
    }
    const contender = rawTaskSerializationContender(ledgerId, patch.status);
    const item = immediateWriteTransaction(this.db(), () => {
      if (contender !== null) this.reachPlanSerializationBoundary(contender);
      const shim = this.singleItemShim(ledgerId, itemId);
      assertRawPlanUpdateAllowed(
        (id) => this.loadLedger(id),
        ledgerId,
        shim,
        itemId,
        patch,
      );
      const precondition = this.statusChangePrecondition(ledgerId, shim, itemId, patch);
      const x = applyUpdateItem(
        shim,
        itemId,
        patch,
        this.now(),
        precondition,
        this.buildRefValidationContext(),
      );
      this.persistItemRow(ledgerId, x);
      return x;
    });
    this.indexUpsertActive(ledgerId, item);
    this.fireMutation(ledgerId, "update");
    return item;
  }

  async createItem(ledgerId: string, milestoneId: string, init: CreateItemInit): Promise<Item> {
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
      assertRawPlanCreateAllowed((id) => this.loadLedger(id), ledgerId, init.fields);
      // T538 (D87): a MINIMAL shim of the target ledger (targeted row
      // queries) instead of materialising all N rows via loadLedger.
      const shim = this.createItemShim(ledgerId, milestoneId, init.id);
      const refCtx = this.buildRefValidationContext();
      return this.insertItemViaCore(shim, init.id, (l) =>
        applyCreateItem(l, milestoneId, init, this.now(), refCtx),
      );
    });
    this.indexUpsertActive(ledgerId, item);
    this.fireMutation(ledgerId, "create");
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = immediateWriteTransaction(this.db(), () => {
      const ledger = this.loadLedger(MILESTONES_LEDGER);
      const refCtx = this.buildRefValidationContext();
      return this.insertItemViaCore(ledger, init.id, (l) =>
        applyCreateMilestoneItem(l, init, this.now(), refCtx),
      );
    });
    this.indexUpsertActive(MILESTONES_LEDGER, item);
    this.fireMutation(MILESTONES_LEDGER, "create");
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
    const view = immediateWriteTransaction(this.db(), () => {
      const rows = this.db().query("SELECT name, schema_json FROM ledgers").all() as Array<{
        name: string;
        schema_json: string;
      }>;
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
      const source = findItem(shim, itemId).item;
      if (ledgerId === GOALS_LEDGER) {
        assertManagedGoalTransitionAllowed(source, toStatus);
      }
      if (ledgerId === TASKS_LEDGER) {
        assertManagedTaskTransitionAllowed(
          (id) => this.loadLedger(id),
          source,
          toStatus,
        );
      }
      const x = applyReopenItem(shim, itemId, toStatus, this.now());
      // D267/T1856: resurrection respects parent liveness.
      assertMilestoneActive(this.loadLedger(MILESTONES_LEDGER), source.milestoneId);
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
  async unarchiveItem(ledgerId: string, milestoneId: string, itemId: string): Promise<Item> {
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
      if (!new Set(ledger.schema.terminalStatuses).has(archivedRow.status)) {
        // D267/T1856: reject BEFORE re-attachment — a non-terminal item must
        // not reappear under an absent/archived/terminal parent (the archived
        // status was read authoritatively in this transaction).
        assertMilestoneActive(this.loadLedger(MILESTONES_LEDGER), archivedRow.milestone_id);
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
      db.query("DELETE FROM archived_items WHERE ledger = ? AND pointer_id = ? AND id = ?").run(
        ledgerId,
        milestoneId,
        itemId,
      );
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
    // (indexMoveToActive; see its doc comment re: D88 docId scoping) instead
    // of rebuilding both buckets.
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
      throw new LedgerError(
        `SqliteLedgerStore: archiveMilestone(${milestoneId}) produced no pointer`,
      );
    }
    return pointer;
  }

  async captureTaskAdoptionEligibility(taskId: string): Promise<TaskAdoptionEligibilityResult> {
    const observation = immediateWriteTransaction(this.db(), () =>
      this.observeTaskAdoptionEligibility(taskId),
    );
    return this.taskAdoptionFences.capture(taskId, observation);
  }

  async publishTaskAdoption(
    fence: TaskAdoptionEligibilityFence,
    publish: () => undefined,
  ): Promise<TaskAdoptionPublicationResult> {
    const taskId = this.taskAdoptionFences.taskId(fence);
    if (taskId === null) return { status: "invalid-fence" };
    return immediateWriteTransaction(this.db(), () =>
      this.taskAdoptionFences.compareAndPublish(
        fence,
        this.observeTaskAdoptionEligibility(taskId),
        publish,
      ),
    );
  }

  async claimPlan(input: PlanClaimInput): Promise<PlanClaimResult> {
    return this.runPlanLifecycleMutation(
      (state) => claimInMemoryPlan(state, input),
      input.purpose === "follow-up" ? "follow-up-claim" : null,
    );
  }

  async publishPlanDraft(input: PlanPublishDraftInput): Promise<PlanPublishDraftResult> {
    return this.runPlanLifecycleMutation((state) => publishInMemoryPlanDraft(state, input), null);
  }

  async releasePlanClaim(input: PlanReleaseInput): Promise<PlanReleaseResult> {
    return this.runPlanLifecycleMutation((state) => releaseInMemoryPlanClaim(state, input), null);
  }

  async finalizePlan(input: PlanFinalizeInput): Promise<PlanFinalizeResult> {
    return this.runPlanLifecycleMutation((state) => finalizeInMemoryPlan(state, input), null);
  }

  async mutateOperatorAction(
    mutation: OperatorActionLifecycleMutation,
  ): Promise<OperatorActionLifecycleMutationResult> {
    return this.runPlanLifecycleMutation(
      (state) => applyOperatorActionLifecycleMutation(state.ledgers, mutation, state.now),
      null,
    );
  }

  // ---------------------------------------------------------------------------
  // Internals — write path (T527)
  // ---------------------------------------------------------------------------

  private observeTaskAdoptionEligibility(taskId: string): TaskAdoptionEligibilityObservation {
    const active = this.loadLedger(TASKS_LEDGER).milestones.flatMap(({ items }) => items);
    const archived = this.db()
      .query(
        "SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM archived_items WHERE ledger = ? ORDER BY rowid",
      )
      .all(TASKS_LEDGER) as ItemRow[];
    return observeTaskAdoptionEligibility(taskId, active, archived.map(rowToItem));
  }

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
   * Duck-typed BackupDump source (D139): emit plan-lifecycle.json from the
   * durable plan_claims/plan_operations rows.
   */
  exportPlanLifecycleState(): string | null {
    this.assertInit();
    const state = this.loadPlanLifecycleState();
    if (state.claims.size === 0 && state.operations.size === 0) return null;
    return serializePlanLifecycleDump(state);
  }

  private runPlanLifecycleMutation<T>(
    mutate: (state: InMemoryPlanLifecycleState) => InMemoryPlanMutation<T>,
    contender: PlanLifecycleSerializationContender | null,
  ): T {
    const mutation = immediateWriteTransaction(this.db(), () => {
      if (contender !== null) this.reachPlanSerializationBoundary(contender);
      const state = this.loadPlanLifecycleState();
      const result = mutate(state);
      for (const ledgerId of new Set(result.dirtyLedgers)) {
        const ledger = state.ledgers.get(ledgerId);
        if (ledger === undefined) {
          throw new LedgerError(`ledger not found: ${ledgerId}`);
        }
        this.replaceActiveLedger(ledger);
      }
      this.persistPlanRecords("plan_claims", state.claims);
      this.persistPlanRecords("plan_operations", state.operations);
      return result;
    });
    for (const ledgerId of this.enumerate()) {
      this.rebuildLedgerIndexActive(ledgerId);
    }
    for (const ledgerId of new Set(mutation.dirtyLedgers)) {
      this.fireMutation(ledgerId, "update");
    }
    return mutation.result;
  }

  /** Run one owned lifecycle operation in one BEGIN IMMEDIATE transaction. */
  async runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T): Promise<T> {
    this.assertInit();
    const outcome = immediateWriteTransaction(this.db(), () => {
      const state = this.loadPlanLifecycleState();
      const archivedIds = state.archivedIds ?? new Map<string, Set<string>>();
      const owned = createOwnedWriteTransaction({
        ledgers: state.ledgers,
        now: this.now,
        archivedRefExists: (ledgerId, itemId) =>
          archivedIds.get(ledgerId)?.has(itemId) ?? false,
      });
      const result = mutate(owned.tx);
      const dirtyLedgers = [...owned.dirtyLedgers];
      for (const ledgerId of dirtyLedgers) {
        const ledger = state.ledgers.get(ledgerId);
        if (ledger === undefined) throw new LedgerError(`ledger not found: ${ledgerId}`);
        this.replaceActiveLedger(ledger);
      }
      return { result, dirtyLedgers };
    });
    for (const ledgerId of outcome.dirtyLedgers) {
      this.rebuildLedgerIndexActive(ledgerId);
      this.fireMutation(ledgerId, "update");
    }
    return outcome.result;
  }

  /** Run one guarded plan operation inside one BEGIN IMMEDIATE transaction. */
  async runAtomicWorksetPlanLifecycleMutation<T>(
    _goalId: string,
    mutate: (tx: WorksetPlanLifecycleTx) => T,
  ): Promise<T> {
    this.assertInit();
    const outcome = immediateWriteTransaction(this.db(), () => {
      const state = this.loadPlanLifecycleState();
      const lifecycle = createWorksetPlanLifecycleTransaction(state);
      const result = mutate(lifecycle.tx);
      const dirtyLedgers = [...lifecycle.dirtyLedgers];
      for (const ledgerId of dirtyLedgers) {
        const ledger = state.ledgers.get(ledgerId);
        if (ledger === undefined) throw new LedgerError(`ledger not found: ${ledgerId}`);
        this.replaceActiveLedger(ledger);
      }
      if (dirtyLedgers.length > 0) {
        this.persistPlanRecords("plan_claims", state.claims);
        this.persistPlanRecords("plan_operations", state.operations);
      }
      return { result, dirtyLedgers };
    });
    for (const ledgerId of this.enumerate()) {
      this.rebuildLedgerIndexActive(ledgerId);
    }
    for (const ledgerId of outcome.dirtyLedgers) {
      this.fireMutation(ledgerId, "update");
    }
    return outcome.result;
  }

  /** Run one generic mutation in one BEGIN IMMEDIATE transaction. */
  async runAtomicGenericMutation<T>(
    mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
  ): Promise<T> {
    this.assertInit();
    const outcome = immediateWriteTransaction(this.db(), () => {
      const db = this.db();
      const ledgers = new Map(
        this.enumerate().map((ledgerId) => [ledgerId, this.loadLedger(ledgerId)]),
      );
      const archives = new Map<string, GenericArchiveEntry>();
      const archivedRows = db
        .query(
          "SELECT ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session FROM archived_items ORDER BY rowid",
        )
        .all() as Array<ItemRow & { ledger: string; pointer_id: string }>;
      for (const row of archivedRows) {
        const key = genericArchiveKey(row.ledger, row.pointer_id);
        let entry = archives.get(key);
        if (entry === undefined) {
          entry = { ledgerId: row.ledger, pointerId: row.pointer_id, items: [] };
          archives.set(key, entry);
        }
        entry.items.push(rowToItem(row));
      }
      const rootsRow = db
        .query("SELECT epoch, roots_json FROM workset_state WHERE id = 1")
        .get() as { epoch: number; roots_json: string } | null;
      const roots: WorksetRootsEpoch =
        rootsRow === null
          ? { roots: [], epoch: 0 }
          : {
              roots: JSON.parse(rootsRow.roots_json) as string[],
              epoch: rootsRow.epoch,
            };
      const transaction = createGenericMutationTransaction({
        ledgers,
        archives,
        now: this.now,
      });
      const result = mutate(transaction.tx, roots);
      for (const ledgerId of transaction.dirtyLedgers) {
        const ledger = ledgers.get(ledgerId);
        if (ledger === undefined) throw new LedgerNotFoundError(ledgerId);
        const exists = db.query("SELECT 1 FROM ledgers WHERE name = ?").get(ledgerId);
        if (exists === null) {
          db.query(
            "INSERT INTO ledgers (name, schema_json, milestone_counter, item_counter) VALUES (?, ?, 0, 0)",
          ).run(ledgerId, JSON.stringify(ledger.schema));
        }
        this.replaceActiveLedger(ledger);
      }
      for (const key of transaction.dirtyArchives) {
        const current = archives.get(key);
        const slash = key.indexOf("/");
        const ledgerId = current?.ledgerId ?? key.slice(0, slash);
        const pointerId = current?.pointerId ?? key.slice(slash + 1);
        db.query("DELETE FROM archived_items WHERE ledger = ? AND pointer_id = ?").run(
          ledgerId,
          pointerId,
        );
        db.query("DELETE FROM archive_pointers WHERE ledger = ? AND id = ?").run(
          ledgerId,
          pointerId,
        );
        if (current === undefined) continue;
        const pointer = ledgers
          .get(ledgerId)
          ?.archivePointers.find((candidate) => candidate.id === pointerId);
        if (pointer === undefined) throw new LedgerError(`missing archive pointer ${key}`);
        db.query(
          "INSERT INTO archive_pointers (ledger, id, summary, title, status, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(ledgerId, pointerId, pointer.summary, pointer.title, pointer.status, this.now());
        const insert = db.query(
          `INSERT INTO archived_items (ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of current.items) {
          insert.run(
            ledgerId,
            pointerId,
            item.id,
            item.milestoneId,
            item.status,
            JSON.stringify(item.fields),
            item.createdAt,
            item.updatedAt,
            item.author ?? null,
            item.session ?? null,
          );
        }
      }
      return {
        result,
        dirtyLedgers: [...transaction.dirtyLedgers],
        archivedChanged: transaction.dirtyArchives.size > 0,
      };
    });
    for (const ledgerId of outcome.dirtyLedgers) {
      this.rebuildLedgerIndexActive(ledgerId);
      if (outcome.archivedChanged) this.refreshLedgerIndexArchived(ledgerId);
      this.fireMutation(ledgerId, outcome.archivedChanged ? "archive" : "update");
    }
    return outcome.result;
  }

  private reachPlanSerializationBoundary(contender: PlanLifecycleSerializationContender): void {
    if (this.planSerializationBoundaryHook === null) return;
    const result = this.planSerializationBoundaryHook(contender);
    if (result instanceof Promise) {
      throw new LedgerError(
        "SqliteLedgerStore planSerializationBoundaryHook must complete synchronously",
      );
    }
  }

  private loadPlanLifecycleState(): InMemoryPlanLifecycleState {
    const ledgers = new Map(
      this.enumerate().map((ledgerId) => [ledgerId, this.loadLedger(ledgerId)]),
    );
    const claims = new Map<string, PlanPrivateClaimRecord>();
    for (const row of this.db()
      .query("SELECT scope, record_json FROM plan_claims")
      .all() as PlanRecordRow[]) {
      claims.set(row.scope, PlanPrivateClaimRecordSchema.parse(JSON.parse(row.record_json)));
    }
    const operations = new Map<string, InMemoryPlanOperationRecord>();
    for (const row of this.db()
      .query("SELECT scope, record_json FROM plan_operations")
      .all() as PlanRecordRow[]) {
      operations.set(row.scope, JSON.parse(row.record_json) as InMemoryPlanOperationRecord);
    }
    // D283: archived existence for plan-publish G80 parity with applyCreateItem.
    const archivedIds = new Map<string, Set<string>>();
    const archivedRows = this.db()
      .query("SELECT ledger, id FROM archived_items")
      .all() as Array<{ ledger: string; id: string }>;
    for (const row of archivedRows) {
      let set = archivedIds.get(row.ledger);
      if (set === undefined) {
        set = new Set();
        archivedIds.set(row.ledger, set);
      }
      set.add(row.id);
    }
    return { ledgers, claims, operations, now: this.now, archivedIds };
  }

  private persistPlanRecords<T>(
    table: "plan_claims" | "plan_operations",
    records: ReadonlyMap<string, T>,
  ): void {
    const statement = this.db().query(
      `INSERT INTO ${table} (scope, record_json) VALUES (?, ?)
       ON CONFLICT(scope) DO UPDATE SET record_json = excluded.record_json`,
    );
    for (const [scope, record] of records) {
      statement.run(scope, JSON.stringify(record));
    }
  }

  private replaceActiveLedger(ledger: Ledger): void {
    const db = this.db();
    db.query("DELETE FROM items WHERE ledger = ?").run(ledger.id);
    db.query("DELETE FROM groups WHERE ledger = ?").run(ledger.id);
    db.query("UPDATE ledgers SET milestone_counter = ?, item_counter = ? WHERE name = ?").run(
      ledger.counters.milestone,
      ledger.counters.item,
      ledger.id,
    );
    const insertGroup = db.query(
      "INSERT INTO groups (ledger, id, title, description) VALUES (?, ?, ?, ?)",
    );
    const insertItem = db.query(
      `INSERT INTO items (
         ledger, id, milestone_id, status, fields_json,
         created_at, updated_at, author, session
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const milestone of ledger.milestones) {
      insertGroup.run(ledger.id, milestone.id, milestone.title, milestone.description);
      for (const item of milestone.items) {
        insertItem.run(
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
      process.stderr.write(`LedgerStore: FTS active-upsert threw for ${ledgerId}: ${msg}\n`);
    }
  }

  /**
   * Move ONE doc active → archived (T538/D87 incremental form of the archive
   * transition). Active removal runs FIRST so the item is never transiently
   * indexed under both scopes at once; LedgerSearchIndex's docId is
   * scope-prefixed (D88 fix), so the two scopes' ids no longer collide and
   * this ordering is no longer load-bearing for correctness, only for
   * tidiness. GUARDED like every index update.
   */
  private indexMoveToArchived(ledgerId: string, item: Item): void {
    try {
      this.searchIndex.removeActiveDoc(ledgerId, item.id);
      this.searchIndex.upsertArchivedDoc(ledgerId, cloneItem(item));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`LedgerStore: FTS archive-move threw for ${ledgerId}: ${msg}\n`);
    }
  }

  /**
   * Move ONE doc archived → active (T538/D87 incremental form of the T529
   * unarchive transition). Archived removal runs FIRST so the item is never
   * transiently indexed under both scopes at once; LedgerSearchIndex's docId
   * is scope-prefixed (D88 fix), so the two scopes' ids no longer collide and
   * this ordering is no longer load-bearing for correctness, only for
   * tidiness. GUARDED like every index update.
   */
  private indexMoveToActive(ledgerId: string, item: Item): void {
    try {
      this.searchIndex.removeArchivedDoc(ledgerId, item.id);
      this.searchIndex.upsertActiveDoc(ledgerId, cloneItem(item));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`LedgerStore: FTS unarchive-move threw for ${ledgerId}: ${msg}\n`);
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
      process.stderr.write(`LedgerStore: FTS active-rebuild threw for ${ledgerId}: ${msg}\n`);
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
      process.stderr.write(`LedgerStore: FTS archived-refresh threw for ${ledgerId}: ${msg}\n`);
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

  /**
   * Build the cross-ledger {@link RefValidationContext} for a create/update
   * write (G80/M245). Must run INSIDE the write transaction so the registry +
   * existence probes see the same committed snapshot the write serializes
   * against. Prefix registry from the `ledgers` table; active existence from
   * `items`; ARCHIVED existence from `archived_items` (referencing an archived
   * item is legal). All probes are prepared statements reused per entry.
   */
  private buildRefValidationContext(): RefValidationContext {
    const db = this.db();
    const rows = db.query("SELECT name, schema_json FROM ledgers").all() as Array<{
      name: string;
      schema_json: string;
    }>;
    const registry = buildPrefixRegistry(
      rows.map((r) => ({ name: r.name, schema: JSON.parse(r.schema_json) as LedgerSchema })),
    );
    const activeQ = db.query("SELECT 1 FROM items WHERE ledger = ? AND id = ? LIMIT 1");
    const archivedQ = db.query("SELECT 1 FROM archived_items WHERE ledger = ? AND id = ? LIMIT 1");
    return {
      registry,
      refExists: (ledger: string, id: string): boolean =>
        activeQ.get(ledger, id) !== null || archivedQ.get(ledger, id) !== null,
    };
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
    const row = this.db().query("SELECT name FROM ledgers WHERE name = ?").get(ledgerId);
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
      archivePointers: pointerRows.map((p): ArchivePointer => ({
          id: p.id,
          path: `./archive/${name}/${p.id}.md`,
          summary: p.summary,
          title: p.title,
          status: p.status,
      })),
    };
  }

  private fetchView(ledgerId: string): FetchedLedger {
    return materialiseFetchedLedger(this.loadLedger(ledgerId), this.loadLedger(MILESTONES_LEDGER));
  }
}
