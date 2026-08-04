/**
 * AbstractLedgerStore — the persistence-agnostic base class that holds ALL the
 * shared in-memory machinery of a `LedgerStore`, parameterised over the narrow
 * byte-I/O {@link LedgerPersistence} seam (G43 / Q190 / T350).
 *
 * Concern split (see {@link LedgerPersistence}'s doc comment):
 *   1. SHARED machinery — THIS class: the in-memory `Map<string, Ledger>`, the
 *      init() load loop + bootstrap + ambient-milestone seeding + legacy-pointer
 *      backfill, every read method (fetch/fetchItem/fetchMilestone/
 *      listMilestoneItems/snapshot/search/ftsSearch), every mutation method
 *      (updateItem/createItem/createMilestone/createLedger/updateMilestone/
 *      reopenItem/unarchiveItem/archiveMilestone), the AsyncMutex + advisory
 *      lockfile critical sections (withLock/withMilestonesLock/withRegistryLock),
 *      fireMutation/onMutation, the FTS index lifecycle, invalidate(), the
 *      schema-divergence DETECTION + reinit ORCHESTRATION, and dispose().
 *   2. BYTE-LEVEL I/O — the {@link LedgerPersistence} seam: read/write of the
 *      registry, each ledger `.md`, each archive file, and the divergence BACKUP
 *      bytes (delegated via `backupCanonicalState`).
 *
 * The concrete `FsLedgerStore` extends this and supplies an `FsPersistence` seam
 * plus the filesystem-only extension points (the `Lockfile` + `locksDir`, the
 * `~/.cache` mirror after a mutation, and the mirror drain at dispose). A future
 * `GitObjectLedgerBackend` (T351) extends the SAME base with a git-blob seam.
 *
 * Lock discipline (msunify cycle):
 *   - Per-ledger AsyncMutex + lockfile for within-ledger ops.
 *   - Global `__milestones__` AsyncMutex + lockfile for operations that mutate
 *     the milestones ledger OR create/archive items referencing it.
 *   - Multi-lock acquisition order: `__milestones__` first; then per-ledger locks
 *     in alphabetic order. This contract MUST hold for every multi-lock path to
 *     avoid cyclic deadlock.
 */

import type {
  ArchivePointer,
  FetchedLedger,
  Item,
  Ledger,
  LedgerSchema,
  Milestone,
} from "../types.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  LedgerError,
  LedgerNotFoundError,
} from "../types.js";
import { parseLedger, parseArchive, parseMilestoneItemArchive } from "../parser/parse.js";
import {
  serializeLedger,
  serializeArchive as serializeArchiveImpl,
  serializeMilestoneItemArchive,
} from "../parser/serialize.js";
import { EMPTY_REGISTRY, parseRegistry, serializeRegistry } from "../registry.js";
import type { LedgerRegistry, LedgerRegistryEntry } from "../types.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyEnsureAmbientMilestone,
  applyReattachItem,
  applyReopenItem,
  applyUpdateItem,
  applyUpdateMilestoneItem,
  collectNonTerminalChildren,
  validateMilestoneItemPatch,
  assertGoalPhasePreconditions,
  assertMilestoneActive,
  assertPrefixUnique,
  assertQuestionAnswerPrecondition,
  findItem,
  resolveMilestoneView,
  searchItems,
  validateSchema,
} from "./core.js";
import { UsageTracker } from "../usageStats.js";
import type { UsageStatsSnapshot } from "../usageStats.js";
import type { RefValidationContext, StatusChangePrecondition } from "./core.js";
import { buildPrefixRegistry } from "../refs.js";
import { materialiseFetchedLedger } from "./InMemoryLedgerStore.js";
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
} from "./LedgerStore.js";
import type { LedgerSnapshot } from "../snapshot.js";
import { buildSnapshot } from "../snapshot.js";
import { LedgerSearchIndex } from "../search/LedgerSearchIndex.js";
import { AsyncMutex } from "./mutex.js";
import { Lockfile } from "./lockfile.js";
import type { LedgerPersistence } from "./LedgerPersistence.js";
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
} from "../constants.js";
import { schemaCompatible, schemasEqual } from "./schemaCompat.js";
import {
  PlanPrivateClaimRecordSchema,
  PlanOperationReplayRecordSchema,
  type PlanClaimInput,
  type PlanClaimResult,
  type PlanFinalizeInput,
  type PlanFinalizeResult,
  type PlanLifecycleStore,
  type PlanPrivateClaimRecord,
  type PlanPublishDraftInput,
  type PlanPublishDraftResult,
  type PlanReleaseInput,
  type PlanReleaseResult,
} from "../planLifecycle.js";
import {
  claimInMemoryPlan,
  finalizeInMemoryPlan,
  publishInMemoryPlanDraft,
  releaseInMemoryPlanClaim,
  type InMemoryPlanLifecycleState,
  type InMemoryPlanOperationRecord,
} from "./inMemoryPlanLifecycle.js";
import {
  assertManagedGoalTransitionAllowed,
  assertManagedTaskTransitionAllowed,
  assertRawPlanCreateAllowed,
  assertRawPlanUpdateAllowed,
} from "./planLifecycleGuards.js";
import {
  rawTaskSerializationContender,
  type PlanLifecycleSerializationBoundaryHook,
  type PlanLifecycleSerializationContender,
} from "./planLifecycleSerialization.js";

// Moved to schemaCompat.ts (T527) so the sqlite backend's module graph stays
// free of this file's parser/serialize funnel; re-exported for compatibility.
export { schemaCompatible, schemasEqual } from "./schemaCompat.js";

/** Global lock key for the milestones-cross-ledger mutex/lockfile. */
const MILESTONES_LOCK_KEY = "__milestones__";
const REGISTRY_LOCK_KEY = "__registry__";

/**
 * Abstract base. `P` is the concrete persistence seam the subclass binds (e.g.
 * `FsPersistence`). The subclass constructs the base with the seam + the
 * advisory `Lockfile` + provides the lockfile root via {@link locksRoot}.
 */
