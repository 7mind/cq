/**
 * InMemoryLedgerStore — hand-written dummy adapter used by the dual-tests
 * pattern. Persistence is a Map; archived milestone-groups + milestone-items
 * live in sibling Maps. No locks, no I/O.
 *
 * Concurrency: uses the same per-ledger AsyncMutex discipline as the real
 * adapter so tests that exercise concurrency behave the same way. The
 * `__milestones__` global mutex is mirrored here as well.
 */

import type { ArchivePointer, Item, Ledger, LedgerSchema, Milestone } from "../types.js";
import {
  BootstrapViolationError,
  DuplicateIdError,
  LedgerError,
  LedgerNotFoundError,
} from "../types.js";
import {
  applyCreateItem,
  applyCreateMilestoneItem,
  applyDetachMilestoneGroup,
  applyDetachMilestoneItem,
  applyEnsureAmbientMilestone,
  applyReattachItem,
  applyReopenItem,
  applyUpdateItem,
  collectNonTerminalChildren,
  validateMilestoneItemPatch,
  applyUpdateMilestoneItem,
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
import { buildPrefixRegistry, normalizeStoredRefFields } from "../refs.js";
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
import type { LedgerSnapshot } from "../snapshot.js";
import { buildSnapshot } from "../snapshot.js";
import { LedgerSearchIndex } from "../search/LedgerSearchIndex.js";
import type { FetchedLedger, FetchedMilestoneGroup, ResolvedMilestone } from "../types.js";
import { AsyncMutex } from "./mutex.js";
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

export interface InMemoryLedgerStoreOpts {
  /** Returns an ISO 8601 UTC timestamp. Defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Pre-populate registered ledgers (the milestones ledger is added automatically on init). */
  seed?: Array<{ name: string; schema: LedgerSchema }>;
  /**
   * Same contract as `FsLedgerStoreOpts.onMutation`. Provided here so
   * the dual-tests abstract suite can exercise the hook against both
   * adapters uniformly. Fires AFTER every successful write.
   */
  onMutation?: OnMutation;
  /** Test-only hook reached after the decisive plan-serialization lock is held. */
  planSerializationBoundaryHook?: PlanLifecycleSerializationBoundaryHook;
}

/** Lock key for the global milestones mutex. */
const MILESTONES_MUTEX_KEY = "__milestones__";

export class InMemoryLedgerStore implements LedgerStore, PlanLifecycleStore {
  private readonly ledgers = new Map<string, Ledger>();
  private readonly archives = new Map<string, Milestone>(); // key: `<ledger>/<id>` (groups)
  private readonly itemArchives = new Map<string, Item>(); // key: `milestones/<id>` (items)
  private readonly mutexes = new Map<string, AsyncMutex>();
  private readonly now: () => string;
  private readonly onMutation: OnMutation | null;
  private readonly planSerializationBoundaryHook: PlanLifecycleSerializationBoundaryHook | null;
  private readonly searchIndex = new LedgerSearchIndex();
  private readonly planClaims = new Map<string, PlanPrivateClaimRecord>();
  private readonly planOperations = new Map<string, InMemoryPlanOperationRecord>();
  private initialised = false;
  private readonly initialSeed: Array<{ name: string; schema: LedgerSchema }>;

  constructor(opts: InMemoryLedgerStoreOpts = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.initialSeed = opts.seed ?? [];
    this.onMutation = opts.onMutation ?? null;
    this.planSerializationBoundaryHook = opts.planSerializationBoundaryHook ?? null;
  }

  /**
   * Synchronous, non-throwing wrapper around the user hook. Errors are
   * written to stderr so the write completes — matches the FS adapter
   * semantics so the dual-tests pattern stays observationally identical.
   */
  private fireMutation(ledgerId: string, op: "create" | "update" | "archive"): void {
    // Keep the derived FTS index coherent with the write FIRST (guarded so an
    // index error never unwinds the already-committed write), then fire the
    // user hook. Archived docs only change on an `archive` op.
    this.rebuildLedgerIndexActive(ledgerId);
    if (op === "archive") this.refreshLedgerIndexArchived(ledgerId);
    if (this.onMutation === null) return;
    try {
      this.onMutation(ledgerId, op);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `InMemoryLedgerStore: onMutation hook threw for ${ledgerId} (${op}): ${msg}\n`,
      );
    }
  }

  /** Rebuild active FTS docs for a ledger from its in-memory items. Guarded. */
  private rebuildLedgerIndexActive(ledgerId: string): void {
    try {
      const ledger = this.ledgers.get(ledgerId);
      if (ledger === undefined) return;
      const items: Item[] = [];
      for (const m of ledger.milestones) for (const it of m.items) items.push(it);
      this.searchIndex.rebuildLedgerActive(ledgerId, items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `InMemoryLedgerStore: FTS active-rebuild threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  /**
   * Rebuild archived FTS docs for a ledger from the archive Maps. For the
   * milestones ledger the archived units are single milestone-ITEMs
   * (`itemArchives`); for every other ledger they are milestone-GROUPs whose
   * items are the archived items (`archives`). Guarded.
   */
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
        `InMemoryLedgerStore: FTS archived-refresh threw for ${ledgerId}: ${msg}\n`,
      );
    }
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    // Bootstrap the canonical ledgers FIRST so a seed that diverges from
    // a canonical schema, or re-declares a canonical name, is rejected.
    this.bootstrapCanonicalLedgers();
    const canonicalNames = new Set(CANONICAL_LEDGERS.map((c) => c.name));
    // Seed user-supplied ledgers (refusing any canonical name keeps the
    // bootstrap path the single source of truth for those schemas).
    for (const { name, schema } of this.initialSeed) {
      if (canonicalNames.has(name)) {
        throw new BootstrapViolationError(
          `seed includes "${name}"; that ledger is bootstrapped automatically`,
        );
      }
      this.ledgers.set(name, freshLedger(name, schema));
    }
    // G80/M245 (T553): normalize every materialized item's dependsOn/blockedBy
    // to the canonical `<ledger>:<id>` form on LOAD, the same expand-then-
    // migrate step the sqlite store runs as its v1→v2 migration — via the SAME
    // shared pure helper, resolved against the SAME full prefix registry the
    // writers use. This store has no on-disk version cell, so the pass is
    // unconditional; it is idempotent (already-canonical entries are untouched)
    // and never destroys data (an unresolvable entry survives verbatim). Live
    // writes already arrive canonical through the T551 write gate, so this is
    // the load-time counterpart that keeps directly-materialized state settled.
    this.normalizeStoredRefs();
    this.initialised = true;
    // Build the FTS index for every ledger present after bootstrap + seed.
    for (const name of this.ledgers.keys()) {
      this.rebuildLedgerIndexActive(name);
      this.refreshLedgerIndexArchived(name);
    }
  }

  /**
   * Load-time dependency-ref normalization (T553): rewrite each materialized
   * item's `dependsOn`/`blockedBy` in place to the canonical `<ledger>:<id>`
   * form. Shared with the sqlite v1→v2 migration and the restore importer via
   * {@link normalizeStoredRefFields}; the registry spans every registered
   * ledger so a bare "T1" resolves to `tasks:T1` regardless of the owning
   * ledger.
   */
  private normalizeStoredRefs(): void {
    const registry = buildPrefixRegistry(
      [...this.ledgers].map(([name, l]) => ({ name, schema: l.schema })),
    );
    for (const ledger of this.ledgers.values()) {
      for (const milestone of ledger.milestones) {
        for (const item of milestone.items) {
          item.fields = normalizeStoredRefFields(item.fields, registry).fields;
        }
      }
    }
  }

  private readonly mcpUsage = new UsageTracker();

  /** I20/G155, T1509: process-local per-project usage counters. */
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
    this.ledgers.clear();
    this.archives.clear();
    this.itemArchives.clear();
    this.planClaims.clear();
    this.planOperations.clear();
    this.mutexes.clear();
    this.initialised = false;
  }

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

  async fetchArchive(ledgerId: string, archiveId: string): Promise<ArchiveContent> {
    this.assertInit();
    if (ledgerId === MILESTONES_LEDGER) {
      const key = `${ledgerId}/${archiveId}`;
      const item = this.itemArchives.get(key);
      if (item === undefined) {
        throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
      }
      return { kind: "item", item: cloneItem(item) };
    }
    const key = `${ledgerId}/${archiveId}`;
    const m = this.archives.get(key);
    if (m === undefined) {
      throw new LedgerError(`archive ${archiveId} not found in ledger ${ledgerId}`);
    }
    return { kind: "group", milestone: cloneMilestone(m) };
  }

  /**
   * Build the cross-ledger {@link RefValidationContext} for a create/update
   * write (G80/M245). Prefix registry + active lookup from the in-memory
   * `this.ledgers`; archived existence from this store's own archive maps —
   * `itemArchives` for the milestones ledger (per-item archives) and `archives`
   * for every other ledger (archived milestone-GROUPs whose `.items` are the
   * archived items).
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
        if (ledger === MILESTONES_LEDGER) {
          if (this.itemArchives.has(`${MILESTONES_LEDGER}/${id}`)) return true;
        }
        for (const [key, group] of this.archives) {
          if (!key.startsWith(`${ledger}/`)) continue;
          for (const it of group.items) if (it.id === id) return true;
        }
        return false;
      },
    };
  }

  async updateMilestone(milestoneId: string, patch: UpdateMilestoneItemPatch): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledgerIds = [...this.ledgers.keys()].filter((id) => id !== MILESTONES_LEDGER).sort();
      return this.withLocksInOrder(ledgerIds, async () => {
        const ledger = this.getLedger(MILESTONES_LEDGER);
        const blockers = collectNonTerminalChildren(this.ledgers, milestoneId);
        return cloneItem(
          applyUpdateMilestoneItem(
            ledger,
            milestoneId,
            patch,
            this.now(),
            this.buildRefValidationContext(),
            blockers,
          ),
        );
      });
    });
    this.fireMutation(MILESTONES_LEDGER, "update");
    return item;
  }

  /**
   * Build the optional `StatusChangePrecondition` for an `updateItem`. Same
   * contract and rule wiring as `FsLedgerStore.statusChangePrecondition`,
   * evaluated against the same in-memory source of truth via the same hook so
   * the two adapters cannot drift (F2 goal-phase + D29 questions-answer).
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

  async updateItem(ledgerId: string, itemId: string, patch: UpdateItemPatch): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      // Canonical disposition (D267/T1856): validate the generic patch as
      // milestone fields and delegate to the same updateMilestone path, so
      // status, dependency-DAG, blocker diagnostics, provenance, locking,
      // hooks, and no-side-effect behavior cannot diverge.
      return this.updateMilestone(itemId, validateMilestoneItemPatch(patch));
    }
    const item = await this.withMilestonesLock(async () =>
      this.withLock(ledgerId, async () => {
        const contender = rawTaskSerializationContender(ledgerId, patch.status);
        if (contender !== null && this.planSerializationBoundaryHook !== null) {
          await this.planSerializationBoundaryHook(contender);
        }
        const ledger = this.getLedger(ledgerId);
        assertRawPlanUpdateAllowed(this, (id) => this.getLedger(id), ledgerId, ledger, itemId, patch);
        const precondition = this.statusChangePrecondition(ledgerId, ledger, itemId, patch);
        return cloneItem(
          applyUpdateItem(
            ledger,
            itemId,
            patch,
            this.now(),
            precondition,
            this.buildRefValidationContext(),
          ),
        );
      }),
    );
    this.fireMutation(ledgerId, "update");
    return item;
  }

  async createItem(ledgerId: string, milestoneId: string, init: CreateItemInit): Promise<Item> {
    if (ledgerId === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(
        `use createMilestone to add an item to the ${MILESTONES_LEDGER} ledger`,
      );
    }
    // Acquire global milestones lock first (strict-existence check
    // reads the milestones ledger), then per-ledger lock.
    const item = await this.withMilestonesLock(async () => {
      assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      return this.withLock(ledgerId, async () => {
        assertRawPlanCreateAllowed((id) => this.getLedger(id), ledgerId, init.fields);
        return cloneItem(
          applyCreateItem(
            this.getLedger(ledgerId),
            milestoneId,
            init,
            this.now(),
            this.buildRefValidationContext(),
          ),
        );
      });
    });
    this.fireMutation(ledgerId, "create");
    return item;
  }

  async createMilestone(init: CreateMilestoneItemInit): Promise<Item> {
    const item = await this.withMilestonesLock(async () => {
      const ledger = this.getLedger(MILESTONES_LEDGER);
      return cloneItem(
        applyCreateMilestoneItem(ledger, init, this.now(), this.buildRefValidationContext()),
      );
    });
    this.fireMutation(MILESTONES_LEDGER, "create");
    return item;
  }

  async createLedger(name: string, schema: LedgerSchema): Promise<FetchedLedger> {
    this.assertInit();
    if (name === MILESTONES_LEDGER) {
      throw new BootstrapViolationError(`ledger name "${MILESTONES_LEDGER}" is reserved`);
    }
    validateSchema(schema);
    if (this.ledgers.has(name)) throw new DuplicateIdError("ledger", name);
    assertPrefixUnique(
      name,
      schema,
      Array.from(this.ledgers.values(), (l) => ({ name: l.id, schema: l.schema })),
    );
    const ledger = freshLedger(name, schema);
    this.ledgers.set(name, ledger);
    const result = materialiseFetchedLedger(ledger, this.getLedger(MILESTONES_LEDGER));
    this.fireMutation(name, "create");
    return result;
  }

  async reopenItem(ledgerId: string, itemId: string, toStatus: string): Promise<Item> {
    const item = await this.withMilestonesLock(async () =>
      this.withLock(ledgerId, async () => {
        const ledger = this.getLedger(ledgerId);
        const source = findItem(ledger, itemId).item;
        if (ledgerId === GOALS_LEDGER) {
          assertManagedGoalTransitionAllowed(source, toStatus);
        }
        if (ledgerId === TASKS_LEDGER) {
          assertManagedTaskTransitionAllowed(
            this,
            (id) => this.getLedger(id),
            source,
            toStatus,
          );
        }
        // D267/T1856: resurrection respects parent liveness — a non-terminal
        // child must never reappear under an absent/archived/terminal parent.
        assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), source.milestoneId);
        return cloneItem(applyReopenItem(ledger, itemId, toStatus, this.now()));
      }),
    );
    this.fireMutation(ledgerId, "update");
    return item;
  }

  async unarchiveItem(ledgerId: string, milestoneId: string, itemId: string): Promise<Item> {
    // The milestones ledger keeps per-ITEM archive files; un-archiving a
    // milestone-item is a later concern (T146 covers MCP wrappers). Here the
    // group-keyed path covers non-milestones ledgers; the itemId path applies
    // for milestones (where milestoneId === itemId, the archive key).
    const isMilestones = ledgerId === MILESTONES_LEDGER;
    const reattached = await this.withMilestonesLock(async () =>
      this.withLock(ledgerId, async () => {
      const ledger = this.getLedger(ledgerId);
      const key = `${ledgerId}/${milestoneId}`;
      if (isMilestones) {
        const archivedItem = this.itemArchives.get(key);
        if (archivedItem === undefined || archivedItem.id !== itemId) {
          throw new LedgerError(
            `no archived item ${itemId} under milestone ${milestoneId} in ledger ${ledgerId}`,
          );
        }
        if (!new Set(ledger.schema.terminalStatuses).has(archivedItem.status)) {
          // D267/T1856: reject BEFORE re-attachment — a non-terminal item must
          // not reappear under an absent/archived/terminal parent.
          assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), archivedItem.milestoneId);
        }
        const out = applyReattachItem(ledger, archivedItem.milestoneId, archivedItem, this.now());
        this.itemArchives.delete(key);
        this.removeArchivePointer(ledger, milestoneId);
        return out;
      }
      const group = this.archives.get(key);
      if (group === undefined) {
        throw new LedgerError(
          `no archived group for milestone ${milestoneId} in ledger ${ledgerId}`,
        );
      }
      const idx = group.items.findIndex((it) => it.id === itemId);
      if (idx < 0) {
        throw new LedgerError(
          `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      if (!new Set(ledger.schema.terminalStatuses).has(group.items[idx]!.status)) {
        // D267/T1856: reject BEFORE any mutation — a non-terminal item must
        // not be re-attached under an absent/archived/terminal parent (its
        // archived status is read authoritatively in this critical section).
        assertMilestoneActive(this.getLedger(MILESTONES_LEDGER), milestoneId);
      }
      const [extracted] = group.items.splice(idx, 1);
      if (extracted === undefined) {
        throw new LedgerError(
          `archived group ${milestoneId} in ledger ${ledgerId} has no item ${itemId}`,
        );
      }
      const out = applyReattachItem(ledger, milestoneId, extracted, this.now());
      if (group.items.length === 0) {
        // Last item removed — drop the whole group archive + its pointer.
        this.archives.delete(key);
        this.removeArchivePointer(ledger, milestoneId);
      }
      // (else the rewritten group stays in `this.archives` with the
      // remaining items; the pointer is unchanged.)
      return out;
      }),
    );
    // An un-archive changes BOTH the active docs (new attached item) and the
    // archived docs (the group shrank or vanished). Refresh both.
    this.fireMutation(ledgerId, "update");
    this.refreshLedgerIndexArchived(ledgerId);
    return reattached;
  }

  async archiveMilestone(milestoneId: string, summary: string): Promise<ArchivePointer> {
    let participatingLedgers: string[] = [];
    const ptr = await this.withMilestonesLock(async () => {
      // Acquire every per-ledger lock in alphabetic order so we never
      // race a concurrent updateItem on a participating ledger.
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
    for (const id of participatingLedgers) this.fireMutation(id, "archive");
    this.fireMutation(MILESTONES_LEDGER, "archive");
    return ptr;
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

  /**
   * In-memory adapter is the source of truth — there is no other
   * writer for `invalidate` to consult. Provided so the interface
   * shape is uniform with `FsLedgerStore` and the dual-tests suite
   * can assert the no-op contract.
   */
  async invalidate(_ledgerId: string): Promise<void> {}

  // --- internals ---

  private planLifecycleState(): InMemoryPlanLifecycleState {
    return {
      ledgers: this.ledgers,
      claims: this.planClaims,
      operations: this.planOperations,
      now: this.now,
    };
  }

  private async runPlanLifecycleMutation<T>(
    mutate: (state: InMemoryPlanLifecycleState) => { result: T; dirtyLedgers: readonly string[] },
    contender: PlanLifecycleSerializationContender | null,
  ): Promise<T> {
    this.assertInit();
    const ledgerIds = [...this.ledgers.keys()].filter((id) => id !== MILESTONES_LEDGER).sort();
    const mutation = await this.withMilestonesLock(() =>
      this.withLocksInOrder(ledgerIds, async () => {
        if (contender !== null && this.planSerializationBoundaryHook !== null) {
          await this.planSerializationBoundaryHook(contender);
        }
        const beforeLedgers = cloneLedgerMap(this.ledgers);
        const beforeClaims = cloneMap(this.planClaims);
        const beforeOperations = cloneMap(this.planOperations);
        try {
          return mutate(this.planLifecycleState());
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

  private bootstrapCanonicalLedgers(): void {
    for (const { name, schema } of CANONICAL_LEDGERS) {
      if (this.ledgers.has(name)) continue;
      const ledger = freshLedger(name, schema);
      if (name === MILESTONES_LEDGER) {
        ledger.milestones.push({
          id: MILESTONES_ACTIVE_GROUP_ID,
          title: MILESTONES_ACTIVE_GROUP_TITLE,
          description: "",
          items: [],
        });
        // Bootstrap the immortal M-AMBIENT milestone (§8b).
        applyEnsureAmbientMilestone(ledger, this.now());
      }
      this.ledgers.set(name, ledger);
    }
  }

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

  private performArchive(milestoneId: string, summary: string): ArchivePointer {
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
    // Phase 1: verify no non-terminal items in ANY ledger.
    for (const [name, ledger] of this.ledgers) {
      if (name === MILESTONES_LEDGER) continue;
      const group = ledger.milestones.find((m) => m.id === milestoneId);
      if (group === undefined) continue;
      const terminal = new Set(ledger.schema.terminalStatuses);
      const offending = group.items.filter((it) => !terminal.has(it.status));
      if (offending.length > 0) {
        // Throw via applyDetachMilestoneGroup so the error type matches
        // the real adapter path.
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
    // Phase 1b — verify the milestone-item itself is terminal. Must run before
    // any Phase 2 mutations so a non-terminal item causes a clean throw with no
    // partial state. Mirror the FsLedgerStore path: surface via
    // applyDetachMilestoneItem so the error type matches; the function throws
    // before any mutation when the item is absent or non-terminal.
    const milestonesLedger = this.getLedger(MILESTONES_LEDGER);
    const activeGroup = milestonesLedger.milestones.find(
      (m) => m.id === MILESTONES_ACTIVE_GROUP_ID,
    );
    const milestoneItem = activeGroup?.items.find((it) => it.id === milestoneId);
    if (milestoneItem === undefined) {
      // Throws MilestoneItemNotFoundError before any mutation.
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
        // Throws NonTerminalItemsError before any mutation.
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
    const msTitle =
      typeof milestoneItem?.fields["title"] === "string" ? milestoneItem.fields["title"] : "";
    const msStatus = milestoneItem?.status ?? "";
    // Phase 2: archive each non-milestones ledger that has a group.
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
      this.archives.set(`${name}/${milestoneId}`, milestone);
    }
    // Phase 3: archive the milestone-item itself.
    const relPath = `./archive/${MILESTONES_LEDGER}/${milestoneId}.md`;
    const { item, pointer } = applyDetachMilestoneItem(
      milestonesLedger,
      milestoneId,
      summary,
      relPath,
      msTitle,
      msStatus,
    );
    this.itemArchives.set(`${MILESTONES_LEDGER}/${milestoneId}`, item);
    return { ...pointer };
  }

  private async withLock<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ledgers.has(ledgerId)) throw new LedgerNotFoundError(ledgerId);
    const mutex = this.mutexFor(ledgerId);
    return mutex.run(fn);
  }
  private async withMilestonesLock<T>(fn: () => Promise<T>): Promise<T> {
    const mutex = this.mutexFor(MILESTONES_MUTEX_KEY);
    return mutex.run(fn);
  }
  private async withLocksInOrder<T>(ledgerIds: string[], fn: () => Promise<T>): Promise<T> {
    // Recurse so each lock is held for the duration of all inner work.
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
  private getLedger(ledgerId: string): Ledger {
    this.assertInit();
    const l = this.ledgers.get(ledgerId);
    if (l === undefined) throw new LedgerNotFoundError(ledgerId);
    return l;
  }
  private assertInit(): void {
    if (!this.initialised) throw new LedgerError("InMemoryLedgerStore not initialised");
  }
}

// --- shared materialiser + clone helpers ---

export function materialiseFetchedLedger(ledger: Ledger, milestonesLedger: Ledger): FetchedLedger {
  const groups: FetchedMilestoneGroup[] = ledger.milestones.map((m) => {
    let resolved: ResolvedMilestone;
    if (ledger.id === MILESTONES_LEDGER) {
      // Self-resolution: the active group itself doesn't correspond
      // to a milestone-item; expose a sentinel view so callers can rely
      // on the field always being populated.
      resolved = {
        id: m.id,
        status: "open",
        title: m.title,
        description: m.description,
      };
    } else {
      const view = resolveMilestoneViewSafe(milestonesLedger, m.id);
      // If the milestone is missing (e.g. archived, or running before
      // bootstrap), surface an empty view so the caller can still render
      // the group. Errors here would hide the broken state from the UI.
      resolved = view ?? {
          id: m.id,
          status: "unknown",
          title: "",
          description: "",
        };
    }
    return { id: m.id, milestone: resolved, items: m.items.map(cloneItem) };
  });
  return {
    id: ledger.id,
    schema: cloneSchema(ledger.schema),
    counters: { ...ledger.counters },
    milestones: groups,
    archivePointers: ledger.archivePointers.map((p) => ({ ...p })),
  };
}

function resolveMilestoneViewSafe(
  milestonesLedger: Ledger,
  milestoneId: string,
): ResolvedMilestone | null {
  return resolveMilestoneView(milestonesLedger, milestoneId);
}

function freshLedger(name: string, schema: LedgerSchema): Ledger {
  return {
    id: name,
    schema,
    counters: { milestone: 0, item: 0 },
    milestones: [],
    archivePointers: [],
  };
}

function cloneSchema(s: LedgerSchema): LedgerSchema {
  const out: LedgerSchema = {
    statusValues: [...s.statusValues],
    terminalStatuses: [...s.terminalStatuses],
    fields: Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, { ...v }])),
  };
  if (s.idPrefix !== undefined) out.idPrefix = s.idPrefix;
  if (s.transitions !== undefined) {
    out.transitions = Object.fromEntries(
      Object.entries(s.transitions).map(([from, tos]) => [from, [...tos]]),
    );
  }
  if (s.satisfiesDependencyStatuses !== undefined) {
    out.satisfiesDependencyStatuses = [...s.satisfiesDependencyStatuses];
  }
  return out;
}

function cloneMilestone(m: Milestone): Milestone {
  return { id: m.id, title: m.title, description: m.description, items: m.items.map(cloneItem) };
}

function cloneLedger(ledger: Ledger): Ledger {
  return {
    id: ledger.id,
    schema: cloneSchema(ledger.schema),
    counters: { ...ledger.counters },
    milestones: ledger.milestones.map(cloneMilestone),
    archivePointers: ledger.archivePointers.map((pointer) => ({ ...pointer })),
  };
}

function cloneLedgerMap(source: ReadonlyMap<string, Ledger>): Map<string, Ledger> {
  return new Map([...source].map(([key, value]) => [key, cloneLedger(value)]));
}

function cloneMap<T>(source: ReadonlyMap<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as T]));
}

function replaceMap<T>(target: Map<string, T>, replacement: ReadonlyMap<string, T>): void {
  target.clear();
  for (const [key, value] of replacement) target.set(key, value);
}

/** Deep-clone an Item (exported for SqliteLedgerStore, whose K102 module
 * graph must not reach AbstractLedgerStore's parser imports). */
export function cloneItem(i: Item): Item {
  const out: Item = {
    id: i.id,
    milestoneId: i.milestoneId,
    status: i.status,
    fields: Object.fromEntries(
      Object.entries(i.fields).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
    ) as Item["fields"],
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
  if (i.author !== undefined) out.author = i.author;
  if (i.session !== undefined) out.session = i.session;
  return out;
}
