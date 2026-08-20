/**
 * T1975 — Postgres leg of the T1961 guarded generic-mutation gateway.
 *
 * Wires {@link createWorksetGuardedLedger} over {@link PostgresLedgerStore} +
 * {@link createPostgresWorksetStore} with closed-graph target admission so
 * durable ledger mutations share the same public surface and restrictive-root
 * policy as the in-memory dummy. Raw SQL helpers stay internal to the adapters;
 * the public type never exposes raw LedgerStore writes.
 *
 * Each ordinary graph/eligibility mutation still flows through the ledger-layer
 * gateway: admit (`generic-write`) → resolve targets/epoch → validate → apply
 * the tenant-scoped Postgres write transaction → fire `onMutation` after commit
 * → acknowledge admission. Replacement (`setRoots`) serializes
 * behind live admissions via the durable workset store.
 */

import type { SQL } from "bun";
import {
  buildActiveStateFromLedgerStore,
  createWorksetGuardedLedger,
  worksetMemberRefSet,
  type WorksetGuardedLedger,
} from "../../worksetGenericMutation.js";
import { closeWorkset } from "../../worksetGraph.js";
import type { WorksetAdmissionCoordinatorHooks } from "../../worksetEffectAdmission.js";
import {
  createTrustedWorksetManagementAuthority,
  type WorksetInvocationAuthority,
} from "../../worksetInvocationAuthority.js";
import type { OnMutation } from "../LedgerStore.js";
import { PostgresLedgerStore } from "./PostgresLedgerStore.js";
import {
  createPostgresWorksetStore,
  type PostgresWorksetStore,
} from "./worksetStore.js";

export interface CreatePostgresWorksetGuardedLedgerOptions {
  /** Shared Bun.sql pool (schema already applied via {@link ensureSchema}). */
  readonly pool: SQL;
  /** Tenant key — every ledger + workset row is scoped to this project_key. */
  readonly projectKey: string;
  /**
   * Display name UPSERTed on `init()`. Defaults to `projectKey` when omitted
   * (test tenants typically pass the same synthetic key for both).
   */
  readonly displayName?: string;
  readonly now?: () => string;
  readonly onMutation?: OnMutation;
  readonly hooks?: WorksetAdmissionCoordinatorHooks;
  /**
   * Test latch: runs after admit and before validation/write while the
   * ledger-mutation admission is still held (set∥mutation linearization).
   */
  readonly afterGenericAdmit?: () => Promise<void> | void;
  readonly invocationAuthority?: WorksetInvocationAuthority;
  /**
   * Extra durable-workset options forwarded to {@link createPostgresWorksetStore}
   * (fault injection: heartbeat, holder liveness, host id).
   */
  readonly workset?: {
    readonly hostId?: string;
    readonly heartbeatTtlMs?: number;
    readonly now?: () => number;
    readonly isHolderAlive?: (
      identity: {
        readonly pid: number;
        readonly startTime: string;
      },
      hostId: string,
    ) => Promise<boolean>;
  };
}

/**
 * Build a public {@link WorksetGuardedLedger} over a fresh
 * {@link PostgresLedgerStore} + tenant-scoped durable workset store.
 *
 * Awaits {@link PostgresLedgerStore.init} BEFORE constructing the durable
 * workset store: `createPostgresWorksetStore` eagerly ensures a
 * `workset_roots` row (`void readRoots()`), which is FK-scoped to
 * `projects(project_key)`. Init UPSERTs that parent row (and seeds canonical
 * ledgers). A subsequent `ledger.init()` from callers is a no-op.
 *
 * Caller owns lifecycle teardown via `await ledger.dispose()` (closes the
 * workset store and the ledger's pool).
 */
