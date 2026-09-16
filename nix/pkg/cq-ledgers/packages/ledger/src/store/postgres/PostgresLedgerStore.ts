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
 * loaded on `init()`:
 *
 *  - Synchronous reads materialize views from the tenant's keyed active and
 *    archive cache. Ordinary committed changes patch only affected keys.
 *  - Mutations record a durable coherence version and exact changed keys in
 *    their domain transaction. A repeatable-read frame refreshes the cache
 *    and awaits worker-owned search projection before notification.
 *  - Invalidation and search reconcile versions newer than the acknowledged
 *    cursor. Whole snapshots are confined to cold start, explicit gaps,
 *    administrative replacement, and projection recovery.
 *  - Projection failure preserves committed results and defers notification.
 *    Search reports typed unavailability until recovery; synchronous reads
 *    also refuse a cache that has not loaded this instance's committed rows.
 *
 * Like SqliteLedgerStore, this implements the interface directly over rows
 * without a Markdown serialization funnel (K102), and reuses the pure
 * `core.ts` `apply*` guards VERBATIM so error types/results match the other
 * backends. Counters live in the `ledgers` table and are incremented INSIDE the
 * write transaction (`UPDATE … RETURNING`), so cross-instance id allocation
 * never collides.
 *
 * Scope (T573): the full LedgerStore surface + write-through + cache.
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
import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type {
  ArchivePointer,
  FetchedLedger,
  FieldValue,
  Item,
  Ledger,
  LedgerSchema,
} from "../../types.js";
import type { UsageStatsSnapshot } from "../../usageStats.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  ItemNotFoundError,
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
import type { PlanLifecycleRowRequest } from "../planLifecycleRowPlan.js";
import { runPostgresKeyedOperation } from "./operationKernel.js";
import { resolvePostgresPlanRows } from "./planRowOperation.js";
import { persistPostgresPlanRows } from "./planRowPersistence.js";
import { resolvePostgresOwnedRows } from "./ownedRowOperation.js";
import { assertOwnedMutationRows } from "../ownedMutationRows.js";
import type { OwnedMutationContext } from "../directOwnedMutation.js";
import { resolvePostgresDirectOwnedRows } from "./directOwnedRowOperation.js";
import { resolvePostgresGuardedPlanRows } from "./guardedPlanRowOperation.js";
import { resolvePostgresGenericRows } from "./genericRowOperation.js";
import { recordPostgresCoherence, postgresCoherenceVersion, readPostgresCoherence, type PostgresCoherenceChange } from "./coherenceVector.js";
import { PostgresReadCache } from "./readCache.js";
import { POSTGRES_RESET_CONTROL_ID } from "./coherenceChanges.js";
import { loadPostgresProjectionRows, loadPostgresProjectionSnapshot } from "./projectionRows.js";
import { createWorkerSearchProjection } from "../../search/WorkerSearchProjection.js";
import { SEARCH_PROJECTION_COMMAND_DEADLINE_MS, type SearchProjection, type SearchProjectionHealth } from "../../search/SearchProjection.js";
import { SearchProjectionRecovery, ProjectionUnavailableError, type ProjectionChangeFrame } from "../../search/SearchProjectionRecovery.js";
import { postgresPublicPlanChanges, postgresPrivatePlanChanges, postgresSelectedRowChanges, postgresArchivedRowChanges, POSTGRES_GROUP_CONTROL_PREFIX, POSTGRES_POINTER_CONTROL_PREFIX, POSTGRES_LEDGER_CONTROL_ID } from "./coherenceChanges.js";
import { persistPostgresGenericRows } from "./genericRowPersistence.js";
import type { AdmittedGenericMutation, AdmittedGenericMutationBinding } from "../../worksetGenericMutation.js";
import type { SqliteOperationAccessScope, SqliteOperationMeasurement } from "../sqlite/operationObservability.js";
import { assertKeyedPlanMutationChanges } from "../keyedWorksetPlanAuthorization.js";
import { persistPostgresPrivateRecords } from "./lifecycleRowRepository.js";
import { PostgresOperationQueries, type PostgresAccessObserver } from "./operationAccess.js";
import { resolvePostgresOperatorRows } from "./operatorRowOperation.js";
import type {
  InMemoryPlanLifecycleState,
  InMemoryPlanMutation,
  InMemoryPlanOperationRecord,
} from "../inMemoryPlanLifecycle.js";
import {
  claimInMemoryPlan,
  finalizeInMemoryPlan,
  publishInMemoryPlanDraft,
  releaseInMemoryPlanClaim,
} from "../inMemoryPlanLifecycle.js";
import {
  assertManagedGoalTransitionAllowed,
  assertManagedTaskTransitionAllowed,
  assertRawPlanCreateAllowed,
  assertRawPlanUpdateAllowed,
} from "../planLifecycleGuards.js";
import {
  decodePostgresPlanScope,
  serializePlanLifecycleDump,
} from "../planLifecycleDump.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyReattachItem,
  applyReopenItem,
  assertArchiveDoesNotDropUnsatisfyingGates,
  applyUpdateItem,
  statusSatisfiesDependency,
  validateMilestoneItemPatch,
  applyUpdateMilestoneItem,
  assertGoalPhasePreconditions,
  collectNonTerminalOwnedChildren,
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
import { buildWorksetActiveState, closeWorkset } from "../../worksetGraph.js";
import { cloneItem, materialiseFetchedLedger } from "../InMemoryLedgerStore.js";
import { AsyncMutex } from "../mutex.js";
import {
  CANONICAL_LEDGERS,
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  IDEAS_LEDGER,
  LEDGER_LOGS_RELATIVE_PREFIX,
  LEDGER_LOGS_STRIP_RE,
  MILESTONES_ACTIVE_GROUP_ID,
  MILESTONES_ACTIVE_GROUP_TITLE,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  QUESTIONS_ANSWER_FIELD,
  QUESTIONS_LEDGER,
  TASKS_LEDGER,
  DEFAULT_ON_SCHEMA_DIVERGENCE,
} from "../../constants.js";
import { relocateActiveIdeasToAmbient } from "../../ideasAmbientMigration.js";
import {
  MAX_READ_LOG_BYTES,
  type ReadLogResult,
} from "../../mcp/readLog.js";
import type { ListProjectsResult } from "../../mcp/listProjects.js";
import { readTransaction, writeTransaction } from "./connection.js";
import { classifyCanonicalLedgers } from "./divergence.js";
import {
  createPostgresWorksetStore,
  type CreatePostgresWorksetStoreOptions,
  type PostgresWorksetStore,
} from "./worksetStore.js";
import { createObserveOnlyWorksetInvocationAuthority } from "../../worksetInvocationAuthority.js";
import { serializeWorksetRootsDocument } from "../../worksetRootsDocument.js";
import {
  observeTaskAdoptionEligibility,
  TaskAdoptionFenceRegistry,
  type TaskAdoptionEligibilityFence,
  type TaskAdoptionEligibilityObservation,
  type TaskAdoptionEligibilityResult,
  type TaskAdoptionPublicationResult,
} from "../../taskAdoptionEligibility.js";
import {
  type OperatorActionLifecycleMutation,
  type OperatorActionLifecycleMutationResult,
} from "../operatorActionLifecycle.js";
import type { WorksetOwnedWriteTx } from "../../worksetOwnedLifecycle.js";
import type { AdmittedPlanMutation, WorksetPlanLifecycleTx } from "../../worksetPlanLifecycle.js";
import { createWorksetPlanLifecycleTransaction } from "../worksetPlanLifecycleTransaction.js";
import {
  createGenericMutationTransaction,
  type WorksetGenericMutationTx,
} from "../genericMutationTransaction.js";
import type { WorksetRootsEpoch } from "../../worksetEffectAdmission.js";

export interface PostgresLedgerStoreOpts {
  readonly accessObserver?: PostgresAccessObserver;
  readonly searchProjectionFactory?: () => SearchProjection;
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
  /** Runtime-only authority for destructive divergence reinitialization. */
  worksetAuthority?: unknown;
  /** Options for this tenant's durable workset admission capability. */
  workset?: Omit<CreatePostgresWorksetStoreOptions, "pool" | "projectKey">;
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

/** One `plan_claims` / `plan_operations` row (T851). */
interface PlanRecordRow {
  scope: string;
  record_json: string;
}

/** Authoritative transaction input for legacy raw guards and administrative operations. */
interface LiveTenantState {
  readonly ledgers: Map<string, Ledger>;
  readonly archived: readonly ArchivedItemRow[];
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

/** Look up a ledger in a transaction-local LIVE map, failing loudly if absent. */
function requireLiveLedger(live: ReadonlyMap<string, Ledger>, ledgerId: string): Ledger {
  const ledger = live.get(ledgerId);
  if (ledger === undefined) throw new LedgerNotFoundError(ledgerId);
  return ledger;
}

/** The bare ids of every `goals:<id>` entry in a `ledgerRefs` field value. */
function goalRefIds(value: FieldValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const prefix = `${GOALS_LEDGER}:`;
  return value
    .filter((ref): ref is string => typeof ref === "string" && ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length));
}

export class PostgresLedgerStore implements LedgerStore, PlanLifecycleStore {
  private readonly projectKey: string;
  private readonly displayName: string;
  private readonly now: () => string;
  private readonly onMutation: OnMutation | null;
  private readonly accessObserver: PostgresAccessObserver | null;
  private readonly coherenceOrigin = randomUUID();
  private readonly readCache = new PostgresReadCache();
  private readonly searchProjectionFactory: () => SearchProjection;
  private searchProjection: SearchProjection | null = null;
  private projectionRecovery: SearchProjectionRecovery | null = null;
  private cachedVersion = 0;
  private requiredCacheVersion = 0;
  private readonly pendingNotifications = new Map<number, { ledgerId: string; op: LedgerMutationOp }[]>();
  private readonly projectionListeners = new Set<(ledgerId: string) => void>();
  private readonly onSchemaDivergence: "backup-reinit" | "abort";
  private readonly worksetAuthority: unknown;
  private readonly worksetOptions: Omit<
    CreatePostgresWorksetStoreOptions,
    "pool" | "projectKey"
  >;
  private handle: SQL | null;

  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly taskAdoptionFences = new TaskAdoptionFenceRegistry();
  private initialised = false;
  private closing = false;
  /** Lazy T1958 workset roots/admission store for this tenant. */
  private workset: PostgresWorksetStore | null = null;