export abstract class AbstractLedgerStore<P extends LedgerPersistence>
  implements LedgerStore, PlanLifecycleStore
{
  protected readonly persistence: P;
  private readonly mutexes = new Map<string, AsyncMutex>();
  protected readonly ledgers = new Map<string, Ledger>();
  protected readonly now: () => string;
  private readonly lockfile: Lockfile;
  protected readonly onMutation: OnMutation | null;
  protected readonly onSchemaDivergence: "backup-reinit" | "abort";
  protected readonly searchIndex = new LedgerSearchIndex();
  protected registry: LedgerRegistry = { ...EMPTY_REGISTRY, ledgers: [] };
  protected initialised = false;
  private readonly planClaims = new Map<string, PlanPrivateClaimRecord>();
  private readonly planOperations = new Map<string, InMemoryPlanOperationRecord>();
  private readonly planSerializationBoundaryHook: PlanLifecycleSerializationBoundaryHook | null;

  protected constructor(opts: {
    persistence: P;
    lockfile: Lockfile;
    now: () => string;
    onMutation: OnMutation | null;
    onSchemaDivergence: "backup-reinit" | "abort";
    planSerializationBoundaryHook: PlanLifecycleSerializationBoundaryHook | null;
  }) {
    this.persistence = opts.persistence;
    this.lockfile = opts.lockfile;
    this.now = opts.now;
    this.onMutation = opts.onMutation;
    this.onSchemaDivergence = opts.onSchemaDivergence;
    this.planSerializationBoundaryHook = opts.planSerializationBoundaryHook;
  }

  // ---------------------------------------------------------------------------
  // Backend extension points
  // ---------------------------------------------------------------------------

  /**
   * The directory under which the advisory lockfiles live (the FS backend's
   * `.cq/.locks`). The lockfile critical sections (withLock/withMilestonesLock/
   * withRegistryLock) acquire `<locksRoot>/<key>.lock`. The lockfile itself is
   * SHARED (it stays in `lockfile.ts`); only its root is backend-specific.
   */
  protected abstract locksRoot(): string;

  /**
   * Backend hook fired SYNCHRONOUSLY at the tail of {@link fireMutation}, AFTER
   * the lockfile is released, the in-memory map is updated, the active FTS docs
   * are rebuilt, and the user `onMutation` hook has run. The FS backend overrides
   * this to schedule its `~/.cache` mirror. Default: no-op. MUST NOT throw.
   */
  protected afterMutation(_ledgerId: string, _op: "create" | "update" | "archive"): void {
    /* default: backends with no post-write side-channel do nothing */
  }

  /**
   * Backend hook awaited inside {@link dispose} AFTER the mutex drain, so a
   * backend can drain its own in-flight fire-and-forget work (the FS backend
   * drains its in-flight cache mirrors here). Default: nothing to drain.
   */
  protected async drainBackend(): Promise<void> {
    /* default: nothing to drain */
  }

  // ---------------------------------------------------------------------------
  // fireMutation / FTS lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Rebuild active FTS docs, invoke the user `onMutation` hook, then fire the
   * backend {@link afterMutation} hook. Synchronous; never throws. Called AFTER
   * lockfile release (post-lock isolation). The user hook is GUARDED so a throw
   * is logged to stderr and cannot unwind the write path.
   *
   * The ARCHIVED FTS docs (which only change on an `archive` op, and require
   * I/O) are refreshed by `archiveMilestone`/`unarchiveItem` themselves.
   */
  protected fireMutation(ledgerId: string, op: "create" | "update" | "archive"): void {
    this.rebuildLedgerIndexActive(ledgerId);
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
    this.afterMutation(ledgerId, op);
  }

  /**
   * Rebuild the ACTIVE docs of `ledgerId` from the current in-memory ledger.
   * Synchronous, cheap, and GUARDED: an index error must never propagate into
   * the write path. No-op if the ledger is not loaded.
   */
  private rebuildLedgerIndexActive(ledgerId: string): void {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      this.searchIndex.rebuildLedgerActive(ledgerId, activeItemsOf(ledger));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`LedgerStore: FTS active-rebuild threw for ${ledgerId}: ${msg}\n`);
    }
  }

  /**
   * Rebuild the ARCHIVED docs of `ledgerId` by reading each archive pointer's
   * (immutable) source. Async + GUARDED: archive I/O failure must not unwind a
   * write. No-op if the ledger is not loaded.
   */
  protected async refreshLedgerIndexArchived(ledgerId: string): Promise<void> {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      const archived = await this.collectArchivedItems(ledgerId);
      this.searchIndex.setLedgerArchived(ledgerId, archived);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`LedgerStore: FTS archived-refresh threw for ${ledgerId}: ${msg}\n`);
    }
  }

  /**
   * Populate `title` and `status` on any ArchivePointer whose persisted entry
   * was written before T91 (and therefore lacks those fields). Fail-soft: a
   * missing or malformed archive source leaves the pointer unchanged and never
   * propagates. Called once during init().
   *
   * Source selection:
   * - milestones ledger: reads `ptr.path` (the single-ITEM archive at
   *   ./archive/milestones/<id>.md) and parses with parseMilestoneItemArchive.
   * - non-milestones ledger: `ptr.path` resolves to a milestone-GROUP archive
   *   carrying items but NO milestone title. For these we read the
   *   milestones-ledger single-ITEM archive at ./archive/milestones/<ptr.id>.md
   *   instead (D16 / T110).
   */
  private async backfillLegacyArchivePointers(ledger: Ledger): Promise<void> {
    const isMilestones = ledger.id === MILESTONES_LEDGER;
    for (const ptr of ledger.archivePointers) {
      if (ptr.title !== "" && ptr.status !== "") continue; // already populated
      const locator = isMilestones ? ptr.path : `./archive/${MILESTONES_LEDGER}/${ptr.id}.md`;
      let text: string;
      try {
        text = await this.persistence.readArchive(locator);
      } catch {
        // Missing archive source (or an escape rejection) — leave title/status
        // empty and do not throw (init must not fail on a legacy/absent file).
        continue;
      }
      try {
        const item = parseMilestoneItemArchive(text);
        if (ptr.title === "") {
          const t = item.fields["title"];
          if (typeof t === "string" && t.length > 0) ptr.title = t;
        }
        if (ptr.status === "") {
          if (item.status.length > 0) ptr.status = item.status;
        }
      } catch {
        // Malformed archive — leave title/status empty, do not throw.
      }
    }
  }

  /**
   * Read every archived item of `ledgerId` from its archive pointers. Files are
   * immutable, so this is called only at init and on archive/invalidate events.
   */
  private async collectArchivedItems(ledgerId: string): Promise<Item[]> {
    const ledger = this.ledgers.get(ledgerId);
    if (ledger === undefined) return [];
    const out: Item[] = [];
    for (const ptr of ledger.archivePointers) {
      const content = await this.fetchArchive(ledgerId, ptr.id);
      if (content.kind === "group") out.push(...content.milestone.items);
      else out.push(content.item);
    }
    return out;
  }

  /**
   * Build the FULL index entry (active + archived) for `ledgerId`. Used at init
   * and on the remote-coherence (`invalidate`) path.
   */
  private async indexLedgerFull(ledgerId: string): Promise<void> {
    this.rebuildLedgerIndexActive(ledgerId);
    await this.refreshLedgerIndexArchived(ledgerId);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialised) return;

    // Load registry.
    const registryText = await this.persistence.readRegistrySource();
    if (registryText === null) {
      await this.persistence.writeRegistrySource(serializeRegistry(EMPTY_REGISTRY));
      this.registry = { version: 1, ledgers: [] };
    } else {
      this.registry = parseRegistry(registryText);
    }

    // Bootstrap every canonical ledger if absent. Collect any on-disk schema
    // that diverged from canon.
    let registryDirty = false;
    const divergent: string[] = [];
    for (const canonical of CANONICAL_LEDGERS) {
      const entry = this.registry.ledgers.find((e) => e.name === canonical.name);
      if (entry === undefined) {
        this.registry.ledgers.push({ name: canonical.name, schema: canonical.schema });
        registryDirty = true;
      } else if (!schemasEqual(entry.schema, canonical.schema)) {
        if (schemaCompatible(entry.schema, canonical.schema)) {
          // Forward-compatible widening (T407): canon ADDED an optional field
          // (e.g. T405's `rawLogs`) absent from the persisted entry. Upgrade
          // the entry to canon IN PLACE — no destructive backup-reinit — so the
          // ledger loads with the canonical schema and persists the widened
          // shape. Existing items stay valid (the new field is optional).
          entry.schema = canonical.schema;
          registryDirty = true;
        } else {
          // A prior cycle / hand-edit wrote an out-of-band schema.
          divergent.push(canonical.name);
        }
      }
    }
    if (divergent.length > 0) {
      if (this.onSchemaDivergence === "abort") {
        // Opt-out: refuse to start so the divergence is loud + operator-handled.
        throw new BootstrapViolationError(
          `existing ${divergent.join(", ")} ledger(s) have a different schema than their canonical bootstrap schema`,
        );
      }
      // Default: back up the divergent state, then reinitialise the canonical
      // files + registry. backupAndReinit updates this.registry IN PLACE to
      // fresh canonical, so the load loop below iterates the FRESH registry.
      await this.backupAndReinit();
    } else if (registryDirty) {
      await this.writeRegistry();
    }

    // Load each ledger (including milestones).
    for (const entry of this.registry.ledgers) {
      const isMilestones = entry.name === MILESTONES_LEDGER;
      const text = await this.persistence.readLedgerSource(entry.name);
      let ledger: Ledger;
      let needsWrite = false;
      if (text === null) {
        ledger = freshLedger(entry.name, entry.schema);
        if (isMilestones) seedBootstrapGroup(ledger);
        needsWrite = true;
      } else {
        ledger = parseLedger(text, {
          schema: entry.schema,
          isMilestonesLedger: isMilestones,
        });
        if (isMilestones && ledger.milestones.length === 0) {
          // Empty milestones file (no active group). Seed it and rewrite.
          seedBootstrapGroup(ledger);
          needsWrite = true;
        }
      }
      if (isMilestones) {
        // Bootstrap the immortal M-AMBIENT milestone (§8b) if missing.
        const before = ledger.milestones.find((m) => m.id === MILESTONES_ACTIVE_GROUP_ID)?.items
          .length;
        applyEnsureAmbientMilestone(ledger, this.now());
        const after = ledger.milestones.find((m) => m.id === MILESTONES_ACTIVE_GROUP_ID)?.items
          .length;
        if (before !== after) needsWrite = true;
      }
      if (needsWrite) await this.writeLedgerFile(ledger);
      this.ledgers.set(entry.name, ledger);
    }
    // Replay an interrupted lifecycle commit BEFORE the legacy backfill: the
    // replay re-reads every ledger from the recovered durable bytes, which
    // would otherwise discard the backfill's in-memory pointer edits.
    await this.recoverPlanLifecycleUnderLocks();
    // Backfill title+status on legacy ArchivePointers (pre-T91). NOTE: the
    // milestones ledger must be processed FIRST (it appears first in
    // CANONICAL_LEDGERS, and `this.ledgers` preserves that insertion order
    // across the reload above) so its in-memory archivePointers are populated
    // before the non-milestones ledgers' backfill runs.
    for (const ledger of this.ledgers.values()) {
      await this.backfillLegacyArchivePointers(ledger);
    }
    this.initialised = true;
    // Build the FTS index for every loaded ledger (active + archived).
    for (const name of this.ledgers.keys()) {
      await this.indexLedgerFull(name);
    }
  }

  private readonly mcpUsage = new UsageTracker();

  /** I20/G155, T1509: process-local per-project usage counters shared by the
   * fs/git-object backends (not durable across process restart). */
  async recordMcpUsage(endpoint: string, bytesIn: number, bytesOut: number): Promise<void> {
    this.assertInit();
    this.mcpUsage.record(endpoint, bytesIn, bytesOut);
  }

  /** I20/G155, T1509: accumulated usage snapshot (name-sorted + totals). */
  async fetchMcpUsageStats(): Promise<UsageStatsSnapshot> {
    this.assertInit();
    return this.mcpUsage.snapshot();
  }

  async dispose(): Promise<void> {
    const drains = Array.from(this.mutexes.values()).map((m) => m.run(async () => undefined));
    await Promise.all(drains);
    // Drain any backend-owned in-flight fire-and-forget work (e.g. the FS
    // cache mirror) — extends the D-LED-06 drain contract to the backend.
    await this.drainBackend();
    this.ledgers.clear();
    this.planClaims.clear();
    this.planOperations.clear();
    this.mutexes.clear();
    this.initialised = false;
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

  // ---------------------------------------------------------------------------
  // Reads
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

  fetchMilestone(milestoneId: string): FetchedMilestoneItem {
    this.assertInit();
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const resolved = resolveMilestoneView(milestonesLedger, milestoneId);
    if (resolved === null) {
      throw new LedgerError(`milestone ${milestoneId} not found`);
    }
    const item = findItem(milestonesLedger, milestoneId).item;
    const references = this.countReferences(milestoneId);
    return { milestone: cloneItem(item), resolved, references };
  }

  listMilestoneItems(milestoneId: string): Record<string, Item[]> {
    this.assertInit();
    const out: Record<string, Item[]> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      if (group.items.length === 0) continue;
      out[name] = group.items.map(cloneItem);
    }
    return out;
  }

  snapshot(): LedgerSnapshot {
    this.assertInit();
    return buildSnapshot(this.enumerate().map((name) => this.fetch(name)));
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

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    const ledger = this.getLedger(ledgerId);
    const ptr = ledger.archivePointers.find((p) => p.id === archiveId);
    if (ptr === undefined) {
      throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
    }
    const text = await this.persistence.readArchive(ptr.path);
    if (ledgerId === MILESTONES_LEDGER) {
      const item = parseMilestoneItemArchive(text);
      return { kind: "item", item };
    }
    return { kind: "group", milestone: parseArchive(text) };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Build the optional `StatusChangePrecondition` for an `updateItem` against
   * `ledgerId`. The rule logic lives in core.ts; this only resolves the inputs
   * each rule needs from the store's own in-memory view (held under the
   * ledger lock). Returns `undefined` for ledgers with no status-change rule.
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
   * Build the cross-ledger {@link RefValidationContext} for a create/update
   * write (G80/M245). The prefix registry + active lookup come from the
   * in-memory `this.ledgers` (all registered ledgers, kept loaded); archived
   * existence comes from the FTS index's archived bucket (the only synchronous
   * in-memory item-level archive view — built from the immutable archive files
   * at init/on-archive). Cross-process staleness is the same best-effort
   * coherence documented for the F2 status-change preconditions.
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
        return this.searchIndex.hasArchivedItem(ledger, id);
      },
    };
  }

  async updateMilestone(milestoneId: string, patch: UpdateMilestoneItemPatch): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledgerIds = this.lockableLedgerIds();
      return this.withLocksInOrder(ledgerIds, async () => {
        // H41/D61: reload from the ref tip under the locks so the mutation
        // and the parent-liveness scan both see fresh state.
        await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
        for (const ledgerId of ledgerIds) await this.reloadLedgerFromDisk(ledgerId);
        const ledger = this.getLedger(MILESTONES_LEDGER);
        const blockers = collectNonTerminalChildren(this.ledgers, milestoneId);
        const it = applyUpdateMilestoneItem(
          ledger,
          milestoneId,
          patch,
          this.now(),
          this.buildRefValidationContext(),
          blockers,
        );
        await this.writeLedgerFile(ledger);
        return cloneItem(it);
      });
    });
    // Hook fires AFTER lockfile release per D-COHERENCE contract.
    this.fireMutation(MILESTONES_LEDGER, "update");
    return item;
  }

  async updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      // Canonical disposition (D267/T1856): validate as milestone fields and
      // delegate to the same updateMilestone path — one behavior, one
      // diagnostic, one lock order.
      return this.updateMilestone(itemId, validateMilestoneItemPatch(patch));
    }
    const it = await this.withMilestonesLock(() =>
      this.withFreshGoalsForPlanGuard(ledgerId, () =>
        this.withLock(ledgerId, async () => {
        const contender = rawTaskSerializationContender(ledgerId, patch.status);
        if (contender !== null && this.planSerializationBoundaryHook !== null) {
          await this.planSerializationBoundaryHook(contender);
        }
        // H41/D61: reload from the ref tip under the lock before reading/mutating.
        await this.reloadLedgerFromDisk(ledgerId);
        const ledger = this.getLedger(ledgerId);
        assertRawPlanUpdateAllowed(
          this,
          (id) => this.planGuardLedger(id),
          ledgerId,
          ledger,
          itemId,
          patch,
        );
        const precondition = this.statusChangePrecondition(ledgerId, ledger, itemId, patch);
        const x = applyUpdateItem(
          ledger,
          itemId,
          patch,
          this.now(),
          precondition,
          this.buildRefValidationContext(),
        );
        await this.writeLedgerFile(ledger);
        return cloneItem(x);
      }),
      ),
    );
    this.fireMutation(ledgerId, "update");
    return it;
  }

  async createItem(ledgerId: string, milestoneId: string, init: CreateItemInit): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
      );
    }
    const item = await this.withMilestonesLock(async () => {
      // H41/D61: reload the milestones ledger from the ref tip before the
      // active-group check so it reflects peer commits.
      await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
      assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      return this.withFreshGoalsForPlanGuard(ledgerId, () =>
        this.withLock(ledgerId, async () => {
          // H41/D61: reload the target ledger from the ref tip before id
          // allocation + mutation so fresh counters/items are used.
          await this.reloadLedgerFromDisk(ledgerId);
          const ledger = this.getLedger(ledgerId);
          assertRawPlanCreateAllowed((id) => this.planGuardLedger(id), ledgerId, init.fields);
          const x = applyCreateItem(
            ledger,
            milestoneId,
            init,
            this.now(),
            this.buildRefValidationContext(),
          );
          await this.writeLedgerFile(ledger);
          return cloneItem(x);
        }),
      );
    });
    this.fireMutation(ledgerId, "create");
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      // H41/D61: reload the milestones ledger from the ref tip under the lock so
      // id allocation uses fresh counters (no duplicate M<n> / clobbered write).
      await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
      const ledger = this.getLedger(MILESTONES_LEDGER);
      const x = applyCreateMilestoneItem(
        ledger,
        init,
        this.now(),
        this.buildRefValidationContext(),
      );
      await this.writeLedgerFile(ledger);
      return cloneItem(x);
    });
    this.fireMutation(MILESTONES_LEDGER, "create");
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(`ledger name "${MILESTONES_LEDGER}" is reserved`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new LedgerError(`invalid ledger name "${name}": only A-Za-z0-9_- are allowed`);
    }
    validateSchema(schema);
    if (this.ledgers.has(name)) {
      throw new DuplicateIdError("ledger", name);
    }
    assertPrefixUnique(name, schema, this.registry.ledgers);
    const result = await this.withRegistryLock(async () => {
      // D62: reload registry from the ref tip under the lock so a peer's
      // concurrent createLedger is observed before the dup/prefix guards and
      // writeRegistry — mirrors the D61 reloadLedgerFromDisk pattern.
      const txt = await this.persistence.readRegistrySource();
      if (txt !== null) this.registry = parseRegistry(txt);
      // D65: after reloading the registry, reconcile this.ledgers so any peer-
      // learned ledger is loaded+indexed into memory. The about-to-be-created
      // ledger is not yet in the registry so it won't be pre-loaded here.
      for (const entry of this.registry.ledgers) {
        if (!this.ledgers.has(entry.name)) await this.loadAndIndexLedger(entry);
      }
      if (this.ledgers.has(name)) {
        throw new DuplicateIdError("ledger", name);
      }
      // Re-check under lock: a concurrent createLedger may have taken the prefix.
      assertPrefixUnique(name, schema, this.registry.ledgers);
      const ledger = freshLedger(name, schema);
      this.ledgers.set(name, ledger);
      this.registry.ledgers.push({ name, schema });
      await this.writeLedgerFile(ledger);
      await this.writeRegistry();
      return materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
    });
    this.fireMutation(name, "create");
    return result;
  }

  async reopenItem(ledgerId: string, itemId: string, toStatus: string): Promise<Item> {
    const it = await this.withMilestonesLock(() =>
      this.withFreshGoalsForPlanGuard(ledgerId, () =>
        this.withLock(ledgerId, async () => {
        // H41/D61: reload from the ref tip under the lock before reading/mutating.
        await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
        await this.reloadLedgerFromDisk(ledgerId);
        const ledger = this.getLedger(ledgerId);
        // Raw reopen is a write path distinct from updateItem and carries the
        // SAME managed-plan fence (parity with SqliteLedgerStore.reopenItem):
        // without it a managed goal or a superseded task can be reopened
        // outside PlanLifecycleStore.
        const source = findItem(ledger, itemId).item;
        if (ledgerId === GOALS_LEDGER) {
          assertManagedGoalTransitionAllowed(source, toStatus);
        }
        if (ledgerId === TASKS_LEDGER) {
          assertManagedTaskTransitionAllowed(
            this,
            (id) => this.planGuardLedger(id),
            source,
            toStatus,
          );
        }
        // D267/T1856: resurrection respects parent liveness.
        assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), source.milestoneId);
        const x = applyReopenItem(ledger, itemId, toStatus, this.now());
        await this.writeLedgerFile(ledger);
        return cloneItem(x);
      }),
      ),
    );
    this.fireMutation(ledgerId, "update");
    return it;
  }

  async unarchiveItem(ledgerId: string, milestoneId: string, itemId: string): Promise<Item> {
    const isMilestones = ledgerId === MILESTONES_LEDGER;
    const reattached = await this.withMilestonesLock(async () => {
      // D267/T1856: milestones-first order; the archived status is read
      // authoritatively here (from the freshly reloaded ledger pointers and
      // the archive read under the same lock), and the milestone, ledger,
      // pointer, and archive state are all refreshed from the ref tip.
      await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
      return this.withLock(ledgerId, async () => {
        // H41/D61: reload from the ref tip under the lock before reading/mutating.
        await this.reloadLedgerFromDisk(ledgerId);
      const ledger = this.getLedger(ledgerId);
      const ptr = ledger.archivePointers.find((p) => p.id === milestoneId);
      if (ptr === undefined) {
        throw new LedgerError(
          isMilestones
            ? `no archived item ${milestoneId} in ledger ${ledgerId}`
            : `no archived group for milestone ${milestoneId} in ledger ${ledgerId}`,
        );
      }
      const locator = ptr.path;
      const text = await this.persistence.readArchive(locator);

      if (isMilestones) {
        // Per-ITEM archive file: the single archived milestone-item.
        const archivedItem = parseMilestoneItemArchive(text);
        if (archivedItem.id !== itemId) {
          throw new LedgerError(
            `archived item file ${milestoneId} in ledger ${ledgerId} does not contain item ${itemId}`,
          );
        }
        if (!new Set(ledger.schema.terminalStatuses).has(archivedItem.status)) {
          // D267/T1856: reject BEFORE re-attachment under a closed parent;
          // the archived status came from the archive file under this lock.
          assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), archivedItem.milestoneId);
        }
        const out = applyReattachItem(ledger, archivedItem.milestoneId, archivedItem, this.now());
        // Per-item archive always becomes empty on extraction: remove the
        // file + its pointer entirely.
        await this.persistence.removeArchive(locator);
        this.removeArchivePointer(ledger, milestoneId);
        await this.writeLedgerFile(ledger);
        return cloneItem(out);
      }

      // Non-milestones ledger: a milestone-GROUP archive file. Extract ONLY
      // the requested item, re-attach it, and rewrite the group WITHOUT it
      // (removing the file + pointer when the group becomes empty).
      const group = parseArchive(text);
      const idx = group.items.findIndex((it) => it.id === itemId);
      if (idx < 0) {
        throw new LedgerError(
          `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      const [extracted] = group.items.splice(idx, 1);
      if (extracted === undefined) {
        throw new LedgerError(
          `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      if (!new Set(ledger.schema.terminalStatuses).has(extracted.status)) {
        assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      }
      const out = applyReattachItem(ledger, milestoneId, extracted, this.now());
      if (group.items.length === 0) {
        // Last item removed — drop the group archive file + its pointer.
        await this.persistence.removeArchive(locator);
        this.removeArchivePointer(ledger, milestoneId);
      } else {
        // Rewrite the group archive WITHOUT the extracted item; the pointer
        // (id/path/summary/title/status) is unchanged.
        await this.persistence.writeArchive(locator, serializeArchiveImpl(group));
      }
      await this.writeLedgerFile(ledger);
      return cloneItem(out);
      });
    });
    // The active docs gained an item and the archived docs shrank/vanished;
    // refresh both. fireMutation rebuilds active; refresh archived explicitly.
    this.fireMutation(ledgerId, "update");
    await this.refreshLedgerIndexArchived(ledgerId);
    return reattached;
  }

  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    // Snapshot the set of ledgers that will be archived so we can fire
    // per-participant hooks AFTER all writes complete + locks release.
    let participatingLedgers: string[] = [];
    const ptr = await this.withMilestonesLock(async () => {
      const otherLedgerIds = Array.from(this.ledgers.keys())
        .filter((n) => n !== MILESTONES_LEDGER)
        .sort();
      return this.withLocksInOrder(otherLedgerIds, async () => {
        participatingLedgers = otherLedgerIds.filter((id) => {
          const l = this.ledgers.get(id);
          return l !== undefined && l.milestones.some((m) => m.id === milestoneId);
        });
        return this.performArchive(milestoneId, summary);
      });
    });
    // Fire per-participant hooks AFTER lockfile release.
    for (const id of participatingLedgers) this.fireMutation(id, "archive");
    this.fireMutation(MILESTONES_LEDGER, "archive");
    // Archived FTS docs change only on archive. Refresh them for every
    // participating ledger (and the milestones ledger).
    for (const id of participatingLedgers) await this.refreshLedgerIndexArchived(id);
    await this.refreshLedgerIndexArchived(MILESTONES_LEDGER);
    return ptr;
  }

  /**
   * Back up the divergent state and reinitialise canonical state from scratch.
   * The byte-level BACKUP is delegated to the seam
   * ({@link LedgerPersistence.backupCanonicalState}); the DETECTION + the
   * reinit ORCHESTRATION (fresh canonical registry + ledger writes, milestones
   * bootstrap-group + M-AMBIENT seeding) stay here. Returns the backup locator
   * the seam produced (the absolute backup dir for the FS backend).
   */
  protected async backupAndReinit(): Promise<string> {
    // (a/b) Delegate the byte-level backup to the seam (copies + orphan unlink).
    const backupDir = await this.persistence.backupCanonicalState();

    // (d) Warn BEFORE rewriting so the locator is logged even if a write fails.
    process.stderr.write(
      `WARNING: LedgerStore divergence detected — prior state backed up to ${backupDir}\n`,
    );

    // (c) Rewrite fresh canonical registry.
    this.registry = { version: 1, ledgers: [] };
    for (const canonical of CANONICAL_LEDGERS) {
      this.registry.ledgers.push({ name: canonical.name, schema: canonical.schema });
    }
    await this.writeRegistry();

    // (c) Rewrite fresh canonical ledger files with the milestones bootstrap
    // group + M-AMBIENT ambient milestone seeded.
    for (const canonical of CANONICAL_LEDGERS) {
      const isMilestones = canonical.name === MILESTONES_LEDGER;
      const ledger = freshLedger(canonical.name, canonical.schema);
      if (isMilestones) {
        seedBootstrapGroup(ledger);
        applyEnsureAmbientMilestone(ledger, this.now());
      }
      await this.writeLedgerFile(ledger);
    }
    this.planClaims.clear();
    this.planOperations.clear();
    await this.persistence.commitPlanLifecycle({
      state: this.serializePlanLifecycleState(),
      ledgers: {},
    });
    return backupDir;
  }

  /**
   * Load a ledger from its source file and index it into this.ledgers and the
   * FTS index. Shared by invalidate's unknown-ledger branch and createLedger's
   * post-reload reconcile loop (DRY — fixes D65).
   *
   * Early-returns (no-op) if the source file is not yet present, so callers
   * can use this as a safe "load if available" primitive.
   */
  private async loadAndIndexLedger(entry: LedgerRegistryEntry): Promise<void> {
    const text = await this.persistence.readLedgerSource(entry.name);
    if (text === null) return;
    const ledger = parseLedger(text, {
      schema: entry.schema,
      isMilestonesLedger: entry.name === MILESTONES_LEDGER,
    });
    this.ledgers.set(entry.name, ledger);
    await this.indexLedgerFull(entry.name);
  }

  /**
   * Drop the in-memory cache for `ledgerId` and re-read it from the source under
   * the per-ledger lock. Used by the cross-process coherence channel
   * (D-COHERENCE) on inbound `ledger.changed` notifications.
   */
  async invalidate(ledgerId: string): Promise<void> {
    this.assertInit();
    if (this.ledgers.has(ledgerId)) {
      await this.withLock(ledgerId, async () => {
        await this.reloadLedgerFromDisk(ledgerId);
      });
      // The in-memory ledger was replaced by a peer's committed state; rebuild
      // its FTS docs so a remote write is searchable here. Archives are
      // immutable but the remote op may have been an `archive`, so refresh both.
      await this.indexLedgerFull(ledgerId);
      return;
    }
    // Unknown ledger — reload registry and, if it's now there, load it.
    await this.withRegistryLock(async () => {
      const registryText = await this.persistence.readRegistrySource();
      if (registryText === null) return; // no registry yet — nothing to learn
      const fresh = parseRegistry(registryText);
      this.registry = fresh;
      const entry = fresh.ledgers.find((e) => e.name === ledgerId);
      if (entry === undefined) return; // still doesn't exist; nothing to do
      // F1: a brand-new ledger learned via the registry-reload path must be
      // indexed too, or a cross-process `createLedger` leaves it unsearchable.
      // The helper's null-return handles the "registered but not yet written" race.
      await this.loadAndIndexLedger(entry);
    });
  }

  /**
   * Re-read `<ledgerId>` source under the assumption that the per-ledger lock is
   * already held. Used by `invalidate` for known ledgers. Silent no-op if the
   * source disappeared.
   */
  private async reloadLedgerFromDisk(ledgerId: string): Promise<void> {
    const entry = this.registry.ledgers.find((e) => e.name === ledgerId);
    if (entry === undefined) return;
    const isMilestones = entry.name === MILESTONES_LEDGER;
    const text = await this.persistence.readLedgerSource(entry.name);
    if (text === null) return;
    const ledger = parseLedger(text, {
      schema: entry.schema,
      isMilestonesLedger: isMilestones,
    });
    this.ledgers.set(entry.name, ledger);
  }

  private planLifecycleState(): InMemoryPlanLifecycleState {
    return {
      ledgers: this.ledgers,
      claims: this.planClaims,
      operations: this.planOperations,
      now: this.now,
    };
  }

  /**
   * The {@link LoadPlanGuardLedger} seam the shared {@link planLifecycleGuards}
   * read a referenced goal through. Serves the in-memory map, which
   * {@link withFreshGoalsForPlanGuard} has just refreshed from the persistence
   * seam under the goals lock on every path that consults it.
   */
  private planGuardLedger(ledgerId: string): Ledger {
    return this.getLedger(ledgerId);
  }

  /**
   * Run `fn` with the goals ledger RELOADED from the persistence seam under the
   * goals lock, whenever the raw plan-lifecycle fence for a write to `ledgerId`
   * consults it. Only a TASKS write does: the guards read the goals ledger to
   * decide whether a referenced goal is lifecycle-managed, while a GOALS write
   * already reloads its own ledger under its own lock.
   *
   * Reading that snapshot WITHOUT the lock breaks the H41/D61
   * reload-under-lock discipline every other mutation path here follows: a
   * peer's committed claim/finalize stays invisible, the fence decides on a
   * stale cache, and a raw task-start or follow-up write slips past a managed
   * plan.
   *
   * Lock order is the documented one — `__milestones__` first (already held by
   * `createItem` when it reaches here), then per-ledger locks in ALPHABETIC
   * order. `goals` sorts before `tasks`, so taking goals here and the target
   * ledger inside `fn` preserves the global order; do NOT invert them.
   */
  private async withFreshGoalsForPlanGuard<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (ledgerId !== TASKS_LEDGER || !this.ledgers.has(GOALS_LEDGER)) return fn();
    return this.withLock(GOALS_LEDGER, async () => {
      await this.reloadLedgerFromDisk(GOALS_LEDGER);
      return fn();
    });
  }

  /**
   * The per-ledger locks the plan-lifecycle critical section covers, in the
   * documented ALPHABETIC acquisition order. The `__milestones__` lock is taken
   * separately and FIRST by every caller.
   */
  private lockableLedgerIds(): string[] {
    return [...this.ledgers.keys()].filter((id) => id !== MILESTONES_LEDGER).sort();
  }

  /**
   * Replay an interrupted plan-lifecycle commit, then reload every ledger and
   * the private lifecycle state from the recovered durable bytes. The CALLER
   * MUST already hold the milestones lock plus every per-ledger lock in
   * `ledgerIds`, acquired in the documented order.
   */
  private async replayPlanLifecycleCommitUnderHeldLocks(
    ledgerIds: readonly string[],
  ): Promise<void> {
    await this.persistence.recoverPlanLifecycleCommit();
    await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
    for (const ledgerId of ledgerIds) await this.reloadLedgerFromDisk(ledgerId);
    await this.loadPlanLifecycleState();
  }

  /**
   * init()-time recovery. `recoverPlanLifecycleCommit` REWRITES every ledger a
   * pending commit names, so it is a mutation and must run inside the SAME
   * ordered lock set {@link runPlanLifecycleMutation} holds. Unlocked, an
   * initialising peer can read the pending marker for commit N, be descheduled
   * while a writer completes commits N and N+1, and then apply the superseded
   * payload — regressing every ledger the marker names.
   *
   * Runs AFTER the init() load loop so `withLock` sees the ledgers it guards,
   * and reloads them from whatever the replay left durable.
   */
  private async recoverPlanLifecycleUnderLocks(): Promise<void> {
    if (!(await this.persistence.hasPendingPlanLifecycleCommit())) {
      // Nothing to replay, so no ledger is about to be rewritten and a plain
      // open pays for no lock I/O at all (the git-object backend must not
      // materialise its real-filesystem `.cq/.locks` root just to open — K117).
      // Reading the durable state stays an unlocked read, as it always was.
      await this.loadPlanLifecycleState();
      return;
    }
    const ledgerIds = this.lockableLedgerIds();
    await this.withMilestonesLock(() =>
      this.withLocksInOrder(ledgerIds, () =>
        this.replayPlanLifecycleCommitUnderHeldLocks(ledgerIds),
      ),
    );
  }

  private async loadPlanLifecycleState(): Promise<void> {
    this.planClaims.clear();
    this.planOperations.clear();
    const text = await this.persistence.readPlanLifecycleState();
    if (text === null) return;
    // A truncated/hand-edited state file must surface as a LedgerError like
    // every other malformed-shape branch below, not a raw SyntaxError that
    // makes the store unopenable with an unrecognisable failure.
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new LedgerError("invalid persisted plan lifecycle state");
    }
    if (typeof value !== "object" || value === null) {
      throw new LedgerError("invalid persisted plan lifecycle state");
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record["claims"]) || !Array.isArray(record["operations"])) {
      throw new LedgerError("invalid persisted plan lifecycle state");
    }
    for (const raw of record["claims"]) {
      const entry = PlanPrivateClaimRecordSchema.parse(raw);
      this.planClaims.set(`${entry.goalId}\u0000${entry.claimRequestId}`, entry);
    }
    for (const raw of record["operations"]) {
      if (typeof raw !== "object" || raw === null) {
        throw new LedgerError("invalid persisted plan lifecycle operation");
      }
      const operation = raw as Record<string, unknown>;
      const replay = PlanOperationReplayRecordSchema.parse(operation["replay"]);
      this.planOperations.set(
        [
          replay.goalId,
          replay.claimId,
          replay.generation,
          replay.operation,
          replay.operationId,
        ].join("\u0000"),
        { replay, acknowledgement: operation["acknowledgement"] },
      );
    }
  }

  private serializePlanLifecycleState(): string {
    return JSON.stringify({
      version: 1,
      claims: [...this.planClaims.values()],
      operations: [...this.planOperations.values()],
    });
  }

  private async runPlanLifecycleMutation<T>(
    mutate: (state: InMemoryPlanLifecycleState) => { result: T; dirtyLedgers: readonly string[] },
    contender: PlanLifecycleSerializationContender | null,
  ): Promise<T> {
    this.assertInit();
    const ledgerIds = this.lockableLedgerIds();
    const mutation = await this.withMilestonesLock(() =>
      this.withLocksInOrder(ledgerIds, async () => {
        if (contender !== null && this.planSerializationBoundaryHook !== null) {
          await this.planSerializationBoundaryHook(contender);
        }
        await this.replayPlanLifecycleCommitUnderHeldLocks(ledgerIds);
        const beforeLedgers = cloneMap(this.ledgers);
        const beforeClaims = cloneMap(this.planClaims);
        const beforeOperations = cloneMap(this.planOperations);
        try {
          const outcome = mutate(this.planLifecycleState());
          if (outcome.dirtyLedgers.length > 0) {
            const sources: Record<string, string> = {};
            const ordered = [...new Set(outcome.dirtyLedgers)].sort((left, right) => {
              if (left === GOALS_LEDGER) return 1;
              if (right === GOALS_LEDGER) return -1;
              return left.localeCompare(right);
            });
            for (const ledgerId of ordered) {
              const ledger = this.ledgers.get(ledgerId);
              if (ledger === undefined) {
                throw new LedgerError(`ledger not found: ${ledgerId}`);
              }
              sources[ledgerId] = serializeLedger(ledger);
            }
            await this.persistence.commitPlanLifecycle({
              state: this.serializePlanLifecycleState(),
              ledgers: sources,
            });
          }
          return outcome;
        } catch (error) {
          replaceMap(this.ledgers, beforeLedgers);
          replaceMap(this.planClaims, beforeClaims);
          replaceMap(this.planOperations, beforeOperations);
          throw error;
        }
      }),
    );
    for (const ledgerId of new Set(mutation.dirtyLedgers)) {
      this.fireMutation(ledgerId, "update");
    }
    return mutation.result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Drop the ArchivePointer keyed by `archiveId` from `ledger` (if present). */
  private removeArchivePointer(ledger: Ledger, archiveId: string): void {
    const i = ledger.archivePointers.findIndex((p) => p.id === archiveId);
    if (i >= 0) ledger.archivePointers.splice(i, 1);
  }

  private countReferences(milestoneId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      if (group.items.length > 0) out[name] = group.items.length;
    }
    return out;
  }

  private async performArchive(milestoneId: string, summary: string): Promise<ArchivePointer> {
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
    // H41/D61: under archiveMilestone's all-held locks (milestones lock + every
    // per-ledger lock acquired in order), reload the milestones ledger and every
    // participating ledger from the ref tip before reading/mutating, so the
    // archive operates on fresh in-memory state rather than a stale cache.
    await this.reloadLedgerFromDisk(MILESTONES_LEDGER);
    for (const name of Array.from(this.ledgers.keys())) {
      if (name === MILESTONES_LEDGER) continue;
      await this.reloadLedgerFromDisk(name);
    }
    // Phase 1 — verify no non-terminal items in ANY ledger.
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      const terminal = new Set(ledger.schema.terminalStatuses);
      const offending = group.items.filter((it) => !terminal.has(it.status)).map((it) => it.id);
      if (offending.length > 0) {
        // Surface via applyDetachMilestoneGroup so error types match.
        applyDetachMilestoneGroup(
          ledger,
          milestoneId,
          summary,
          `./archive/${name}/${milestoneId}.md`,
          "",
          "",
        );
      }
    }
    // Phase 1b — verify the milestone-item itself is terminal.
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const group = milestonesLedger.milestones.find((m) => m.id === MILESTONES_ACTIVE_GROUP_ID);
    if (group === undefined) {
      throw new BootstrapViolationError(`milestones ledger is missing its bootstrap group`);
    }
    const milestoneItem = group.items.find((it) => it.id === milestoneId);
    if (milestoneItem === undefined) {
      applyDetachMilestoneItem(
        milestonesLedger,
        milestoneId,
        summary,
        `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
        "",
        "",
      );
    } else {
      const terminal = new Set(milestonesLedger.schema.terminalStatuses);
      if (!terminal.has(milestoneItem.status)) {
        applyDetachMilestoneItem(
          milestonesLedger,
          milestoneId,
          summary,
          `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`,
          "",
          "",
        );
      }
    }
    // Extract title and status from the milestoneItem (guaranteed non-null and
    // terminal after Phase 1b; used to populate the ArchivePointer fields).
    const msTitle =
      typeof milestoneItem?.fields["title"] === "string" ? milestoneItem.fields["title"] : "";
    const msStatus = milestoneItem?.status ?? "";
    // Phase 2 — for each non-milestones ledger with a matching group: detach
    // in-memory, write the archive file, write the ledger file.
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const hasGroup = ledger.milestones.some((m) => m.id === milestoneId);
      if (!hasGroup) continue;
      const relPath = `./archive/${name}/${milestoneId}.md`;
      const { milestone } = applyDetachMilestoneGroup(
        ledger,
        milestoneId,
        summary,
        relPath,
        msTitle,
        msStatus,
      );
      await this.persistence.writeArchive(relPath, serializeArchiveImpl(milestone));
      await this.writeLedgerFile(ledger);
    }
    // Phase 3 — detach the milestone-item from the milestones ledger, write its
    // single-item archive, write the milestones ledger.
    const relPath = `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`;
    const { item, pointer } = applyDetachMilestoneItem(
      milestonesLedger,
      milestoneId,
      summary,
      relPath,
      msTitle,
      msStatus,
    );
    await this.persistence.writeArchive(relPath, serializeMilestoneItemArchive(item));
    await this.writeLedgerFile(milestonesLedger);
    return { ...pointer };
  }

  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ledgers.has(ledgerId)) {
      throw new LedgerNotFoundError(ledgerId);
    }
    const mutex = this.mutexFor(ledgerId);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksRoot(), ledgerId);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withMilestonesLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(MILESTONES_LOCK_KEY);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksRoot(), MILESTONES_LOCK_KEY);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  protected async withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(REGISTRY_LOCK_KEY);
    return mutex.run(async () => {
      const release = await this.lockfile.acquire(this.locksRoot(), REGISTRY_LOCK_KEY);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }

  private async withLocksInOrder<T>(ledgerIds: string[], fn: () => Promise<T>): Promise<T> {
    if (ledgerIds.length === 0) return fn();
    const [head, ...tail] = ledgerIds;
    if (head === undefined) return fn();
    return this.withLock(head, () => this.withLocksInOrder(tail, fn));
  }

  private mutexFor(key: string): AsyncMutex {
    let m = this.mutexes.get(key);
    if (m === undefined) {
      m = new AsyncMutex();
      this.mutexes.set(key, m);
    }
    return m;
  }

  protected getLedger(ledgerId: string): Ledger {
    this.assertInit();
    const l = this.ledgers.get(ledgerId);
    if (l === undefined) throw new LedgerNotFoundError(ledgerId);
    return l;
  }

  protected async writeLedgerFile(ledger: Ledger): Promise<void> {
    await this.persistence.writeLedgerSource(ledger.id, serializeLedger(ledger));
  }

  protected async writeRegistry(): Promise<void> {
    await this.persistence.writeRegistrySource(serializeRegistry(this.registry));
  }

  protected assertInit(): void {
    if (!this.initialised) throw new LedgerError("LedgerStore not initialised");
  }
}

// ---------------------------------------------------------------------------
// Helpers (shared, persistence-agnostic)
// ---------------------------------------------------------------------------

export function freshLedger(name: string, schema: LedgerSchema): Ledger {
  return {
    id: name,
    schema,
    counters: { milestone: 0, item: 0 },
    milestones: [],
    archivePointers: [],
  };
}

/** Every active item across a ledger's milestone-groups (FTS active docs). */
export function activeItemsOf(ledger: Ledger): Item[] {
  const out: Item[] = [];
  for (const m of ledger.milestones) for (const it of m.items) out.push(it);
  return out;
}

export function seedBootstrapGroup(ledger: Ledger): void {
  ledger.milestones.push({
    id: MILESTONES_ACTIVE_GROUP_ID,
    title: MILESTONES_ACTIVE_GROUP_TITLE,
    description: "",
    items: [],
  });
}

export function cloneItem(i: Item): Item {
  const out: Item = {
    id: i.id,
    milestoneId: i.milestoneId,
    status: i.status,
    fields: cloneFields(i.fields),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
  if (i.author !== undefined) out.author = i.author;
  if (i.session !== undefined) out.session = i.session;
  return out;
}

function cloneFields(
  f: Record<string, import("../types.js").FieldValue>,
): Record<string, import("../types.js").FieldValue> {
  const out: Record<string, import("../types.js").FieldValue> = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

function cloneMap<K, V>(source: ReadonlyMap<K, V>): Map<K, V> {
  return new Map(
    [...source.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as V]),
  );
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

// Suppress unused-import diagnostic: `Milestone` is referenced via the
// `ArchiveContent` discriminated union and indirectly via parser types.
type _MilestoneAlias = Milestone;
void (null as _MilestoneAlias | null);