export async function createPostgresWorksetGuardedLedger(
  options: CreatePostgresWorksetGuardedLedgerOptions,
): Promise<WorksetGuardedLedger> {
  const projectKey = options.projectKey;
  if (projectKey.trim() === "") {
    throw new Error("createPostgresWorksetGuardedLedger: projectKey must not be blank");
  }
  const displayName = options.displayName ?? projectKey;

  const rawStore = new PostgresLedgerStore({
    pool: options.pool,
    projectKey,
    displayName,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onMutation !== undefined ? { onMutation: options.onMutation } : {}),
  });
  // Parent `projects` row must exist before the workset store's eager roots
  // ensure (FK workset_roots_project_key_fkey).
  await rawStore.init();

  const worksetOpts = options.workset;
  const worksetStore: PostgresWorksetStore = createPostgresWorksetStore({
    pool: options.pool,
    projectKey,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    ...(worksetOpts?.hostId !== undefined ? { hostId: worksetOpts.hostId } : {}),
    ...(worksetOpts?.heartbeatTtlMs !== undefined
      ? { heartbeatTtlMs: worksetOpts.heartbeatTtlMs }
      : {}),
    ...(worksetOpts?.now !== undefined ? { now: worksetOpts.now } : {}),
    ...(worksetOpts?.isHolderAlive !== undefined
      ? { isHolderAlive: worksetOpts.isHolderAlive }
      : {}),
    isTargetAdmitted: (target, roots) => {
      if (roots.length === 0) return true;
      try {
        const state = buildActiveStateFromLedgerStore(rawStore);
        const graph = closeWorkset(roots, state);
        if (worksetMemberRefSet(graph).has(target)) return true;
        if (graph.inactiveRoots.includes(target)) return true;
        return false;
      } catch {
        // Uninitialised store or malformed roots — fail closed.
        return false;
      }
    },
  });

  const surface = createWorksetGuardedLedger({
    rawStore,
    worksetStore,
    runGenericTransaction: (mutate) => rawStore.runAtomicGenericMutation(mutate),
    ...(options.invocationAuthority !== undefined
      ? { invocationAuthority: options.invocationAuthority }
      : {}),
    ...(options.afterGenericAdmit !== undefined
      ? { afterGenericAdmit: options.afterGenericAdmit }
      : {}),
  });

  // The ledger store's lazy worksetStore() is a SEPARATE instance without
  // closed-graph admission; dispose must close THIS workset first, then the
  // store (which closes its own pool). Idempotent so test afterEach can always
  // tear down even when a case already disposed mid-body (restart fixtures).
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    worksetStore.close();
    await rawStore.dispose();
  };

  return {
    init: () => surface.init(),
    enumerate: () => surface.enumerate(),
    fetch: (id) => surface.fetch(id),
    fetchArchive: (ledgerId, archiveId) => surface.fetchArchive(ledgerId, archiveId),
    fetchItem: (ledgerId, itemId) => surface.fetchItem(ledgerId, itemId),
    fetchMilestone: (milestoneId) => surface.fetchMilestone(milestoneId),
    search: (ledgerId, query) => surface.search(ledgerId, query),
    ftsSearch: (query, opts) => surface.ftsSearch(query, opts),
    listMilestoneItems: (milestoneId) => surface.listMilestoneItems(milestoneId),
    snapshot: () => surface.snapshot(),
    invalidate: (ledgerId) => surface.invalidate(ledgerId),
    recordMcpUsage: (endpoint, bytesIn, bytesOut) =>
      surface.recordMcpUsage(endpoint, bytesIn, bytesOut),
    fetchMcpUsageStats: () => surface.fetchMcpUsageStats(),
    dispose,
    mutations: surface.mutations,
    setRoots: (roots) => surface.setRoots(roots),
    snapshotRoots: () => surface.snapshotRoots(),
    activeAdmissionCount: () => surface.activeAdmissionCount(),
  };
}

/** PostgreSQL trusted-host management surface for direct administration and contracts. */
export async function createPostgresWorksetManagementLedger(
  options: Omit<CreatePostgresWorksetGuardedLedgerOptions, "invocationAuthority">,
): Promise<WorksetGuardedLedger> {
  return createPostgresWorksetGuardedLedger({
    ...options,
    invocationAuthority: createTrustedWorksetManagementAuthority(),
  });
}
