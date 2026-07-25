/**
 * Postgres-SPECIFIC plan-lifecycle guarantees (T851) — the claims the shared
 * `planLifecycleStoreContract` cannot make, because each is about how THIS
 * backend reaches its answer rather than what the answer is:
 *
 *  1. The fence reads LIVE rows, never the instance's materialized cache. This
 *     backend is the only one whose reads are served from a cache a peer's
 *     committed write can silently invalidate, so it is the only one where the
 *     staleness defect recorded against the fs/git path (D141) has a genuine
 *     analogue.
 *  2. Whatever the fence reads live, it publishes to all THREE cache-backed
 *     read surfaces — the active cache, the archive maps behind `fetchArchive`,
 *     and both search-index buckets — for every ledger it absorbed, so no two
 *     reads of one instance can contradict each other. Because the live read is
 *     several statements at READ COMMITTED, absorption also has to be
 *     self-consistent when a peer commits BETWEEN two of them: it publishes
 *     archive content only for pointers the snapshot it absorbed advertises, so
 *     an interleaved archive is absorbed whole on a later refresh or not at all.
 *  3. `reopenItem` is fenced too — a separate write path from `updateItem`, and
 *     one a backend can plausibly leave unguarded.
 *  4. The whole mutation is ATOMIC, shown two complementary ways: a failure
 *     injected at EVERY statement boundary of a finalize transaction leaves no
 *     partial row behind, and the rows the mutation writes share one `xmin`,
 *     i.e. one transaction produced them. The second is not redundant — see
 *     {@link injectingPool} for the case the walk alone cannot see.
 *  5. No owner fence TOKEN is ever persisted — asserted by reading the rows,
 *     not by reading a projection of them.
 *
 * Env-gated on CQ_TEST_PG_URL (Q286).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import {
  DECISIONS_LEDGER,
  GOALS_LEDGER,
  HYPOTHESIS_LEDGER,
  MILESTONES_AMBIENT_ID,
  MILESTONES_LEDGER,
  PLAN_FINALIZED_MANIFEST_FIELD,
  PLAN_GENERATION_FIELD,
  PLAN_REVIEW_DRAFT_FIELD,
  REVIEWS_LEDGER,
  TASKS_LEDGER,
  ensureSchema,
  openPgPool,
  PostgresLedgerStore,
  type PlanClaimAcknowledgement,
  type PlanDraftManifest,
  type PlanFinalizeInput,
  type PlanLifecycleStore,
} from "../src/index.js";
import {
  cloneTenant,
  dropTenant,
  openTenantStore,
  postgresTestDsn,
  T851_PROJECT_KEY_PREFIX,
} from "./planLifecyclePostgresAdapter.js";

const PG_URL = process.env.CQ_TEST_PG_URL;

const GOAL_ID = "G1";
/** A token no fixture text contains, so an FTS hit for it is unambiguous. */
const FTS_MARKER = "zqxjkw";
const OWNER_TOKEN = "A".repeat(22);
const PROVENANCE = { author: "t851", session: "t851-session" } as const;
const INJECTED = "t851 injected mid-transaction failure";

const MANIFEST = {
  milestones: [{ key: "delivery", title: "Deliver the fence" }],
  tasks: [
    { key: "first", milestoneKey: "delivery", headline: "First task" },
    {
      key: "second",
      milestoneKey: "delivery",
      headline: "Second task",
      dependsOn: [{ kind: "draft-task", key: "first" }],
    },
  ],
} as const satisfies PlanDraftManifest;

type LifecycleStore = PostgresLedgerStore & PlanLifecycleStore;

/** Everything one test owns, torn down by {@link Harness.dispose}. */
class Harness {
  readonly stores: LifecycleStore[] = [];
  readonly tenants: string[] = [];

  constructor(
    readonly dsn: string,
    readonly admin: SQL,
    readonly projectKey: string,
  ) {
    this.tenants.push(projectKey);
  }

  static async create(): Promise<Harness> {
    const dsn = postgresTestDsn();
    const admin = openPgPool(dsn);
    await ensureSchema(admin);
    return new Harness(dsn, admin, `${T851_PROJECT_KEY_PREFIX}${randomUUID()}`);
  }

  async open(): Promise<LifecycleStore> {
    const store = await openTenantStore(this.dsn, this.projectKey);
    this.stores.push(store);
    return store;
  }