  constructor(opts: PostgresLedgerStoreOpts) {
    this.handle = opts.pool;
    this.projectKey = opts.projectKey;
    this.displayName = opts.displayName;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onMutation = opts.onMutation ?? null;
    this.accessObserver = opts.accessObserver ?? null;
    this.searchProjectionFactory = opts.searchProjectionFactory ?? (() => createWorkerSearchProjection(SEARCH_PROJECTION_COMMAND_DEADLINE_MS));
    this.onSchemaDivergence = opts.onSchemaDivergence ?? DEFAULT_ON_SCHEMA_DIVERGENCE;
    this.worksetAuthority =
      opts.worksetAuthority ?? createObserveOnlyWorksetInvocationAuthority();
    this.worksetOptions = opts.workset ?? {};
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
    await this.upsertProject(this.displayName);

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

    await writeTransaction(pool, async (tx) => {
      await tx`
        SELECT 1 FROM ledgers
        WHERE project_key = ${pk} AND name = ${IDEAS_LEDGER}
        FOR UPDATE
      `;
      await tx`
        SELECT 1 FROM groups
        WHERE project_key = ${pk} AND ledger = ${IDEAS_LEDGER}
        ORDER BY id FOR UPDATE
      `;
      await tx`
        SELECT 1 FROM items
        WHERE project_key = ${pk} AND ledger = ${IDEAS_LEDGER}
        ORDER BY id FOR UPDATE
      `;
      const ideas = (await this.readActiveLedgers(tx)).get(IDEAS_LEDGER);
      if (ideas === undefined || !relocateActiveIdeasToAmbient(ideas)) return false;
      await this.persistLedgerState(tx, ideas);
      await this.recordCoherence(tx, [{ ledger: IDEAS_LEDGER, documentId: POSTGRES_RESET_CONTROL_ID, scope: "control", kind: "upsert" }]);
      return true;
    });
    this.searchProjection = this.searchProjectionFactory();
    this.projectionRecovery = new SearchProjectionRecovery(this.searchProjection, {
      load: (afterVersion, rebuild, signal) => this.loadProjectionFrame(afterVersion, rebuild, signal),
      notify: (frame, signal) => this.notifyProjectionFrame(frame, signal),
    }, SEARCH_PROJECTION_COMMAND_DEADLINE_MS);
    try { await this.projectionRecovery.initialize(); this.initialised = true; }
    catch (error) { await this.projectionRecovery.close(); this.projectionRecovery = null; this.searchProjection = null; throw error; }
  }

  /**
   * Refresh this initialized tenant's registry display name without
   * reconstructing the store or its materialized ledger cache. `cq serve`
   * calls this at each later authenticated MCP initialize boundary so a cached
   * ProjectRuntime can create the new session with current metadata.
   */
  async registerProject(displayName: string): Promise<void> {
    this.assertInit();
    await this.upsertProject(displayName);
  }

  private async upsertProject(displayName: string): Promise<void> {
    if (displayName.trim() === "") {
      throw new LedgerError("project display name must not be blank");
    }
    await this.pool()`
      INSERT INTO projects (project_key, display_name)
      VALUES (${this.projectKey}, ${displayName})
      ON CONFLICT (project_key) DO UPDATE
      SET display_name = EXCLUDED.display_name, updated_at = now()
      WHERE projects.display_name IS DISTINCT FROM EXCLUDED.display_name
    `;
  }

  /**
   * Provision the given canonical ledgers from canon, apply any widening
   * upgrades, and seed the milestones bootstrap active group + the immortal
   * M-AMBIENT milestone, all under one write transaction, scoped by
   * `project_key` (parity with SqliteLedgerStore.bootstrapCanonicalRows).
   */
  private async bootstrapCanonicalRows(missing: string[], widened: string[] = []): Promise<void> {
    await writeTransaction(this.pool(), async (tx) => { await this.recordCoherence(tx, await this.runBootstrapWrites(tx, missing, widened)); });
  }

  /**
   * The bootstrap writes themselves, parameterised over the SQL handle so
   * {@link backupAndReinitTenant} can run them inside the SAME transaction as
   * its wipe (one atomic backup+wipe+reseed, rather than three separate
   * transactions with a window for a crash to leave the tenant half-wiped).
   */
  private async runBootstrapWrites(tx: SQL, missing: string[], widened: string[]): Promise<PostgresCoherenceChange[]> {
    const canonSchema = new Map(CANONICAL_LEDGERS.map((c) => [c.name, c.schema]));
    const pk = this.projectKey;
    const changes: PostgresCoherenceChange[] = [...missing, ...widened].map((ledger) => ({ ledger, documentId: POSTGRES_LEDGER_CONTROL_ID, scope: "registry", kind: "upsert" }));
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
    const addedGroups = await tx<{ id: string }[]>`
      INSERT INTO groups (project_key, ledger, id, title, description)
      VALUES (${pk}, ${MILESTONES_LEDGER}, ${MILESTONES_ACTIVE_GROUP_ID}, ${MILESTONES_ACTIVE_GROUP_TITLE}, '')
      ON CONFLICT DO NOTHING RETURNING id
    `;
    for (const { id } of addedGroups) changes.push({ ledger: MILESTONES_LEDGER, documentId: POSTGRES_GROUP_CONTROL_PREFIX + id, scope: "control", kind: "upsert" });
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
      changes.push({ ledger: MILESTONES_LEDGER, documentId: MILESTONES_AMBIENT_ID, scope: "active", kind: "upsert" });
    }
    return changes;
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
    // T1959: exclusive administrative admission; wait for in-flight effects
    // before the destructive backup+reinit phase. Divergence artifact retains
    // roots; live tenant starts unrestricted empty.
    const workset = createPostgresWorksetStore({ pool: this.pool(), projectKey: pk });
    try {
      await workset.runAdministrative({
        kind: "divergence-reinitialization",
        authority: this.worksetAuthority,
        destructivePhase: async () => {
          await this.backupAndReinitTenantBody(pk, shadowKey);
        },
      });
    } finally {
      workset.close();
    }
    return shadowKey;
  }