  /** Open a store whose pool can be told to fail the Nth statement of a transaction. */
  async openInjecting(): Promise<{ store: LifecycleStore; injector: Injector }> {
    const { pool, injector } = injectingPool(this.dsn);
    await ensureSchema(pool);
    const store = new PostgresLedgerStore({
      pool,
      projectKey: this.projectKey,
      displayName: this.projectKey,
    });
    await store.init();
    this.stores.push(store as LifecycleStore);
    return { store: store as LifecycleStore, injector };
  }

  /**
   * Open a store whose pool runs `hook` ONCE, right after the first
   * transaction statement whose SQL contains `marker` — a deterministic way to
   * land a peer's commit BETWEEN two reads of the same transaction.
   */
  async openInterleaving(marker: string, hook: () => Promise<void>): Promise<LifecycleStore> {
    const pool = interleavingPool(this.dsn, marker, hook);
    await ensureSchema(pool);
    const store = new PostgresLedgerStore({
      pool,
      projectKey: this.projectKey,
      displayName: this.projectKey,
    });
    await store.init();
    this.stores.push(store as LifecycleStore);
    return store as LifecycleStore;
  }

  track(tenant: string): void {
    this.tenants.push(tenant);
  }

  async dispose(): Promise<void> {
    for (const store of this.stores.splice(0)) {
      try {
        await store.dispose();
      } catch {
        // a store whose injected failure closed its pool is already gone
      }
    }
    for (const tenant of this.tenants.splice(0)) await dropTenant(this.admin, tenant);
    await this.admin.close();
  }
}

interface Injector {
  /** Throw on the `nth` statement issued inside a transaction (1-based). */
  armAt(nth: number): void;
  disarm(): void;
}

/**
 * A pool that fails the Nth statement issued while armed.
 *
 * BOTH the transaction handle and the pool itself are counted, so a statement
 * issued OFF the transaction still advances the counter and can still be the
 * one that fails.
 *
 * What the walk proves: for every injection index, the failure it causes leaves
 * NO partial effect — no decision row, no finalized goal, no replay record.
 *
 * What the walk does NOT prove — measured, not assumed (review r1): that each
 * individual write is on the transaction. The `plan_operations` upsert in
 * `persistPlanRecords` is the LAST statement inside the finalize transaction,
 * so moving it to `this.pool()` (a separate connection, committing on its own)
 * leaves this entire suite green: no injection index falls between that write
 * and the COMMIT, so the walk never gets to observe the torn state. The same
 * mutation on the `plan_claims` branch IS caught — statements follow it — so
 * this is a specific gap in the technique's coverage, not a general limit of
 * it. Connection identity is asserted directly instead, by the `xmin` test:
 * rows written by one transaction share one `xmin`, and the off-transaction
 * mutation above makes that test fail (verified).
 */
function injectingPool(dsn: string): { pool: SQL; injector: Injector } {
  const real = openPgPool(dsn);
  let failAt: number | null = null;
  let seen = 0;

  const countOrThrow = (): void => {
    if (failAt === null) return;
    seen += 1;
    if (seen === failAt) throw new Error(INJECTED);
  };

  const counting = (handle: SQL): SQL =>
    new Proxy(handle as unknown as (...args: unknown[]) => unknown, {
      apply(target, thisArg, args: unknown[]): unknown {
        countOrThrow();
        return Reflect.apply(target, thisArg, args);
      },
      get(target, prop, receiver): unknown {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as SQL;

  const pool = new Proxy(real as unknown as (...args: unknown[]) => unknown, {
    apply(target, thisArg, args: unknown[]): unknown {
      countOrThrow();
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver): unknown {
      if (prop === "begin") {
        return (fn: (tx: SQL) => Promise<unknown>): unknown =>
          (target as unknown as SQL).begin((tx) => fn(counting(tx as unknown as SQL)));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as SQL;

  return {
    pool,
    injector: {
      armAt(nth: number): void {
        failAt = nth;
        seen = 0;
      },
      disarm(): void {
        failAt = null;
      },
    },
  };
}

/**
 * A pool that lets another party commit BETWEEN two statements of one
 * transaction.
 *
 * A write transaction runs at READ COMMITTED, so each statement takes its own
 * snapshot and a multi-statement read is not atomic against peers. This wrapper
 * makes that window deterministic instead of racy: the FIRST transaction
 * statement whose SQL text contains `marker` is issued, awaited, and then
 * `hook` runs to completion before the caller is resumed.
 */
function interleavingPool(dsn: string, marker: string, hook: () => Promise<void>): SQL {
  const real = openPgPool(dsn);
  let fired = false;

  const sqlTextOf = (args: readonly unknown[]): string => {
    const [strings] = args;
    return Array.isArray(strings) ? (strings as readonly string[]).join(" ") : "";
  };

  const interleaving = (handle: SQL): SQL =>
    new Proxy(handle as unknown as (...args: unknown[]) => unknown, {
      apply(target, thisArg, args: unknown[]): unknown {
        const result = Reflect.apply(target, thisArg, args);
        if (fired || !sqlTextOf(args).includes(marker)) return result;
        fired = true;
        return (async (): Promise<unknown> => {
          const rows: unknown = await result;
          await hook();
          return rows;
        })();
      },
      get(target, prop, receiver): unknown {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as SQL;

  return new Proxy(real as unknown as (...args: unknown[]) => unknown, {
    get(target, prop, receiver): unknown {
      if (prop === "begin") {
        return (fn: (tx: SQL) => Promise<unknown>): unknown =>
          (target as unknown as SQL).begin((tx) => fn(interleaving(tx as unknown as SQL)));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as SQL;
}

function verifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Dispatch `op` a few milliseconds late, so the other racer reaches its lock first. */
async function delayed<T>(op: () => Promise<T>): Promise<T> {
  await Bun.sleep(5);
  return op();
}

async function seedGoal(store: LifecycleStore, goalId: string): Promise<void> {
  await store.createItem(GOALS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: goalId,
    status: "clarifying",
    fields: { title: `goal ${goalId}`, description: "T851 fence coverage" },
    ...PROVENANCE,
  });
}

/**
 * Create a hypothesis milestone holding ONE item on `store` and drive both
 * terminal, i.e. leave it ARCHIVABLE — on a ledger no plan fence ever mutates.
 */
async function seedArchivableHypothesisMilestone(
  store: LifecycleStore,
  itemId: string,
  headline: string,
): Promise<string> {
  const milestone = await store.createMilestone({
    title: `archived elsewhere (${itemId})`,
    ...PROVENANCE,
  });
  await store.createItem(HYPOTHESIS_LEDGER, milestone.id, {
    id: itemId,
    status: "open",
    fields: { headline },
    ...PROVENANCE,
  });
  await store.updateItem(HYPOTHESIS_LEDGER, itemId, { status: "confirmed", ...PROVENANCE });
  await store.updateMilestone(milestone.id, { status: "done", ...PROVENANCE });
  return milestone.id;
}

/** …and archive it: an `archive_pointers` row plus the `archived_items` rows behind it. */
async function archiveHypothesisMilestone(
  store: LifecycleStore,
  itemId: string,
  headline: string,
): Promise<string> {
  const milestoneId = await seedArchivableHypothesisMilestone(store, itemId, headline);
  await store.archiveMilestone(milestoneId, `peer archived ${milestoneId}`);
  return milestoneId;
}

async function claim(store: LifecycleStore, requestId: string): Promise<PlanClaimAcknowledgement> {
  const result = await store.claimPlan({
    goalId: GOAL_ID,
    purpose: "initial",
    claimRequestId: requestId,
    ownerFenceToken: OWNER_TOKEN,
    expectedGeneration: null,
    ...PROVENANCE,
  });
  if (!result.ok) throw new Error(`claim conflicted: ${result.conflict.code}`);
  return result.acknowledgement;
}

/**
 * Drive a goal all the way to `planned` with a two-task finalized manifest,
 * leaving the fixture at the point where the acceptance's interesting races
 * (raw task-start vs follow-up replacement) become possible.
 */
async function driveToFinalized(
  store: LifecycleStore,
  reviewId: string,
): Promise<{ taskIds: string[] }> {
  const acknowledgement = await claim(store, `claim-${reviewId}`);
  const published = await store.publishPlanDraft({
    goalId: GOAL_ID,
    claimId: acknowledgement.claimId,
    generation: acknowledgement.generation,
    operationId: `publish-${reviewId}`,
    ownerFenceToken: acknowledgement.ownerFenceToken,
    ...PROVENANCE,
    manifest: MANIFEST,
  });
  if (!published.ok) throw new Error(`publish conflicted: ${published.conflict.code}`);
  const draft = {
    goalId: GOAL_ID,
    claimId: acknowledgement.claimId,
    generation: acknowledgement.generation,
    revision: published.acknowledgement.manifest.revision,
  };
  await store.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
    id: reviewId,
    status: "go-ahead",
    fields: {
      [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify(draft),
      ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`],
    },
    ...PROVENANCE,
  });
  const finalized = await store.finalizePlan(finalizeInput(acknowledgement, reviewId, draft.revision));
  if (!finalized.ok) throw new Error(`finalize conflicted: ${finalized.conflict.code}`);
  return { taskIds: finalized.acknowledgement.manifest.tasks.map(({ id }) => id) };
}

function finalizeInput(
  acknowledgement: PlanClaimAcknowledgement,
  reviewId: string,
  draftRevision: number,
): PlanFinalizeInput {
  return {
    goalId: GOAL_ID,
    claimId: acknowledgement.claimId,
    generation: acknowledgement.generation,
    operationId: `finalize-${reviewId}`,
    ownerFenceToken: acknowledgement.ownerFenceToken,
    ...PROVENANCE,
    reviewId,
    draftRevision,
    decision: { headline: "Lock the reviewed draft" },
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;
  if (current !== null) await current.dispose();
});

async function newHarness(): Promise<Harness> {
  harness = await Harness.create();
  return harness;
}

describe.skipIf(!PG_URL)("postgres plan-lifecycle fence (T851)", () => {
  test("a guarded raw write decides from live rows, not from its own store's stale cache", async () => {
    const h = await newHarness();
    const writer = await h.open();
    const stale = await h.open();
    await seedGoal(writer, GOAL_ID);
    // `stale` observed the tenant at init and is never invalidated again, so
    // every row `writer` creates below is invisible to its cache.
    await stale.invalidate(GOALS_LEDGER);
    const { taskIds } = await driveToFinalized(writer, "R1");
    const [first, second] = taskIds;
    if (first === undefined || second === undefined) throw new Error("manifest is short");

    // The stale store cannot see either task in `this.ledgers` — proving the
    // premise of this test rather than assuming it.
    expect(() => stale.fetchItem(TASKS_LEDGER, first)).toThrow();

    // A cache-based fence would fail this with "item not found"; a live-read
    // fence starts the ready task and rejects the dependency-blocked one for
    // the RIGHT reason.
    const started = await stale.updateItem(TASKS_LEDGER, first, {
      status: "wip",
      ...PROVENANCE,
    });
    expect(started.status).toBe("wip");
    await expect(
      stale.updateItem(TASKS_LEDGER, second, { status: "wip", ...PROVENANCE }),
    ).rejects.toThrow(/dependencies/);

    const reader = await h.open();
    expect(reader.fetchItem(TASKS_LEDGER, first).status).toBe("wip");
    expect(reader.fetchItem(TASKS_LEDGER, second).status).toBe("planned");
  }, 30_000);

  test("a guarded raw write publishes EVERY absorbed ledger to the search index, not just the mutated one", async () => {
    const h = await newHarness();
    const writer = await h.open();
    await seedGoal(writer, GOAL_ID);
    const { taskIds } = await driveToFinalized(writer, "R6");
    const [first] = taskIds;
    if (first === undefined) throw new Error("manifest is short");

    // A PEER instance commits an item on a ledger `writer` never mutates and
    // never invalidates, so `writer` has it in NEITHER read surface yet.
    const peer = await h.open();
    await peer.createItem(HYPOTHESIS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "H1",
      status: "open",
      fields: { headline: `${FTS_MARKER} peculiar marker` },
      ...PROVENANCE,
    });
    expect(() => writer.fetchItem(HYPOTHESIS_LEDGER, "H1")).toThrow();
    expect(await writer.ftsSearch(FTS_MARKER)).toHaveLength(0);

    // A guarded RAW write reads every ledger live under its locks and absorbs
    // the whole map into the cache — including `hypothesis`, which it did not
    // mutate. Absorbing into the cache alone leaves the two read surfaces of
    // ONE instance contradicting each other: `fetchItem` finds H1 while
    // `ftsSearch` cannot. Absorption must publish to both.
    await writer.updateItem(TASKS_LEDGER, first, { status: "wip", ...PROVENANCE });

    expect(writer.fetchItem(HYPOTHESIS_LEDGER, "H1").status).toBe("open");
    const hits = await writer.ftsSearch(FTS_MARKER);
    expect(hits.map((hit) => hit.item.id)).toEqual(["H1"]);
  }, 30_000);

  test("a guarded raw write publishes the ARCHIVE surface too, not just the active one", async () => {
    const h = await newHarness();
    const writer = await h.open();
    await seedGoal(writer, GOAL_ID);
    const { taskIds } = await driveToFinalized(writer, "R7");
    const [first] = taskIds;
    if (first === undefined) throw new Error("manifest is short");

    // A PEER instance archives a whole milestone on a ledger `writer` never
    // mutates. That writes BOTH an `archive_pointers` row (which
    // `readActiveLedgers` reads, so absorption publishes it) and
    // `archived_items` rows (which live in `this.archives` /
    // `this.itemArchives`, the ONLY source `fetchArchive` reads).
    const peer = await h.open();
    const milestoneId = await archiveHypothesisMilestone(
      peer,
      "H1",
      `${FTS_MARKER} archived marker`,
    );

    // Premise: before the fenced write BOTH archive surfaces are stale
    // TOGETHER — no pointer, no content — which is consistent.
    expect(writer.fetch(HYPOTHESIS_LEDGER).archivePointers).toHaveLength(0);
    await expect(writer.fetchArchive(HYPOTHESIS_LEDGER, milestoneId)).rejects.toThrow(/not found/);

    // The fenced raw write absorbs every live ledger. Absorbing the pointer
    // list without the archived rows would publish a pointer whose content
    // `fetchArchive` still cannot resolve — one instance advertising an
    // archive it denies having.
    await writer.updateItem(TASKS_LEDGER, first, { status: "wip", ...PROVENANCE });

    expect(writer.fetch(HYPOTHESIS_LEDGER).archivePointers.map((p) => p.id)).toEqual([
      milestoneId,
    ]);
    const archived = await writer.fetchArchive(HYPOTHESIS_LEDGER, milestoneId);
    if (archived.kind !== "group") throw new Error("hypothesis archive must be a group");
    expect(archived.milestone.items.map((it) => it.id)).toEqual(["H1"]);

    // The detached milestone ITEM archive is the same surface, keyed under the
    // milestones ledger, and it must be repaired too.
    const milestoneArchive = await writer.fetchArchive(MILESTONES_LEDGER, milestoneId);
    if (milestoneArchive.kind !== "item") throw new Error("milestone archive must be an item");
    expect(milestoneArchive.item.id).toBe(milestoneId);

    // …and the ARCHIVED search bucket is the third read of the same rows.
    const hits = await writer.ftsSearch(FTS_MARKER, { includeArchived: true });
    expect(hits.map((hit) => hit.item.id)).toEqual(["H1"]);

    // Absorption is idempotent: a SECOND fenced write re-reads the same
    // archived rows, and must replace the archive maps rather than append to
    // them (an archive that grows a duplicate item per fenced write).
    await writer.updateItem(TASKS_LEDGER, first, { status: "done", ...PROVENANCE });
    const again = await writer.fetchArchive(HYPOTHESIS_LEDGER, milestoneId);
    if (again.kind !== "group") throw new Error("hypothesis archive must be a group");
    expect(again.milestone.items.map((it) => it.id)).toEqual(["H1"]);
    expect(await writer.ftsSearch(FTS_MARKER, { includeArchived: true })).toHaveLength(1);
  }, 30_000);

  test("absorption publishes no archive CONTENT its own pointer snapshot does not advertise", async () => {
    const h = await newHarness();
    const setup = await h.open();
    await seedGoal(setup, GOAL_ID);
    const { taskIds } = await driveToFinalized(setup, "R8");
    const [first] = taskIds;
    if (first === undefined) throw new Error("manifest is short");

    const peer = await h.open();
    const archivedId = await seedArchivableHypothesisMilestone(peer, "H2", "torn-read marker");
    let interleaved = false;

    // The fence's live read is several statements at READ COMMITTED, so it is
    // NOT atomic against peers. Land the peer's archive squarely between the
    // pointer read and the archived-row read: the item + pointer snapshots
    // pre-date the archive, the archived-row snapshot post-dates it.
    const writer = await h.openInterleaving("FROM archive_pointers", async () => {
      await peer.archiveMilestone(archivedId, "archived mid-read");
      interleaved = true;
    });
    await writer.updateItem(TASKS_LEDGER, first, { status: "wip", ...PROVENANCE });
    expect(interleaved).toBe(true);

    // Absorbing every row read would publish content for a pointer this
    // instance does not have — H2 both ACTIVE and ARCHIVED at once. Absorption
    // publishes the older, self-consistent state instead: H2 active, no
    // pointer, no content.
    expect(writer.fetchItem(HYPOTHESIS_LEDGER, "H2").status).toBe("confirmed");
    expect(writer.fetch(HYPOTHESIS_LEDGER).archivePointers).toHaveLength(0);
    await expect(writer.fetchArchive(HYPOTHESIS_LEDGER, archivedId)).rejects.toThrow(/not found/);

    // Deferred, not lost: the next refresh publishes both halves together.
    await writer.invalidate(HYPOTHESIS_LEDGER);
    expect(writer.fetch(HYPOTHESIS_LEDGER).archivePointers.map((p) => p.id)).toEqual([archivedId]);
    const archived = await writer.fetchArchive(HYPOTHESIS_LEDGER, archivedId);
    if (archived.kind !== "group") throw new Error("hypothesis archive must be a group");
    expect(archived.milestone.items.map((it) => it.id)).toEqual(["H2"]);
  }, 30_000);

  test("reopenItem is fenced: a superseded managed task cannot be resurrected raw", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    const { taskIds } = await driveToFinalized(store, "R2");
    const [first] = taskIds;
    if (first === undefined) throw new Error("manifest is short");

    // A follow-up generation abandons the planned tasks and drops them out of
    // the finalized manifest.
    const followUp = await store.claimPlan({
      goalId: GOAL_ID,
      purpose: "follow-up",
      claimRequestId: "follow-up-reopen",
      ownerFenceToken: OWNER_TOKEN,
      expectedGeneration: 1,
      ...PROVENANCE,
    });
    expect(followUp.ok).toBe(true);
    expect(store.fetchItem(TASKS_LEDGER, first).status).toBe("abandoned");

    // `reopenItem` is a DIFFERENT write path from `updateItem`. Unfenced, it
    // would happily walk this superseded task back to planned.
    await expect(store.reopenItem(TASKS_LEDGER, first, "planned")).rejects.toThrow(
      /superseded manifest/,
    );
    expect(store.fetchItem(TASKS_LEDGER, first).status).toBe("abandoned");
  }, 30_000);

  test("finalize is all-or-nothing at every statement boundary, and commits decision with goal together", async () => {
    const h = await newHarness();
    const setup = await h.open();
    await seedGoal(setup, GOAL_ID);
    const acknowledgement = await claim(setup, "atomic");
    const published = await setup.publishPlanDraft({
      goalId: GOAL_ID,
      claimId: acknowledgement.claimId,
      generation: acknowledgement.generation,
      operationId: "publish-atomic",
      ownerFenceToken: acknowledgement.ownerFenceToken,
      ...PROVENANCE,
      manifest: MANIFEST,
    });
    if (!published.ok) throw new Error("publish conflicted");
    await setup.createItem(REVIEWS_LEDGER, MILESTONES_AMBIENT_ID, {
      id: "R3",
      status: "go-ahead",
      fields: {
        [PLAN_REVIEW_DRAFT_FIELD]: JSON.stringify({
          goalId: GOAL_ID,
          claimId: acknowledgement.claimId,
          generation: acknowledgement.generation,
          revision: published.acknowledgement.manifest.revision,
        }),
        ledgerRefs: [`${GOALS_LEDGER}:${GOAL_ID}`],
      },
      ...PROVENANCE,
    });

    const { store, injector } = await h.openInjecting();
    const input = finalizeInput(acknowledgement, "R3", published.acknowledgement.manifest.revision);

    const decisionCount = async (): Promise<number> => {
      const rows = await h.admin<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM items
        WHERE project_key = ${h.projectKey} AND ledger = ${DECISIONS_LEDGER}
      `;
      return Number(rows[0]?.n ?? "0");
    };
    const goalFields = async (): Promise<Record<string, unknown>> => {
      const rows = await h.admin<Array<{ fields_json: string }>>`
        SELECT fields_json FROM items
        WHERE project_key = ${h.projectKey} AND ledger = ${GOALS_LEDGER} AND id = ${GOAL_ID}
      `;
      return JSON.parse(rows[0]?.fields_json ?? "{}") as Record<string, unknown>;
    };
    const operationCount = async (): Promise<number> => {
      const rows = await h.admin<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM plan_operations
        WHERE project_key = ${h.projectKey} AND scope LIKE ${"%finalize%"}
      `;
      return Number(rows[0]?.n ?? "0");
    };

    // Walk the injection point forward one statement at a time. Every rollback
    // must leave the tenant EXACTLY as it was; the first attempt that survives
    // to COMMIT ends the walk.
    const MAX_STATEMENTS = 400;
    let committed = 0;
    let rolledBack = 0;
    for (let nth = 1; nth <= MAX_STATEMENTS; nth += 1) {
      injector.armAt(nth);
      let threw = false;
      try {
        const result = await store.finalizePlan(input);
        if (!result.ok) throw new Error(`finalize conflicted: ${result.conflict.code}`);
      } catch (error) {
        threw = true;
        expect((error as Error).message).toBe(INJECTED);
      } finally {
        injector.disarm();
      }
      if (!threw) {
        committed = nth;
        break;
      }
      rolledBack += 1;
      // No torn write at THIS boundary: no decision row, no finalized goal, no
      // replay record that would make a retry look like a duplicate.
      expect(await decisionCount()).toBe(0);
      expect(await goalFields()).not.toHaveProperty(PLAN_FINALIZED_MANIFEST_FIELD);
      expect(await operationCount()).toBe(0);
    }

    // The walk must have exercised real injection points, not fallen straight
    // through — otherwise the assertions above never ran.
    expect(rolledBack).toBeGreaterThan(5);
    expect(committed).toBeGreaterThan(rolledBack);

    // …and the successful attempt landed BOTH effects, in one commit.
    expect(await decisionCount()).toBe(1);
    expect(await goalFields()).toHaveProperty(PLAN_FINALIZED_MANIFEST_FIELD);
    expect(await operationCount()).toBe(1);
  }, 120_000);

  test("the replay record, the decision row and the goal row all carry ONE transaction's xmin", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    await driveToFinalized(store, "R7");

    // `xmin` is the id of the transaction that produced a tuple's current
    // version. Rows sharing an `xmin` were written by the SAME transaction —
    // which is the atomicity claim itself, read straight off the heap rather
    // than inferred from the statement-injection walk (whose blind spot is
    // documented on {@link injectingPool}).
    const xminOf = async (query: Promise<Array<{ xmin: string }>>): Promise<string[]> =>
      (await query).map((row) => row.xmin);

    const operationXmins = await xminOf(h.admin<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin FROM plan_operations
      WHERE project_key = ${h.projectKey} AND scope LIKE ${"%finalize%"}
    `);
    const decisionXmins = await xminOf(h.admin<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin FROM items
      WHERE project_key = ${h.projectKey} AND ledger = ${DECISIONS_LEDGER}
    `);
    const goalXmins = await xminOf(h.admin<Array<{ xmin: string }>>`
      SELECT xmin::text AS xmin FROM items
      WHERE project_key = ${h.projectKey} AND ledger = ${GOALS_LEDGER} AND id = ${GOAL_ID}
    `);

    // The premise: each effect actually landed, so the comparison below is not
    // vacuously true over empty sets.
    expect(operationXmins).toHaveLength(1);
    expect(decisionXmins).toHaveLength(1);
    expect(goalXmins).toHaveLength(1);

    // Persisting the replay record (or the ledger state) on a connection other
    // than the finalize transaction's gives it its OWN xid, and this fails.
    expect(new Set([...operationXmins, ...decisionXmins, ...goalXmins]).size).toBe(1);
  }, 30_000);

  test("no owner fence token is ever persisted — only its verifier", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    await driveToFinalized(store, "R4");

    const claimRows = await h.admin<Array<{ record_json: string }>>`
      SELECT record_json FROM plan_claims WHERE project_key = ${h.projectKey}
    `;
    expect(claimRows.length).toBeGreaterThan(0);
    for (const row of claimRows) {
      expect(row.record_json).not.toContain(OWNER_TOKEN);
      expect(row.record_json).toContain(verifier(OWNER_TOKEN));
    }

    const everyText = await h.admin<Array<{ blob: string }>>`
      SELECT string_agg(fields_json, ' ') AS blob FROM items WHERE project_key = ${h.projectKey}
      UNION ALL
      SELECT string_agg(record_json, ' ') AS blob FROM plan_operations WHERE project_key = ${h.projectKey}
    `;
    for (const row of everyText) {
      expect(row.blob ?? "").not.toContain(OWNER_TOKEN);
    }
  }, 30_000);

  test("a raw task start racing a follow-up claim on independent connections yields ONE authority", async () => {
    // Both operations reach the goal-row lock in a handful of round-trips, so
    // whoever is dispatched first wins essentially every time. Staggering the
    // launch is what makes BOTH orders reachable — without it only one branch
    // below would ever execute, and the other would be a dead assertion.
    const outcomes: string[] = [];
    for (const headStart of ["starter", "replacer"] as const) {
      const h = await newHarness();
      try {
        const setup = await h.open();
        await seedGoal(setup, GOAL_ID);
        const { taskIds } = await driveToFinalized(setup, "R5");
        const [first] = taskIds;
        if (first === undefined) throw new Error("manifest is short");

        // Two INDEPENDENT connections, contending for the same goal. Neither
        // has committed when the other is dispatched — the loser blocks on the
        // goal row rather than reading around it.
        const starter = await h.open();
        const replacer = await h.open();
        const startTask = (): Promise<"started" | "rejected"> =>
          starter
            .updateItem(TASKS_LEDGER, first, { status: "wip", ...PROVENANCE })
            .then(
              () => "started" as const,
              () => "rejected" as const,
            );
        const followUp = (): ReturnType<LifecycleStore["claimPlan"]> =>
          replacer.claimPlan({
            goalId: GOAL_ID,
            purpose: "follow-up",
            claimRequestId: `race-${headStart}`,
            ownerFenceToken: OWNER_TOKEN,
            expectedGeneration: 1,
            ...PROVENANCE,
          });

        const [startOutcome, claimOutcome] =
          headStart === "starter"
            ? await Promise.all([startTask(), delayed(followUp)])
            : await Promise.all([delayed(startTask), followUp()]);

        const observer = await h.open();
        const task = observer.fetchItem(TASKS_LEDGER, first);
        const goal = observer.fetchItem(GOALS_LEDGER, GOAL_ID);
        const generation = Number(goal.fields[PLAN_GENERATION_FIELD]);

        if (claimOutcome.ok) {
          // The replacement won: it must have observed a startable task and
          // abandoned it, and the raw start must have lost.
          outcomes.push("replacer-won");
          expect(startOutcome).toBe("rejected");
          expect(task.status).toBe("abandoned");
          expect(generation).toBe(2);
        } else {
          // The raw start won: the claim must have been refused BECAUSE
          // implementation is active, and the generation must not have moved.
          outcomes.push("starter-won");
          expect(startOutcome).toBe("started");
          expect(claimOutcome.conflict.code).toBe("implementation-active");
          expect(task.status).toBe("wip");
          expect(generation).toBe(1);
        }
      } finally {
        const current = harness;
        harness = null;
        if (current !== null) await current.dispose();
      }
    }
    // Neither branch above is dead: the fence produced ONE authority under BOTH
    // serialization orders, not just the one the scheduler happens to favour.
    expect([...outcomes].sort()).toEqual(["replacer-won", "starter-won"]);
  }, 120_000);

  test("plan-fence side state survives a tenant clone, so a restarted peer replays exactly", async () => {
    const h = await newHarness();
    const store = await h.open();
    await seedGoal(store, GOAL_ID);
    const acknowledgement = await claim(store, "clone-replay");

    const cloneKey = `${h.projectKey}-clone`;
    await cloneTenant(h.admin, h.projectKey, cloneKey);
    h.track(cloneKey);
    const peer = await openTenantStore(h.dsn, cloneKey);
    h.stores.push(peer as LifecycleStore);

    const replay = await (peer as LifecycleStore).claimPlan({
      goalId: GOAL_ID,
      purpose: "initial",
      claimRequestId: "clone-replay",
      ownerFenceToken: OWNER_TOKEN,
      expectedGeneration: null,
      ...PROVENANCE,
    });
    expect(replay).toEqual({ ok: true, replayed: true, acknowledgement });
  }, 30_000);
});