  private async backupAndReinitTenantBody(pk: string, shadowKey: string): Promise<void> {
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
      // T851: the plan-lifecycle fence's durable side state is tenant state
      // too — carried into the shadow and wiped below on exactly the same
      // argument review r2 made for `logs`, so the backup stays complete and
      // the reinit'd tenant does not inherit claims/replays for goals that no
      // longer exist.
      await tx`
        INSERT INTO plan_claims (project_key, scope, record_json)
        SELECT ${shadowKey}, scope, record_json
        FROM plan_claims WHERE project_key = ${pk}
      `;
      await tx`
        INSERT INTO plan_operations (project_key, scope, record_json)
        SELECT ${shadowKey}, scope, record_json
        FROM plan_operations WHERE project_key = ${pk}
      `;
      // T1959: roots/epoch are durable tenant state. Admission rows are live
      // coordination leases and never travel into a backup.
      await tx`
        INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation, updated_at)
        SELECT ${shadowKey}, roots_json, epoch, admit_generation, updated_at
        FROM workset_roots WHERE project_key = ${pk}
      `;

      // Wipe the ORIGINAL tenant's rows (children first, FK order), then
      // reseed the full canonical set fresh — same write shape as
      // runBootstrapWrites's Pass 2, sharing THIS transaction.
      // Preserve the exclusive administrative admission row held by this reinit
      // (T1959); non-exclusive admissions go to the shadow above and are dropped live.
      await tx`
        DELETE FROM workset_admissions
        WHERE project_key = ${pk}
          AND form NOT IN ('exclusive-set', 'exclusive-administrative')
      `;
      await tx`DELETE FROM workset_roots WHERE project_key = ${pk}`;

      await tx`DELETE FROM archived_items WHERE project_key = ${pk}`;
      await tx`DELETE FROM archive_pointers WHERE project_key = ${pk}`;
      await tx`DELETE FROM items WHERE project_key = ${pk}`;
      await tx`DELETE FROM groups WHERE project_key = ${pk}`;
      await tx`DELETE FROM ledgers WHERE project_key = ${pk}`;
      await tx`DELETE FROM logs WHERE project_key = ${pk}`;
      await tx`DELETE FROM plan_claims WHERE project_key = ${pk}`;
      await tx`DELETE FROM plan_operations WHERE project_key = ${pk}`;

      await this.runBootstrapWrites(
        tx,
        CANONICAL_LEDGERS.map((c) => c.name),
        [],
      );
      await this.recordCoherence(tx, [{ ledger: MILESTONES_LEDGER, documentId: POSTGRES_RESET_CONTROL_ID, scope: "control", kind: "upsert" }]);
    });
  }


  /**
   * Materialise EVERY active ledger of this tenant (ledgers + groups + items,
   * in `seq` order) from `sql`, into a FRESH map that shares no object with the
   * cache.
   *
   * `sql` is a parameter, not `this.pool()`, precisely so a caller inside a
   * write transaction can pass its `tx` handle and read the LIVE rows the
   * transaction's locks are protecting — the property the plan-lifecycle fence
   * (T851) depends on, and the reason it never consults the read cache.
   */
  private async readActiveLedgers(sql: SQL): Promise<Map<string, Ledger>> {
    const pk = this.projectKey;
    const ledgers = new Map<string, Ledger>();
    const ledgerRows = await sql<LedgerRow[]>`
      SELECT name, schema_json, milestone_counter, item_counter
      FROM ledgers WHERE project_key = ${pk} ORDER BY name
    `;
    for (const lr of ledgerRows) {
      ledgers.set(lr.name, {
        id: lr.name,
        schema: JSON.parse(lr.schema_json) as LedgerSchema,
        counters: { milestone: lr.milestone_counter, item: lr.item_counter },
        milestones: [],
        archivePointers: [],
      });
    }

    // ledger -> (groupId -> items[]) so items land in their group in row order.
    const groupIndex = new Map<string, Map<string, Item[]>>();
    const groupRows = await sql<GroupRow[]>`
      SELECT ledger, id, title, description
      FROM groups WHERE project_key = ${pk} ORDER BY ledger, seq
    `;
    for (const g of groupRows) {
      const ledger = ledgers.get(g.ledger);
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

    const itemRows = await sql<ItemRow[]>`
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

    const pointerRows = await sql<PointerRow[]>`
      SELECT ledger, id, summary, title, status
      FROM archive_pointers WHERE project_key = ${pk} ORDER BY ledger, seq
    `;
    for (const p of pointerRows) {
      ledgers.get(p.ledger)?.archivePointers.push({
        id: p.id,
        path: `./archive/${p.ledger}/${p.id}.md`,
        summary: p.summary,
        title: p.title,
        status: p.status,
      });
    }
    return ledgers;
  }

  /** Read this tenant's `archived_items` rows — the content behind every archive pointer. */
  private async readArchivedRows(sql: SQL): Promise<ArchivedItemRow[]> {
    return await sql<ArchivedItemRow[]>`
      SELECT ledger, pointer_id, id, milestone_id, status, fields_json, created_at, updated_at, author, session
      FROM archived_items WHERE project_key = ${this.projectKey} ORDER BY ledger, seq
    `;
  }

  /** Read authoritative raw-guard input; post-commit coherence never absorbs this materialization. */
  private async readLiveTenant(sql: SQL): Promise<LiveTenantState> {
    const ledgers = await this.readActiveLedgers(sql);
    return { ledgers, archived: await this.readArchivedRows(sql) };
  }


  /**
   * T1958 — tenant-scoped durable {@link PostgresWorksetStore}. Lazy; one
   * instance per store. Closed automatically from {@link dispose}.
   */
  worksetStore(): PostgresWorksetStore {
    this.assertInit();
    if (this.workset === null) {
      this.workset = createPostgresWorksetStore({
        ...this.worksetOptions,
        pool: this.pool(),
        projectKey: this.projectKey,
      });
    }
    return this.workset;
  }

  replaceWorksetRoots(roots: readonly string[]) {
    const suppliedValidation = this.worksetOptions.validateReplacement;
    return this.worksetStore().setValidatedRoots(roots, async (canonical, tx) => {
      await this.lockAllGoalRows(tx);
      await this.lockTenantCounters(tx);
      const tenant = await this.readLiveTenant(tx);
      const state = buildWorksetActiveState(
        [...tenant.ledgers].map(([ledger, value]) => ({
          ledger,
          items: value.milestones.flatMap((milestone) => milestone.items),
        })),
        buildPrefixRegistry(
          [...tenant.ledgers].map(([name, ledger]) => ({ name, schema: ledger.schema })),
        ),
      );
      const closed = closeWorkset(canonical, state, { validateLiveRoots: true }).roots;
      return (await suppliedValidation?.(closed, tx)) ?? closed;
    }, () => this.reconcileProjection());
  }

  /**
   * Duck-typed BackupDump source (T1959): emit portable `workset-roots.json`.
   */
  async exportWorksetRootsState(): Promise<string> {
    const snap = await this.worksetStore().snapshot();
    return serializeWorksetRootsDocument(snap);
  }

  /**
   * T1976 — reset this tenant under one exclusive administrative admission.
   * The optional backup callback runs after the admission drain and a fresh
   * cache load, before the single wipe/reseed/empty-roots transaction.
   */
  async resetTenant(opts: {
    readonly authority: unknown;
    readonly beforeReset?: () => Promise<void>;
  }): Promise<void> {
    this.assertInit();
    const workset = this.worksetStore();
    await workset.runAdministrative({
      kind: "reset",
      authority: opts.authority,
      destructivePhase: async () => {
        // The store may have waited for an in-flight writer while acquiring
        // exclusivity; refresh so the backup observes that committed write.
        await this.recovery().rebuild();
        if (opts.beforeReset !== undefined) await opts.beforeReset();
        await writeTransaction(this.pool(), async (tx) => {
          await tx`
            DELETE FROM workset_admissions
            WHERE project_key = ${this.projectKey}
              AND form NOT IN ('exclusive-set', 'exclusive-administrative')
          `;
          await tx`DELETE FROM workset_roots WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM plan_operations WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM plan_claims WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM archived_items WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM archive_pointers WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM items WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM groups WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM ledgers WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM logs WHERE project_key = ${this.projectKey}`;
          await this.runBootstrapWrites(
            tx,
            CANONICAL_LEDGERS.map(({ name }) => name),
            [],
          );
          await this.recordCoherence(tx, [{ ledger: MILESTONES_LEDGER, documentId: POSTGRES_RESET_CONTROL_ID, scope: "control", kind: "upsert" }]);
          await tx`
            INSERT INTO workset_roots (project_key, roots_json, epoch, admit_generation)
            VALUES (${this.projectKey}, ${"[]"}, ${0}, ${0})
          `;
        });
      },
    });

    await this.reconcileProjection();
    // Exactly one peer invalidation, after both the reset transaction and the
    // surrounding administrative generation advance have committed.
  }

  async dispose(): Promise<void> {
    this.closing = true;
    // D148: drain per-ledger mutexes BEFORE closing the pool so an in-flight
    // coherence invalidate/reloadLedger (parked on `await prior` or mid-query)
    // finishes against a still-open pool.
    const drains = Array.from(this.mutexes.values()).map((m) => m.run(async () => undefined));
    await Promise.all(drains);
    if (this.projectionRecovery !== null) await this.projectionRecovery.close();
    this.projectionRecovery = null;
    this.searchProjection = null;
    this.pendingNotifications.clear();
    this.projectionListeners.clear();
    this.readCache.clear();
    if (this.workset !== null) {
      this.workset.close();
      this.workset = null;
    }
    if (this.handle !== null) {
      await this.handle.close();
      this.handle = null;
    }
    this.mutexes.clear();
    this.initialised = false;
  }

  /** I20/G155, T1509: atomically increment tenant-scoped usage counters. */
  async recordMcpUsage(endpoint: string, bytesIn: number, bytesOut: number): Promise<void> {
    this.assertInit();
    await this.pool()`
      INSERT INTO mcp_usage_stats (project_key, endpoint, call_count, bytes_in, bytes_out)
      VALUES (${this.projectKey}, ${endpoint}, 1, ${bytesIn}, ${bytesOut})
      ON CONFLICT (project_key, endpoint) DO UPDATE SET
        call_count = mcp_usage_stats.call_count + 1,
        bytes_in = mcp_usage_stats.bytes_in + EXCLUDED.bytes_in,
        bytes_out = mcp_usage_stats.bytes_out + EXCLUDED.bytes_out
    `;
  }

  /** I20/G155, T1509: accumulated usage snapshot for this tenant. */
  async fetchMcpUsageStats(): Promise<UsageStatsSnapshot> {
    this.assertInit();
    const rows = await this.pool()<
      Array<{ endpoint: string; call_count: number; bytes_in: number; bytes_out: number }>
    >`
      SELECT endpoint, call_count, bytes_in, bytes_out
      FROM mcp_usage_stats
      WHERE project_key = ${this.projectKey}
      ORDER BY endpoint
    `;
    const endpoints = rows.map((row) => ({
      name: row.endpoint,
      callCount: Number(row.call_count),
      bytesIn: Number(row.bytes_in),
      bytesOut: Number(row.bytes_out),
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
    this.fireHook("logs", "update");
  }

  tenantKey(): string {
    return this.projectKey;
  }

  sharedPool(): SQL {
    return this.pool();
  }

  async reloadCommittedState(): Promise<void> {
    this.assertInit();
    await this.recovery().rebuild();
  }

  async eraseTenant(opts: { readonly authority: unknown }): Promise<void> {
    this.assertInit();
    const workset = this.worksetStore();
    await workset.runAdministrative({
      kind: "erase",
      authority: opts.authority,
      destructivePhase: async () => {
        await writeTransaction(this.pool(), async (tx) => {
          await tx`DELETE FROM workset_admissions WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM workset_roots WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM plan_operations WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM plan_claims WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM mcp_usage_stats WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM archived_items WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM archive_pointers WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM items WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM groups WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM ledgers WHERE project_key = ${this.projectKey}`;
          await tx`DELETE FROM logs WHERE project_key = ${this.projectKey}`;
          await this.recordCoherence(tx, [{ ledger: MILESTONES_LEDGER, documentId: POSTGRES_RESET_CONTROL_ID, scope: "control", kind: "upsert" }]);
          await tx`DELETE FROM projects WHERE project_key = ${this.projectKey}`;
        });
      },
    });
    this.fireHook("logs", "archive");
    // Erasure deletes the coherence epoch itself; this tenant instance cannot reconcile again.
    await this.recovery().close();
    this.readCache.clear();
    this.closing = true;
    this.initialised = false;
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
   * Duck-typed BackupDump source (D139): emit plan-lifecycle.json from LIVE
   * plan_claims/plan_operations rows (not the materialized item cache).
   */
  async exportPlanLifecycleState(): Promise<string | null> {
    this.assertInit();
    const claims = new Map<string, PlanPrivateClaimRecord>();
    for (const row of await this.pool()<PlanRecordRow[]>`
      SELECT scope, record_json FROM plan_claims WHERE project_key = ${this.projectKey}
    `) {
      claims.set(
        decodePostgresPlanScope(row.scope),
        PlanPrivateClaimRecordSchema.parse(JSON.parse(row.record_json)),
      );
    }
    const operations = new Map<string, InMemoryPlanOperationRecord>();
    for (const row of await this.pool()<PlanRecordRow[]>`
      SELECT scope, record_json FROM plan_operations WHERE project_key = ${this.projectKey}
    `) {
      operations.set(
        decodePostgresPlanScope(row.scope),
        JSON.parse(row.record_json) as InMemoryPlanOperationRecord,
      );
    }
    if (claims.size === 0 && operations.size === 0) return null;
    return serializePlanLifecycleDump({ claims, operations });
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
    this.assertCacheReadable();
    return this.readCache.enumerate();
  }

  fetch(ledgerId: string): FetchedLedger {
    return materialiseFetchedLedger(this.getLedger(ledgerId), this.getLedger(MILESTONES_LEDGER));
  }

  fetchItem(ledgerId: string, itemId: string): Item {
    this.assertCacheReadable();
    return this.readCache.item(ledgerId, itemId);
  }

  search(ledgerId: string, query: string): Item[] {
    return searchItems(this.getLedger(ledgerId), query).map(cloneItem);
  }

  async ftsSearch(query: string, opts: FtsSearchOpts = {}): Promise<FtsSearchHit[]> {
    this.assertInit();
    await this.reconcileProjection();
    if (this.searchProjection === null) throw new ProjectionUnavailableError("PostgreSQL search projection is not mounted");
    const ack = await this.searchProjection.execute({ kind: "search", query, options: opts }).catch((error: unknown) => {
      void this.reconcileProjection().catch(() => undefined);
      throw new ProjectionUnavailableError(`Search projection unavailable: ${String(error)}`);
    });
    if (ack.result.kind !== "search") throw new LedgerError("Search projection returned a non-search acknowledgement");
    return ack.result.hits.map((hit) => ({ ...hit, item: cloneItem(hit.item) }));
  }

  searchProjectionHealth(): SearchProjectionHealth { return this.recovery().health(); }
  reconcileProjection(): Promise<void> { return this.recovery().reconcile(); }
  subscribeProjectionChanges(listener: (ledgerId: string) => void): () => void {
    this.projectionListeners.add(listener);
    return () => { this.projectionListeners.delete(listener); };
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
    this.assertCacheReadable();
    return this.readCache.milestoneItems(milestoneId);
  }

  snapshot(): LedgerSnapshot {
    this.assertInit();
    return buildSnapshot(this.enumerate().map((name) => this.fetch(name)));
  }

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    this.assertCacheReadable();
    return this.readCache.archive(ledgerId, archiveId);
  }

  // ---------------------------------------------------------------------------
  // Mutations (async write-through: apply* against a clone → persist affected
  // rows and coherence keys in one transaction → acknowledge exact projection
  // deltas → fire onMutation). Raw mutations run under the same
  // per-ledger / global-milestones AsyncMutex discipline as InMemoryLedgerStore
  // so within-instance ordering (and the concurrency-parity suite) holds; the
  // PG transaction provides cross-process isolation.
  // ---------------------------------------------------------------------------

  async updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneItemPatch,
  ): Promise<Item> {
    let committedVersion: number | null = null;
    const item = await this.withMilestonesLock(async () => {
      let out!: Item;
      await writeTransaction(this.pool(), async (tx) => {
        committedVersion = null;
        // D267/T1858: parent row lock FIRST, then the authoritative live read.
        await this.lockParentMilestoneRow(tx, milestoneId);
        const state = await this.readLiveTenant(tx);
        const msLive = requireLiveLedger(state.ledgers, MILESTONES_LEDGER);
        const before = JSON.stringify(findItem(msLive, milestoneId).item);
        const x = applyUpdateMilestoneItem(
          msLive,
          milestoneId,
          patch,
          this.now(),
          this.buildRefValidationContext(null),
          await this.nonTerminalChildren(tx, milestoneId),
        );
        await this.persistItemRow(tx, MILESTONES_LEDGER, x);
        if (before !== JSON.stringify(x)) committedVersion = await this.recordCoherence(tx, [{ ledger: MILESTONES_LEDGER, documentId: x.id, scope: "active", kind: "upsert" }]);
        out = cloneItem(x);
      });
      return out;
    });
    await this.projectCommitted(committedVersion, [{ ledgerId: MILESTONES_LEDGER, op: "update" }]);
    return item;
  }

  /**
   * D267/T1858 parent-first protocol: lock the active milestone row
   * FOR UPDATE inside the write transaction. Every close-or-archive-versus-
   * child entry point takes this lock FIRST, so the race serializes at the
   * database across independent store instances instead of at one instance's
   * cached ledgers. A no-op when the row is absent — the authoritative read
   * that follows reports the absence.
   */
  private async lockParentMilestoneRow(tx: SQL, milestoneId: string): Promise<void> {
    await tx`
      SELECT 1 FROM items
      WHERE project_key = ${this.projectKey} AND ledger = ${MILESTONES_LEDGER} AND id = ${milestoneId}
      FOR UPDATE
    `;
  }

  /** D267/T1856: active children of `milestoneId` whose status is
   * non-terminal in their own ledger, as sorted `<ledger>:<id>` refs. */
  private async nonTerminalChildren(tx: SQL, milestoneId: string): Promise<string[]> {
    const blockers: string[] = [];
    const schemas = await tx<{ name: string; schema_json: string }[]>`
      SELECT name, schema_json FROM ledgers WHERE project_key = ${this.projectKey}
    `;
    const rows = await tx<{ ledger: string; id: string; status: string }[]>`
      SELECT ledger, id, status FROM items
      WHERE project_key = ${this.projectKey} AND milestone_id = ${milestoneId}
    `;
    const terminalByLedger = new Map(
      schemas.map((row) => [
        row.name,
        new Set((JSON.parse(row.schema_json) as LedgerSchema).terminalStatuses),
      ]),
    );
    for (const row of rows) {
      if (row.ledger === MILESTONES_LEDGER) continue;
      const terminal = terminalByLedger.get(row.ledger);
      if (terminal !== undefined && !terminal.has(row.status)) {
        blockers.push(`${row.ledger}:${row.id}`);
      }
    }
    return blockers.sort();
  }

  async updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item> {
    let committedVersion: number | null = null;
    if (ledgerId === MILESTONES_LEDGER) {
      // Canonical disposition (D267/T1856): one delegated path.
      return this.updateMilestone(itemId, validateMilestoneItemPatch(patch));
    }
    const item = await this.withLock(ledgerId, async () => {
      let out!: Item;
      await writeTransaction(this.pool(), async (tx) => {
        committedVersion = null;
        // T851 plan fence. For the two plan-managed ledgers the guard decision
        // and the mutation itself must both see LIVE rows, so the whole thing
        // runs behind this goal's row lock over a transaction-local read
        // instead of over the read cache (which a peer instance's committed
        // lifecycle write may already have made stale).
        if (this.isPlanFenced(ledgerId)) {
          await this.lockGoalRows(
            tx,
            await this.fencedGoalIds(tx, ledgerId, itemId, patch.fields?.["ledgerRefs"]),
          );
          const state = await this.readLiveTenant(tx);
          const live = state.ledgers;
          const source = requireLiveLedger(live, ledgerId);
          assertRawPlanUpdateAllowed(
            (id) => requireLiveLedger(live, id),
            ledgerId,
            source,
            itemId,
            patch,
          );
          const before = JSON.stringify(findItem(source, itemId).item);
          const x = applyUpdateItem(
            source,
            itemId,
            patch,
            this.now(),
            this.statusChangePrecondition(ledgerId, source, itemId, patch, live),
            this.buildRefValidationContext(live),
          );
          await this.persistItemRow(tx, ledgerId, x);
          if (before !== JSON.stringify(x)) committedVersion = await this.recordCoherence(tx, [{ ledger: ledgerId, documentId: x.id, scope: "active", kind: "upsert" }]);
          out = cloneItem(x);
          return;
        }
        // D147: single-item shim (O(1)) instead of structuredClone of the whole
        // ledger — parity with SqliteLedgerStore.singleItemShim / T538/D87.
        const shim = await this.singleItemShim(tx, ledgerId, itemId);
        const before = JSON.stringify(findItem(shim, itemId).item);
        const precondition = this.statusChangePrecondition(ledgerId, shim, itemId, patch, null);
        const x = applyUpdateItem(
          shim,
          itemId,
          patch,
          this.now(),
          precondition,
          this.buildRefValidationContext(null),
        );
        await this.persistItemRow(tx, ledgerId, x);
        if (before !== JSON.stringify(x)) committedVersion = await this.recordCoherence(tx, [{ ledger: ledgerId, documentId: x.id, scope: "active", kind: "upsert" }]);
        out = cloneItem(x);
      });
      return out;
    });
    await this.projectCommitted(committedVersion, [{ ledgerId: ledgerId, op: "update" }]);
    return item;
  }

  async createItem(
    ledgerId: string,
    milestoneId: string,
    init: CreateItemInit,
  ): Promise<Item> {
    let committedVersion: number | null = null;
    if (ledgerId === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
      );
    }
    // Global milestones lock first, then the per-ledger lock — consistent
    // __milestones__-first order with archiveMilestone, so no cyclic
    // deadlock. The strict-existence check runs against LIVE tenant state
    // inside the transaction below (D267/T1858): this instance's cached
    // milestones ledger is not an authority for it.
    const item = await this.withMilestonesLock(async () => {
      return this.withLock(ledgerId, async () => {
        let out!: Item;
        await writeTransaction(this.pool(), async (tx) => {
          committedVersion = null;
          // D267/T1858: parent row lock FIRST, then the authoritative
          // liveness check against the LIVE milestones ledger.
          await this.lockParentMilestoneRow(tx, milestoneId);
          const state = await this.readLiveTenant(tx);
          const live = state.ledgers;
          assertMilestoneActive(requireLiveLedger(live, MILESTONES_LEDGER), milestoneId);
          // T851 plan fence. A raw create is forbidden from attaching to a
          // MANAGED goal at all (assertRawPlanCreateAllowed), so there is no
          // goal row to lock here — but deciding whether the referenced goal is
          // managed still has to read LIVE goal rows, not this instance's cache.
          if (this.isPlanFenced(ledgerId)) {
            assertRawPlanCreateAllowed(
              (id) => requireLiveLedger(live, id),
              ledgerId,
              init.fields,
            );
          }
          const base = requireLiveLedger(live, ledgerId);
          const existingGroup = base.milestones.some(({ id }) => id === milestoneId);
          const refCtx = this.buildRefValidationContext(live);
          const x = await this.insertItemViaCore(tx, base, init.id, (l) =>
            applyCreateItem(l, milestoneId, init, this.now(), refCtx),
          );
          committedVersion = await this.recordCoherence(tx, [
            { ledger: ledgerId, documentId: x.id, scope: "active", kind: "upsert" },
            { ledger: ledgerId, documentId: POSTGRES_LEDGER_CONTROL_ID, scope: "registry", kind: "upsert" },
            ...(existingGroup ? [] : [{ ledger: ledgerId, documentId: POSTGRES_GROUP_CONTROL_PREFIX + milestoneId, scope: "control", kind: "upsert" } as const]),
          ]);
          out = cloneItem(x);
        });
        return out;
      });
    });
    await this.projectCommitted(committedVersion, [{ ledgerId: ledgerId, op: "create" }]);
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    let committedVersion: number | null = null;
    const item = await this.withMilestonesLock(async () => {
      let out!: Item;
      await writeTransaction(this.pool(), async (tx) => {
        committedVersion = null;
        const clone = cloneLedger(this.getLedger(MILESTONES_LEDGER));
        const refCtx = this.buildRefValidationContext(null);
        const x = await this.insertItemViaCore(tx, clone, init.id, (l) =>
          applyCreateMilestoneItem(l, init, this.now(), refCtx),
        );
        committedVersion = await this.recordCoherence(tx, [
          { ledger: MILESTONES_LEDGER, documentId: x.id, scope: "active", kind: "upsert" },
          { ledger: MILESTONES_LEDGER, documentId: POSTGRES_LEDGER_CONTROL_ID, scope: "registry", kind: "upsert" },
        ]);
        out = cloneItem(x);
      });
      return out;
    });
    await this.projectCommitted(committedVersion, [{ ledgerId: MILESTONES_LEDGER, op: "create" }]);
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    let committedVersion: number | null = null;
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
      if (this.readCache.hasLedger(name)) throw new DuplicateIdError("ledger", name);
      // Prefix uniqueness gives global item-id uniqueness (Q-CANL-8).
      assertPrefixUnique(
        name,
        schema,
        this.readCache.registry(),
      );
      const ledger: Ledger = {
        id: name,
        schema,
        counters: { milestone: 0, item: 0 },
        milestones: [],
        archivePointers: [],
      };
      const createdView = materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
      await writeTransaction(this.pool(), async (tx) => {
        committedVersion = null;
        await tx`
          INSERT INTO ledgers (project_key, name, schema_json, milestone_counter, item_counter)
          VALUES (${pk}, ${name}, ${JSON.stringify(schema)}, 0, 0)
        `;
        committedVersion = await this.recordCoherence(tx, [{ ledger: name, documentId: POSTGRES_LEDGER_CONTROL_ID, scope: "registry", kind: "upsert" }]);
      });

      await this.projectCommitted(committedVersion, [{ ledgerId: name, op: "create" }]);
      return createdView;
    });
    return view;
  }

  async reopenItem(ledgerId: string, itemId: string, toStatus: string): Promise<Item> {
    let committedVersion: number | null = null;
    const item = await this.withLock(ledgerId, async () => {
      const pk = this.projectKey;
      let out!: Item;
      await writeTransaction(this.pool(), async (tx) => {
        committedVersion = null;
        // D267/T1858: resolve the parent coordinate, take its row lock FIRST,
        // then run the authoritative liveness check and the mutation against
        // the post-lock live tenant — the resurrection guard serializes with
        // any concurrent close across independent instances.
        const parentRow = await tx<{ milestone_id: string }[]>`
          SELECT milestone_id FROM items
          WHERE project_key = ${pk} AND ledger = ${ledgerId} AND id = ${itemId}
        `;
        const parentId = parentRow[0]?.milestone_id;
        if (parentId === undefined) throw new ItemNotFoundError(ledgerId, itemId);
        await this.lockParentMilestoneRow(tx, parentId);
        const state = await this.readLiveTenant(tx);
        const live = state.ledgers;
        assertMilestoneActive(requireLiveLedger(live, MILESTONES_LEDGER), parentId);
        const source = requireLiveLedger(live, ledgerId);
        const current = findItem(source, itemId).item;
        const before = JSON.stringify(current);
        // T851 plan fence. `reopenItem` is a SEPARATE write path from
        // `updateItem`, so it needs its own transition guard — a backend that
        // fenced only `updateItem` would let a terminal managed task be
        // resurrected straight past the lifecycle.
        if (this.isPlanFenced(ledgerId)) {
          await this.lockGoalRows(tx, await this.fencedGoalIds(tx, ledgerId, itemId, undefined));
          if (ledgerId === GOALS_LEDGER) {
            assertManagedGoalTransitionAllowed(current, toStatus);
          } else {
            assertManagedTaskTransitionAllowed(
              (id) => requireLiveLedger(live, id),
              current,
              toStatus,
            );
          }
        }
        const x = applyReopenItem(
          source,
          itemId,
          toStatus,
          this.now(),
          this.buildRefValidationContext(live),
        );
        await this.persistItemRow(tx, ledgerId, x);
        if (before !== JSON.stringify(x)) committedVersion = await this.recordCoherence(tx, [{ ledger: ledgerId, documentId: x.id, scope: "active", kind: "upsert" }]);
        out = cloneItem(x);
      });
      return out;
    });
    await this.projectCommitted(committedVersion, [{ ledgerId: ledgerId, op: "update" }]);
    return item;
  }

  async unarchiveItem(
    ledgerId: string,
    milestoneId: string,
    itemId: string,
  ): Promise<Item> {
    let committedVersion: number | null = null;
    const isMilestones = ledgerId === MILESTONES_LEDGER;
    const pk = this.projectKey;
    const reattached = await this.withLock(ledgerId, async () => {
      let out!: Item;
      // Prepared OUTSIDE the transaction body so the post-commit archive-map
      // update can apply the same delta; recomputed on the (rare) retry.
      let dropGroupArchive = false;
      await writeTransaction(this.pool(), async (tx) => {
        committedVersion = null;
        dropGroupArchive = false;
        // D267/T1858: parent row lock FIRST, then the archived row read live
        // and locked, then the liveness check against the LIVE milestones
        // ledger — the reattachment guard serializes with any concurrent
        // close across independent instances.
        await this.lockParentMilestoneRow(tx, milestoneId);
        if (!isMilestones) {
          const groupCount = await tx<{ n: number }[]>`
            SELECT COUNT(*) AS n FROM archived_items
            WHERE project_key = ${pk} AND ledger = ${ledgerId} AND pointer_id = ${milestoneId}
          `;
          if (Number(groupCount[0]?.n ?? 0) === 0) {
            throw new LedgerError(
              `no archived group for milestone ${milestoneId} in ledger ${ledgerId}`,
            );
          }
        }
        const archivedRows = await tx<ItemRow[]>`
          SELECT id, milestone_id, status, fields_json, created_at, updated_at, author, session
          FROM archived_items
          WHERE project_key = ${pk} AND ledger = ${ledgerId} AND pointer_id = ${milestoneId} AND id = ${itemId}
          FOR UPDATE
        `;
        const archivedRow = archivedRows[0];
        if (archivedRow === undefined) {
          throw new LedgerError(
            isMilestones
              ? `no archived item ${itemId} under milestone ${milestoneId} in ledger ${ledgerId}`
              : `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
          );
        }
        const archivedItem = rowToItem(archivedRow);
        if (!isMilestones) {
          const siblings = await tx<{ n: number }[]>`
            SELECT COUNT(*) AS n FROM archived_items
            WHERE project_key = ${pk} AND ledger = ${ledgerId} AND pointer_id = ${milestoneId}
          `;
          dropGroupArchive = Number(siblings[0]?.n ?? 0) === 1;
        }
        const state = await this.readLiveTenant(tx);
        const live = state.ledgers;
        const clone = requireLiveLedger(live, ledgerId);
        const groupsBefore = new Set(clone.milestones.map((m) => m.id));
        const attachId = isMilestones ? archivedItem.milestoneId : milestoneId;
        if (!new Set(clone.schema.terminalStatuses).has(archivedItem.status)) {
          // D267/T1856: reject BEFORE re-attachment — a non-terminal item
          // must not reappear under an absent/archived/terminal parent (its
          // archived status was read live under the parent row lock).
          assertMilestoneActive(requireLiveLedger(live, MILESTONES_LEDGER), attachId);
        }
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
        committedVersion = await this.recordCoherence(tx, [
          { ledger: ledgerId, documentId: x.id, scope: "active", kind: "upsert" },
          { ledger: ledgerId, documentId: JSON.stringify([milestoneId, x.id]), scope: "archived", kind: "delete" },
          ...(!groupsBefore.has(x.milestoneId) ? [{ ledger: ledgerId, documentId: POSTGRES_GROUP_CONTROL_PREFIX + x.milestoneId, scope: "control", kind: "upsert" } as const] : []),
          ...(isMilestones || dropGroupArchive ? [{ ledger: ledgerId, documentId: POSTGRES_POINTER_CONTROL_PREFIX + milestoneId, scope: "control", kind: "delete" } as const] : []),
        ]);
        out = cloneItem(x);
      });
      return out;
    });
    await this.projectCommitted(committedVersion, [{ ledgerId: ledgerId, op: "update" }]);
    return reattached;
  }

  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    let committedVersion: number | null = null;
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
      const otherIds = this.readCache.enumerate()
        .filter((n) => n !== MILESTONES_LEDGER)
        .sort();
      await this.withLocksInOrder(otherIds, async () => {
        let localParticipating: string[] = [];

        await writeTransaction(this.pool(), async (tx) => {
          committedVersion = null;
          localParticipating = [];
          const detachedGroups = new Map<string, { clone: Ledger; items: Item[] }>();
          // D267/T1858: parent row lock FIRST — a concurrent create/reopen/
          // unarchive under this parent blocks on the same row, so the detach
          // scan and the deletes below see one serializable state.
          await this.lockParentMilestoneRow(tx, milestoneId);
          const state = await this.readLiveTenant(tx);
          const live = state.ledgers;
          assertArchiveDoesNotDropUnsatisfyingGates(live, milestoneId);
          const msClone = requireLiveLedger(live, MILESTONES_LEDGER);

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

          // Detach each participating non-milestones group (verifies every item
          // terminal → NonTerminalItemsError before splice). Clones are
          // throwaway until commit, so a throw here leaves the cache untouched
          // (D10 no-partial-archive).
          for (const name of otherIds) {
            const clone = requireLiveLedger(live, name);
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

          const changes: PostgresCoherenceChange[] = [];
          for (const [ledger, items] of [[MILESTONES_LEDGER, [msItem]], ...[...detachedGroups].map(([ledger, group]) => [ledger, group.items] as const)] as const) {
            for (const item of items) changes.push(
              { ledger, documentId: item.id, scope: "active", kind: "delete" },
              { ledger, documentId: JSON.stringify([milestoneId, item.id]), scope: "archived", kind: "upsert" },
            );
            changes.push({ ledger, documentId: POSTGRES_POINTER_CONTROL_PREFIX + milestoneId, scope: "control", kind: "upsert" });
            if (ledger !== MILESTONES_LEDGER) changes.push({ ledger, documentId: POSTGRES_GROUP_CONTROL_PREFIX + milestoneId, scope: "control", kind: "delete" });
          }
          committedVersion = await this.recordCoherence(tx, changes);

          pointer = {
            id: milestoneId,
            path: `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
            summary,
            title: msTitle,
            status: msStatus,
          };
        });

        participating = localParticipating;
      });
    });

    await this.projectCommitted(committedVersion, [...participating, MILESTONES_LEDGER].map((ledgerId) => ({ ledgerId, op: "archive" })));
    return pointer;
  }

  async captureTaskAdoptionEligibility(taskId: string): Promise<TaskAdoptionEligibilityResult> {
    let observation!: TaskAdoptionEligibilityObservation;
    await readTransaction(this.pool(), async (tx) => {
      observation = this.observeTaskAdoptionEligibility(
        taskId,
        await this.readLiveTenant(tx),
      );
    });
    return this.taskAdoptionFences.capture(taskId, observation);
  }

  async publishTaskAdoption(
    fence: TaskAdoptionEligibilityFence,
    publish: () => undefined,
  ): Promise<TaskAdoptionPublicationResult> {
    const taskId = this.taskAdoptionFences.taskId(fence);
    if (taskId === null) return { status: "invalid-fence" };
    let result!: TaskAdoptionPublicationResult;
    let live!: LiveTenantState;
    await writeTransaction(this.pool(), async (tx) => {
      await this.lockTaskAdoptionRows(tx);
      live = await this.readLiveTenant(tx);
      result = this.taskAdoptionFences.compareAndPublish(
        fence,
        this.observeTaskAdoptionEligibility(taskId, live),
        publish,
      );
    });
    await this.reconcileProjection();
    return result;
  }

  // ---------------------------------------------------------------------------
  // PlanLifecycleStore (T851)
  // ---------------------------------------------------------------------------

  async claimPlan(input: PlanClaimInput): Promise<PlanClaimResult> {
    return this.runPlanLifecycleMutation({ operation: "claim", input }, (state) =>
      claimInMemoryPlan(state, input),
    );
  }

  async publishPlanDraft(input: PlanPublishDraftInput): Promise<PlanPublishDraftResult> {
    return this.runPlanLifecycleMutation({ operation: "publish-draft", input }, (state) =>
      publishInMemoryPlanDraft(state, input),
    );
  }

  async releasePlanClaim(input: PlanReleaseInput): Promise<PlanReleaseResult> {
    return this.runPlanLifecycleMutation({ operation: "release", input }, (state) =>
      releaseInMemoryPlanClaim(state, input),
    );
  }

  async finalizePlan(input: PlanFinalizeInput): Promise<PlanFinalizeResult> {
    return this.runPlanLifecycleMutation({ operation: "finalize", input }, (state) =>
      finalizeInMemoryPlan(state, input),
    );
  }

  async mutateOperatorAction(
    mutation: OperatorActionLifecycleMutation,
  ): Promise<OperatorActionLifecycleMutationResult> {
    return this.runOperatorActionLifecycleMutation(mutation);
  }

  /**
   * Reconcile the tenant's exact durable changes, including cross-ledger
   * companions of the invalidated item. Unknown ledger ids remain harmless.
   */
  async invalidate(_ledgerId: string): Promise<void> {
    // D148: a trailing invalidate after dispose must no-op, not throw
    // "not initialised" / "pool is closed" out of the detached IIFE.
    if (this.closing || !this.initialised || this.handle === null) return;
    await this.reconcileProjection();
  }

  // ---------------------------------------------------------------------------
  // Internals — plan-lifecycle fence (T851)
  //
  // SqliteLedgerStore runs the whole fence inside ONE immediate write
  // transaction whose reads are, by construction, LIVE rows. This backend
  // reproduces that property with a per-goal ROW LOCK plus transaction-local
  // reads, NOT with its materialized cache: the cache is a read model
  // that a peer instance's committed write can already have invalidated, so no
  // fence decision is ever taken from it. D141 option B further narrowed the
  // raw managed-task fence to authority-only (manifest ownership); dependency
  // readiness is orchestrator-side and is not decided on the raw path.
  //
  // Locks, always acquired in this order so no two fenced transactions can
  // invert them:
  //
  //  1. The GOAL ROW — `SELECT … FROM items WHERE ledger = 'goals' AND id = ?
  //     FOR UPDATE`. Taken BEFORE the authoritative read, which is the whole
  //     point: a concurrent writer on the same goal blocks here and only then
  //     reads, so it can never decide from state its peer is about to replace.
  //     Removing this one statement makes a raw task-start and a follow-up
  //     replacement BOTH succeed — see the T851 race test.
  //  2. This tenant's `ledgers` rows (lifecycle mutations only) — the
  //     id-allocation counters live there and a lifecycle mutation writes them
  //     back absolutely, so two lifecycle mutations on DIFFERENT goals must not
  //     interleave. Raw fenced writes never touch a counter and skip this.
  // ---------------------------------------------------------------------------

  /** Do writes to `ledgerId` participate in the plan fence at all? */
  private isPlanFenced(ledgerId: string): boolean {
    return ledgerId === GOALS_LEDGER || ledgerId === TASKS_LEDGER;
  }

  /**
   * The goal ids a raw fenced write must lock: the item itself on the goals
   * ledger, or every goal a task is (or is being asked to be) linked to.
   *
   * The stored refs are read with a targeted query rather than taken from the
   * cache. A managed goal ref is immutable once the lifecycle has written it —
   * `assertRawPlanUpdateAllowed` refuses to add or drop one — so the set this
   * read returns cannot change under the lock that follows it.
   */
  private async fencedGoalIds(
    tx: SQL,
    ledgerId: string,
    itemId: string,
    patchRefs: FieldValue | undefined,
  ): Promise<string[]> {
    if (ledgerId === GOALS_LEDGER) return [itemId];
    const rows = await tx<Array<{ fields_json: string }>>`
      SELECT fields_json FROM items
      WHERE project_key = ${this.projectKey} AND ledger = ${ledgerId} AND id = ${itemId}
    `;
    const stored = rows[0] === undefined
      ? undefined
      : (JSON.parse(rows[0].fields_json) as Item["fields"])["ledgerRefs"];
    return [...goalRefIds(stored), ...goalRefIds(patchRefs)];
  }

  /** Lock 1 — the goal rows, in a deterministic order. */
  private async lockGoalRows(tx: SQL, goalIds: readonly string[]): Promise<void> {
    for (const goalId of [...new Set(goalIds)].sort()) {
      await tx`
        SELECT 1 FROM items
        WHERE project_key = ${this.projectKey} AND ledger = ${GOALS_LEDGER} AND id = ${goalId}
        FOR UPDATE
      `;
    }
  }

  /** Lock every existing goal before tenant counters for cross-surface ordering. */
  private async lockAllGoalRows(tx: SQL): Promise<void> {
    await tx`
      SELECT 1 FROM items
      WHERE project_key = ${this.projectKey} AND ledger = ${GOALS_LEDGER}
      ORDER BY id FOR UPDATE
    `;
  }

  /** Lock 2 — this tenant's `ledgers` rows (id-allocation counters). */
  private async lockTenantCounters(tx: SQL): Promise<void> {
    await tx`
      SELECT 1 FROM ledgers WHERE project_key = ${this.projectKey} ORDER BY name FOR UPDATE
    `;
  }

  /**
   * Resolve and lock the native plan's keyed closure, re-read live state, then
   * apply the shared lifecycle logic and persist only its public/private delta
   * in the same transaction. Cache and search adoption follow commit.
   */
  private async runPlanLifecycleMutation<T>(
    request: PlanLifecycleRowRequest,
    mutate: (state: InMemoryPlanLifecycleState) => InMemoryPlanMutation<T>,
  ): Promise<T> {
    this.assertInit();
    const committed = await runPostgresKeyedOperation(this.pool(), {
      projectKey: this.projectKey, observer: this.accessObserver, monotonicNow: () => performance.now(), onClosureRetry: null,
    }, {
      name: `plan_${request.operation}`,
      resolve: (queries) => resolvePostgresPlanRows(queries, request, this.now),
      apply: async (queries, resolution) => {
        if (resolution.kind === "rejected") throw resolution.error;
        const plan = resolution.plan;
        const mutation = mutate(plan.state);
        const changed = await persistPostgresPlanRows(queries, plan, mutation.dirtyLedgers);
        const privateChanges = plan.privateChanges();
        await persistPostgresPrivateRecords(queries, privateChanges);
        const version = await recordPostgresCoherence(queries, this.coherenceOrigin,
          [...postgresPublicPlanChanges(plan, changed.ledgers), ...postgresPrivatePlanChanges(privateChanges)]);
        return { value: mutation.result, plan, dirty: changed.ledgers, version };
      },
    });
    await this.projectCommitted(committed.version, committed.dirty.map((ledgerId) => ({ ledgerId, op: "update" })));
    return committed.value;
  }


  /** Run one tenant-scoped owned lifecycle operation and notify after commit. */
  async runAtomicOwnedMutation<T>(mutate: (tx: WorksetOwnedWriteTx) => T, context: OwnedMutationContext): Promise<T> {
    this.assertInit();
    if (context === null) throw new LedgerError("PostgreSQL owned mutations require a closed operation descriptor");
    const committed = await runPostgresKeyedOperation(this.pool(), {
      projectKey: this.projectKey, observer: this.accessObserver, monotonicNow: () => performance.now(), onClosureRetry: null,
    }, {
      name: "direct" in context ? `direct_${context.direct.kind}` : `owned_${context.operation.kind}`,
      resolve: (queries) => "direct" in context ? resolvePostgresDirectOwnedRows(queries, context.direct, this.now)
        : resolvePostgresOwnedRows(queries, context, this.now),
      apply: async (queries, resolution) => {
        if (resolution.kind === "rejected") throw resolution.error;
        const { owned } = resolution;
        const value = mutate(owned.tx);
        const plan = { beforeLedgers: owned.beforeLedgers, state: { ledgers: owned.ledgers } };
        const changed = await persistPostgresPlanRows(queries, plan, [...owned.dirtyLedgers]);
        if ("admission" in context) assertOwnedMutationRows(context, owned.beforeLedgers, changed.items);
        const version = await recordPostgresCoherence(queries, this.coherenceOrigin, postgresPublicPlanChanges(plan, changed.ledgers));
        return { value, plan, dirty: changed.ledgers, version };
      },
    });
    await this.projectCommitted(committed.version, committed.dirty.map((ledgerId) => ({ ledgerId, op: "update" })));
    return committed.value;
  }

  /** Run one tenant-scoped guarded plan operation and notify only after commit. */
  async runAtomicWorksetPlanLifecycleMutation<T>(
    context: AdmittedPlanMutation,
    mutate: (tx: WorksetPlanLifecycleTx) => T,
  ): Promise<T> {
    this.assertInit();
    const committed = await runPostgresKeyedOperation(this.pool(), {
      projectKey: this.projectKey, observer: this.accessObserver, monotonicNow: () => performance.now(), onClosureRetry: null,
    }, {
      name: `guarded_${context.operation.kind}`,
      resolve: (queries) => resolvePostgresGuardedPlanRows(queries, context, this.now),
      apply: async (queries, resolution) => {
        if (resolution.kind === "rejected") throw resolution.error;
        const { plan, selected } = resolution;
        const lifecycle = createWorksetPlanLifecycleTransaction(plan.state);
        const result = mutate(lifecycle.tx);
        assertKeyedPlanMutationChanges(plan, context.operation, selected,
          result as PlanClaimResult | PlanPublishDraftResult | PlanReleaseResult | PlanFinalizeResult);
        const changed = await persistPostgresPlanRows(queries, plan, [...lifecycle.dirtyLedgers]);
        const privateChanges = plan.privateChanges();
        await persistPostgresPrivateRecords(queries, privateChanges);
        const version = await recordPostgresCoherence(queries, this.coherenceOrigin,
          [...postgresPublicPlanChanges(plan, changed.ledgers), ...postgresPrivatePlanChanges(privateChanges)]);
        return { result, plan, dirty: changed.ledgers, version };
      },
    });
    await this.projectCommitted(committed.version, committed.dirty.map((ledgerId) => ({ ledgerId, op: "update" })));
    return committed.result;
  }

  /** Run one generic mutation in one tenant-scoped PostgreSQL transaction. */
  async runAtomicGenericMutation<T>(
    mutate: (tx: WorksetGenericMutationTx, roots: WorksetRootsEpoch) => T,
    _readRoots: (() => Promise<WorksetRootsEpoch>) | undefined,
    _measurement: SqliteOperationMeasurement | undefined,
    _scope: SqliteOperationAccessScope | undefined,
    context: AdmittedGenericMutation | undefined,
    binding: AdmittedGenericMutationBinding | undefined,
  ): Promise<T> {
    this.assertInit();
    if (context === undefined || binding === undefined) throw new LedgerError("PostgreSQL generic mutations require an admitted operation descriptor and its binding");
    const committed = await runPostgresKeyedOperation(this.pool(), {
      projectKey: this.projectKey, observer: this.accessObserver, monotonicNow: () => performance.now(), onClosureRetry: null,
    }, {
      name: `generic_${context.scope.operation}`,
      resolve: (queries) => resolvePostgresGenericRows(queries, context, binding),
      apply: async (queries, resolution) => {
        if (resolution.kind === "rejected") throw resolution.error;
        const { rows } = resolution;
        const transaction = createGenericMutationTransaction({ ...rows, now: this.now });
        const result = mutate(transaction.tx, { roots: context.admission.roots, epoch: context.admission.epoch });
        const changed = await persistPostgresGenericRows(queries, rows, transaction, this.now);
        const publicChanges = postgresPublicPlanChanges({ beforeLedgers: rows.beforeLedgers, state: { ledgers: rows.ledgers } }, changed.ledgers)
          .filter((change) => change.kind !== "delete" || change.scope !== "control" || !change.documentId.startsWith(POSTGRES_GROUP_CONTROL_PREFIX) ||
            changed.groupDeletes.some(({ ledgerId, groupId }) => ledgerId === change.ledger && change.documentId === POSTGRES_GROUP_CONTROL_PREFIX + groupId));
        const version = await recordPostgresCoherence(queries, this.coherenceOrigin, [...publicChanges, ...postgresArchivedRowChanges(changed)]);
        return { result, rows, changed, dirtyArchives: transaction.dirtyArchives, version };
      },
    });
    await this.projectCommitted(committed.version, committed.changed.ledgers.map((ledgerId) => ({ ledgerId, op: committed.dirtyArchives.size > 0 ? "archive" : "update" })));
    return committed.result;
  }


  private async runOperatorActionLifecycleMutation(
    mutation: OperatorActionLifecycleMutation,
  ): Promise<OperatorActionLifecycleMutationResult> {
    this.assertInit();
    const committed = await runPostgresKeyedOperation(this.pool(), {
      projectKey: this.projectKey, observer: this.accessObserver, monotonicNow: () => performance.now(), onClosureRetry: null,
    }, {
      name: `operator_action_${mutation.kind}`,
      resolve: (queries) => resolvePostgresOperatorRows(queries, mutation, this.now),
      apply: async (queries, resolution) => {
        if (resolution.kind === "rejected") throw resolution.error;
        const outcome = resolution.apply();
        const dirty = await resolution.rows.persist(outcome.dirtyLedgers);
        const version = await recordPostgresCoherence(queries, this.coherenceOrigin, postgresSelectedRowChanges(resolution.rows.selected.values()));
        return { value: outcome.result, dirty, rows: [...resolution.rows.selected.values()], version };
      },
    });
    await this.projectCommitted(committed.version, committed.dirty.map((ledgerId) => ({ ledgerId, op: "update" })));
    return committed.value;
  }


  /**
   * Persist a whole mutated `Ledger` DIFFERENTIALLY — drop the rows it no
   * longer has, UPDATE the ones it kept, INSERT the ones it gained.
   *
   * SqliteLedgerStore's equivalent deletes every row of the ledger and
   * re-inserts it. Two reasons not to copy that here:
   *
   *  - `seq` is documented (see {@link PostgresLedgerStore.readActiveLedgers}'s
   *    caller) as assigned ONCE at INSERT, and it is the column the cache load
   *    orders by. A wholesale rewrite renumbers every row of every dirty ledger
   *    on every lifecycle mutation, which discards that invariant and churns the
   *    whole table for what is usually a handful of changed statuses.
   *  - It keeps the goal row's TUPLE IDENTITY, so a `FOR UPDATE` waiter follows
   *    the update chain and comes away actually holding the lock. A waiter whose
   *    blocker DELETEd the row instead finds it gone and proceeds unlocked.
   *    Measured honestly, this second point is about lock RETENTION, not about
   *    the two-party race: under READ COMMITTED the waiter's next statement
   *    re-reads the blocker's committed state either way, and swapping this
   *    method for a delete-and-reinsert does NOT make the T851 race test fail.
   *    Retention is still worth having — it is what stops a third transaction
   *    from interleaving behind the first waiter — but it is reasoning about
   *    Postgres semantics, not a result this suite demonstrates.
   */
  private async persistLedgerState(tx: SQL, ledger: Ledger): Promise<void> {
    const pk = this.projectKey;
    const existingGroups = new Set(
      (
        await tx<Array<{ id: string }>>`
          SELECT id FROM groups WHERE project_key = ${pk} AND ledger = ${ledger.id}
        `
      ).map(({ id }) => id),
    );
    const existingItems = new Set(
      (
        await tx<Array<{ id: string }>>`
          SELECT id FROM items WHERE project_key = ${pk} AND ledger = ${ledger.id}
        `
      ).map(({ id }) => id),
    );

    const keptGroups = new Set<string>();
    const keptItems = new Set<string>();
    for (const group of ledger.milestones) {
      keptGroups.add(group.id);
      if (existingGroups.has(group.id)) {
        await tx`
          UPDATE groups SET title = ${group.title}, description = ${group.description}
          WHERE project_key = ${pk} AND ledger = ${ledger.id} AND id = ${group.id}
        `;
      } else {
        await tx`
          INSERT INTO groups (project_key, ledger, id, title, description)
          VALUES (${pk}, ${ledger.id}, ${group.id}, ${group.title}, ${group.description})
        `;
      }
      for (const item of group.items) {
        keptItems.add(item.id);
        if (existingItems.has(item.id)) {
          await tx`
            UPDATE items
            SET milestone_id = ${item.milestoneId}, status = ${item.status},
                fields_json = ${JSON.stringify(item.fields)}, created_at = ${item.createdAt},
                updated_at = ${item.updatedAt}, author = ${item.author ?? null},
                session = ${item.session ?? null}
            WHERE project_key = ${pk} AND ledger = ${ledger.id} AND id = ${item.id}
          `;
        } else {
          await this.insertActiveRow(tx, ledger.id, item);
        }
      }
    }
    for (const id of existingItems) {
      if (!keptItems.has(id)) {
        await tx`DELETE FROM items WHERE project_key = ${pk} AND ledger = ${ledger.id} AND id = ${id}`;
      }
    }
    for (const id of existingGroups) {
      if (!keptGroups.has(id)) {
        await tx`DELETE FROM groups WHERE project_key = ${pk} AND ledger = ${ledger.id} AND id = ${id}`;
      }
    }
    await tx`
      UPDATE ledgers
      SET milestone_counter = ${ledger.counters.milestone}, item_counter = ${ledger.counters.item}
      WHERE project_key = ${pk} AND name = ${ledger.id}
    `;
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
    source: ReadonlyMap<string, Ledger> | null,
  ): StatusChangePrecondition | undefined {
    if (ledgerId === GOALS_LEDGER) {
      if (source === null) throw new LedgerError("Raw goal transitions require live transaction inputs");
      return (from: string, to: string): void =>
        assertGoalPhasePreconditions(
          itemId,
          from,
          to,
          source.get(QUESTIONS_LEDGER),
          source.get(DECISIONS_LEDGER),
          collectNonTerminalOwnedChildren(source, `${GOALS_LEDGER}:${itemId}`),
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
  private buildRefValidationContext(
    source: ReadonlyMap<string, Ledger> | null,
  ): RefValidationContext {
    const registry = buildPrefixRegistry(
      source === null ? this.readCache.registry() : [...source].map(([name, l]) => ({ name, schema: l.schema })),
    );
    return {
      registry,
      refExists: (ledger: string, id: string): boolean => {
        if (source === null && this.readCache.hasItem(ledger, id)) return true;
        const l = source === null ? undefined : source.get(ledger);
        if (l !== undefined) {
          for (const m of l.milestones) for (const it of m.items) if (it.id === id) return true;
        }
        return this.readCache.archivedItemsById(ledger, id).length > 0;
      },
      archivedUnsatisfying: (ledger: string, id: string): boolean => {
        if (source === null && this.readCache.hasItem(ledger, id)) return false;
        const active = source === null ? undefined : source.get(ledger);
        if (active !== undefined) {
          for (const m of active.milestones) for (const it of m.items) if (it.id === id) return false;
        }
        const schema = source === null ? this.readCache.schema(ledger) : active?.schema;
        if (schema === undefined) return false;
        return this.readCache.archivedItemsById(ledger, id).some((item) => !statusSatisfiesDependency(schema, item.status));
      },
    };
  }

  /** Record the exact durable delta inside its domain transaction. */
  private recordCoherence(tx: SQL, changes: readonly PostgresCoherenceChange[]): Promise<number | null> {
    return recordPostgresCoherence(new PostgresOperationQueries(tx, this.projectKey, "raw-coherence", this.accessObserver, () => performance.now(), null), this.coherenceOrigin, changes);
  }

  private recovery(): SearchProjectionRecovery {
    if (this.projectionRecovery === null) throw new ProjectionUnavailableError("PostgreSQL projection recovery is not mounted");
    return this.projectionRecovery;
  }

  private async loadProjectionFrame(afterVersion: number, rebuild: boolean, signal: AbortSignal): Promise<ProjectionChangeFrame> {
    const loaded = await readTransaction(this.pool(), async (tx) => {
      const queries = new PostgresOperationQueries(tx, this.projectKey, "coherence", this.accessObserver, () => performance.now(), null);
      const version = await postgresCoherenceVersion(queries);
      if (version < afterVersion) throw new LedgerError("PostgreSQL coherence version regressed");
      const entries = await readPostgresCoherence(queries, afterVersion, version);
      const foreignLedgers = [...new Set(entries.filter((entry) => entry.origin !== this.coherenceOrigin &&
        !(entry.scope === "control" && (entry.documentId.startsWith("plan_claims:") || entry.documentId.startsWith("plan_operations:"))))
        .map((entry) => entry.ledger))].sort();
      const snapshotRequired = rebuild || entries.some((entry) => entry.scope === "control" && entry.documentId === POSTGRES_RESET_CONTROL_ID) ||
        (version > afterVersion && !entries.some((entry) => entry.version === version));
      if (snapshotRequired) {
        const snapshot = await loadPostgresProjectionSnapshot(tx, this.projectKey);
        return { rows: snapshot.rows, frame: { version, foreignLedgers, changes: [], snapshot: snapshot.buckets } };
      }
      const rows = await loadPostgresProjectionRows(queries, entries, this.readCache);
      return { rows, frame: { version, foreignLedgers, changes: rows.changes, snapshot: null } };
    });
    signal.throwIfAborted();
    this.requiredCacheVersion = Math.max(this.requiredCacheVersion, loaded.frame.version);
    if (loaded.frame.snapshot !== null) this.readCache.clear();
    this.readCache.apply(loaded.rows);
    this.cachedVersion = loaded.frame.version;
    return loaded.frame;
  }

  private async projectCommitted(version: number | null, notifications: readonly { ledgerId: string; op: LedgerMutationOp }[]): Promise<void> {
    if (version === null) return;
    this.requiredCacheVersion = Math.max(this.requiredCacheVersion, version);
    if (notifications.length > 0) this.pendingNotifications.set(version, [...(this.pendingNotifications.get(version) ?? []), ...notifications]);
    try { await this.reconcileProjection(); }
    catch (error) { process.stderr.write(`PostgresLedgerStore: committed write awaits projection recovery: ${String(error)}\n`); }
  }

  private async notifyProjectionFrame(frame: ProjectionChangeFrame, signal: AbortSignal): Promise<void> {
    const delivered: number[] = [];
    const changed = new Set(frame.foreignLedgers);
    for (const [version, notifications] of this.pendingNotifications) {
      if (version > frame.version) continue;
      for (const notification of notifications) {
        signal.throwIfAborted();
        this.fireHook(notification.ledgerId, notification.op);
        changed.add(notification.ledgerId);
      }
      delivered.push(version);
    }
    for (const ledgerId of changed) for (const listener of this.projectionListeners) {
      signal.throwIfAborted();
      listener(ledgerId);
    }
    for (const version of delivered) this.pendingNotifications.delete(version);
  }



  /** Raw updates lock and read their item from SQL, independently of projection progress. */
  private async singleItemShim(sql: SQL, ledgerId: string, itemId: string): Promise<Ledger> {
    const metadata = await sql<LedgerRow[]>`
      SELECT name, schema_json, milestone_counter, item_counter FROM ledgers
      WHERE project_key = ${this.projectKey} AND name = ${ledgerId}
    `;
    const ledger = metadata[0];
    if (ledger === undefined) throw new LedgerNotFoundError(ledgerId);
    const rows = await sql<ItemRow[]>`
      SELECT * FROM items WHERE project_key = ${this.projectKey} AND ledger = ${ledgerId} AND id = ${itemId} FOR UPDATE
    `;
    const row = rows[0];
    return { id: ledgerId, schema: JSON.parse(ledger.schema_json) as LedgerSchema,
      counters: { milestone: ledger.milestone_counter, item: ledger.item_counter }, archivePointers: [],
      milestones: row === undefined ? [] : [{ id: row.milestone_id, title: "", description: "", items: [rowToItem(row)] }],
    };
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



  // ---------------------------------------------------------------------------
  // Internals — cache + locks (parity with InMemoryLedgerStore)
  // ---------------------------------------------------------------------------

  private observeTaskAdoptionEligibility(
    taskId: string,
    live: LiveTenantState,
  ): TaskAdoptionEligibilityObservation {
    const tasks = live.ledgers.get(TASKS_LEDGER);
    if (tasks === undefined) throw new LedgerNotFoundError(TASKS_LEDGER);
    return observeTaskAdoptionEligibility(
      taskId,
      tasks.milestones.flatMap(({ items }) => items),
      live.archived
        .filter(({ ledger }) => ledger === TASKS_LEDGER)
        .map((row) => rowToItem(row)),
    );
  }

  private async lockTaskAdoptionRows(tx: SQL): Promise<void> {
    await tx`
      SELECT 1 FROM items
      WHERE project_key = ${this.projectKey} AND ledger = ${TASKS_LEDGER}
      ORDER BY id FOR UPDATE
    `;
    await tx`
      SELECT 1 FROM archived_items
      WHERE project_key = ${this.projectKey} AND ledger = ${TASKS_LEDGER}
      ORDER BY id FOR UPDATE
    `;
  }

  private countReferences(milestoneId: string): Record<string, number> {
    return Object.fromEntries(Object.entries(this.readCache.milestoneItems(milestoneId)).map(([ledgerId, items]) => [ledgerId, items.length]));
  }


  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.readCache.hasLedger(ledgerId)) throw new LedgerNotFoundError(ledgerId);
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
    this.assertCacheReadable();
    return this.readCache.ledger(ledgerId);
  }

  private assertCacheReadable(): void {
    this.assertInit();
    if (this.cachedVersion < this.requiredCacheVersion) throw new ProjectionUnavailableError("PostgreSQL synchronous cache awaits committed-row recovery");
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
